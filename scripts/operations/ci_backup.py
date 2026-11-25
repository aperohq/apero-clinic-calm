#!/usr/bin/env python3
"""GitHub job entrypoint. No recovery private key, plaintext dump or GH artifacts.
Secrets/temp identities are in tmpfs and removed on failure/success.
"""
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import urlsplit
import database_backup as db
import s3_backup as storage
from recovery_catalog import STRUCTURE_SQL

UTC=dt.timezone.utc
STAGE="configuration"


def log(category,state,**fields):
    print(json.dumps({'timestamp':dt.datetime.now(UTC).isoformat(),'category':category,
        'component':'production_backup','state':state,**fields}),flush=True)


def setup(stage):
    recipients=stage/'recipients'
    recipients.write_text(os.environ['AGE_RECIPIENTS'].strip()+'\n', encoding="utf-8")
    identity=stage/'ephemeral-age-key'
    result=subprocess.run(['age-keygen','-o',str(identity)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if result.returncode: raise ValueError('ephemeral_key_failed')
    identity.chmod(0o600)
    result=subprocess.run(['age-keygen','-y',str(identity)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    if result.returncode: raise ValueError('ephemeral_recipient_failed')
    with recipients.open('a', encoding="utf-8") as file: file.write(result.stdout.decode().strip()+'\n')
    cert=stage/'db-ca.crt'; cert.write_text(os.environ['BACKUP_DB_CA_CERT'], encoding="utf-8")
    password=os.environ.pop('BACKUP_DB_PASSWORD')
    if '\n' in password or '\r' in password: raise ValueError('invalid_pgpass_password')
    def escape(s):return s.replace('\\','\\\\').replace(':','\\:')
    values=[os.environ['PGHOST'],os.environ.get('PGPORT','5432'),os.environ['PGDATABASE'],os.environ['PGUSER'],password]
    pgpass=stage/'pgpass'; pgpass.write_text(':'.join(map(escape,values))+'\n', encoding="utf-8");pgpass.chmod(0o600)
    os.environ.update({'PGPASSFILE':str(pgpass),'PGSSLROOTCERT':str(cert),'PGSSLMODE':'verify-full',
        'PGCONNECT_TIMEOUT':'20','PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=1800000',
        'BACKUP_DESTINATION_APPROVED':'yes'})
    return recipients,identity


def reviewed_database_runtime(raw):
    """Validate only the existing v1 integration recovery envelope, never log it."""
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('invalid_integration_recovery_json')
            result[key] = value
        return result
    try:
        if not isinstance(raw, str) or not 0 < len(raw.encode()) <= 32768:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=unique)
        if not isinstance(value, dict) or set(value) != {
            'format_version', 'supabase_settings', 'vault_settings', 'worker_schedule',
            'restore_requires_disabled_flags_until_acceptance',
        } or type(value['format_version']) is not int or value['format_version'] != 1 \
                or value['restore_requires_disabled_flags_until_acceptance'] is not True:
            raise ValueError()
        settings, vault, schedule = (value[key] for key in ('supabase_settings', 'vault_settings', 'worker_schedule'))
        if not isinstance(settings, dict) or set(settings) != {
            'INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_WORKER_SECRET', 'GOOGLE_CLIENT_ID',
            'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_WEBHOOK_URI', 'INTEGRATIONS_ENABLED',
        } or not isinstance(vault, dict) or set(vault) != {
            'apero_integration_worker_secret', 'apero_integration_worker_url',
        } or not isinstance(schedule, dict) or set(schedule) != {'connection_id', 'calendar_id', 'schedule'}:
            raise ValueError()
        if any(not isinstance(item, str) or not item.strip() or len(item) > 4096
               or any(ord(char) < 32 for char in item) for item in [*settings.values(), *vault.values(), *schedule.values()]):
            raise ValueError()
        if settings['INTEGRATIONS_ENABLED'] not in ('true', 'false') \
                or not all(re.fullmatch('[a-f0-9]{64}', settings[key]) for key in ('INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_WORKER_SECRET')) \
                or vault['apero_integration_worker_secret'] != settings['INTEGRATION_WORKER_SECRET']:
            raise ValueError()
        worker = urlsplit(vault['apero_integration_worker_url'])
        if worker.scheme != 'https' or not worker.hostname or not worker.hostname.endswith('.supabase.co') \
                or worker.username or worker.password or worker.query or worker.fragment \
                or worker.path != '/functions/v1/integration-worker':
            raise ValueError()
        for name in ('GOOGLE_REDIRECT_URI', 'GOOGLE_WEBHOOK_URI'):
            uri = urlsplit(settings[name])
            if uri.scheme != 'https' or uri.netloc != worker.netloc or uri.username or uri.password or uri.fragment:
                raise ValueError()
        uuid.UUID(schedule['connection_id'])
        if schedule['schedule'] != '* * * * *' \
                or not re.fullmatch('[a-z0-9]+@group\\.calendar\\.google\\.com', schedule['calendar_id']):
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ValueError('invalid_integration_recovery_json') from None


@contextlib.contextmanager
def database_runtime_input(stage, recipients, raw):
    """Materialize ciphertext in the private stage for the existing backup verifier."""
    if not raw:
        yield  # Existing database preflight refuses missing input when runtime scope needs it.
        return
    value = reviewed_database_runtime(raw)
    db.private(stage, directory=True)
    db.private(recipients)
    output = stage / 'integration-settings.json.age'
    created = False
    previous = os.environ.get('INTEGRATION_RECOVERY_CONFIG')
    try:
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, 'wb') as target:
            result = subprocess.run(['age', '-R', str(recipients)], input=json.dumps(value).encode(),
                stdout=target, stderr=subprocess.DEVNULL,
                env={key: item for key, item in os.environ.items() if key != 'BACKUP_INTEGRATION_RECOVERY_JSON'})
        if result.returncode:
            raise ValueError('integration_recovery_encryption_failed')
        db.integration_recovery_config(output)
        os.environ['INTEGRATION_RECOVERY_CONFIG'] = str(output)
        yield
    finally:
        if previous is None:
            os.environ.pop('INTEGRATION_RECOVERY_CONFIG', None)
        else:
            os.environ['INTEGRATION_RECOVERY_CONFIG'] = previous
        if created:
            output.unlink(missing_ok=True)


def integration_snapshot(connection):
    # Explicit non-patient routing fields; phones and patient/call tables excluded.
    columns='clinic_id,workspace_id,agent_id,conversation_flow_id,knowledge_base_id,secret_env_name,active,phone_number,dialing_prefix,local_number_length,slot_minutes,transfer_number'
    rows=connection.execute('select '+columns+' from public.voice_integrations where active order by clinic_id').fetchall()
    names=columns.split(',')
    return [dict(zip(names,map(lambda x:str(x) if isinstance(x,uuid.UUID) else x,row))) for row in rows]


def snapshot_catalog(connection):
    from psycopg import sql
    tables=connection.execute("select n.nspname,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=any(%s) and c.relkind in ('r','p') order by 1,2",(list(db.SCHEMAS),)).fetchall()
    inventory=[]
    for schema,table,rls in tables:
        count=connection.execute(sql.SQL('select count(*) from {}.{}').format(sql.Identifier(schema),sql.Identifier(table))).fetchone()[0]
        inventory.append({'schema':schema,'table':table,'rows':count,'rls':rls})
    counts=connection.execute("""select
      (select count(*) from pg_policies where schemaname=any(%s)),
      (select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname=any(%s)),
      (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=any(%s) and not t.tgisinternal),
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=any(%s))""",(list(db.SCHEMAS),)*4).fetchone()
    return {'tables':inventory,'policies':counts[0],'constraints':counts[1],'triggers':counts[2],'functions':counts[3], 'structure':connection.execute(STRUCTURE_SQL).fetchone()[0]}


def run(mode):
    global STAGE
    import psycopg
    os.umask(0o077)
    runtime_json = os.environ.pop('BACKUP_INTEGRATION_RECOVERY_JSON', '') if mode == 'database' else ''
    # A dedicated ephemeral tmpfs directory; encrypted dump stage is runner temp.
    with tempfile.TemporaryDirectory(prefix='apero-backup-',dir='/dev/shm') as secrets_dir, tempfile.TemporaryDirectory(prefix='apero-backup-',dir=os.environ.get('RUNNER_TEMP')) as out:
        stage=Path(secrets_dir);output=Path(out);output.chmod(0o700)
        recipients,identity=setup(stage)
        s3=storage.client();bucket=os.environ['BACKUP_S3_BUCKET'];STAGE='bucket_controls';storage.check_bucket(s3,bucket)
        started=dt.datetime.now(UTC)
        run_id=started.strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex
        with psycopg.connect('') as connection:
            connection.execute('set transaction isolation level repeatable read read only')
            if mode=='database':
                snapshot=connection.execute('select pg_export_snapshot()').fetchone()[0]
                catalog=snapshot_catalog(connection)
                STAGE='database_export'
                with database_runtime_input(stage,recipients,runtime_json):
                    bundle=db.backup(output,recipients,snapshot,catalog)
                STAGE='archive_integrity'
                db.verify(bundle,identity)
                manifest=json.loads((bundle/'manifest.json').read_text(encoding="utf-8"));manifest['archive_validated']=True
                manifest['source_commit']=os.environ.get('GITHUB_SHA');manifest['ci_private_key_persisted']=False
                encrypted_manifest=output/'manifest.json.age'
                storage.encrypt_json(manifest,encrypted_manifest,recipients)
                files=[bundle/name for name in sorted(db.expected_backup_files(manifest))]+[encrypted_manifest]
            else:
                mappings=integration_snapshot(connection)
                if not mappings: raise ValueError('no_active_agents')
                from retell_config_backup import capture
                STAGE='retell_configuration'
                config=capture(sorted({row['agent_id'] for row in mappings}))
                config['integration_mappings']=mappings;config['source_commit']=os.environ.get('GITHUB_SHA')
                artifact=output/'retell.json.age'
                storage.encrypt_json(config,artifact,recipients)
                if subprocess.run(['age','-d','-i',str(identity),str(artifact)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
                    raise ValueError('config_decryption_failed')
                files=[artifact]
        STAGE='upload_readback'
        receipt=storage.upload_set(s3,bucket,mode,files,recipients,output,started,run_id,started.isoformat())
        log('remote_backup_completed','success',scope=mode,run_id=run_id,source_time=started.isoformat(),
            retention_classes=receipt['retention_classes'],checksum_readback_verified=True)
        summary=os.environ.get('GITHUB_STEP_SUMMARY')
        if summary:
            with open(summary,'a', encoding="utf-8") as file:
                file.write(f'Backup verified: {mode}; UTC {started.isoformat()}; set `{run_id}`; classes {", ".join(receipt["retention_classes"])}. Encrypted S3 upload/read-back passed. No GitHub artifact.\n')
    # No files/ephemeral private key/pgpass survive either TemporaryDirectory.


def main():
    global STAGE
    parser=argparse.ArgumentParser();parser.add_argument('--mode',choices=['database','retell','freshness'],required=True)
    args=parser.parse_args()
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(1))
    try:
        if args.mode=='freshness':
            STAGE='freshness'
            storage.check_bucket(storage.client(),os.environ['BACKUP_S3_BUCKET'])
            source_time=storage.freshness(storage.client(),os.environ['BACKUP_S3_BUCKET'])
            log('backup_freshness','success',source_time=source_time,threshold_minutes=75)
        else:run(args.mode)
        return 0
    except Exception:
        category={'archive_integrity':'backup_integrity_failed','upload_readback':'backup_upload_verification_failed','freshness':'backup_stale_or_missing'}.get(STAGE,'backup_failed')
        log(category,'failure',scope=args.mode,stage=STAGE)
        return 1


if __name__=='__main__':sys.exit(main())
