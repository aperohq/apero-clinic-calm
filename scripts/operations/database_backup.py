#!/usr/bin/env python3
"""Encrypted PostgreSQL logical backup. Never restores or uploads anything.
Connection is libpq environment/0600 PGPASSFILE, never a command argument.
An approved private destination and age recipient file are mandatory.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import uuid

SCHEMAS = ('public', 'auth', 'storage', 'supabase_migrations', 'extensions')

def retention_cron_is_safe(jobs):
    return jobs == [{'name':'apero-retention-daily','schedule':'23 2 * * *',
        'command':'select public.retention_daily()','active':True}]


def integration_cron_is_safe(jobs):
    retention = [job for job in jobs if job.get('name') == 'apero-retention-daily']
    workers = [job for job in jobs if job.get('name') == 'apero-integrations-worker']
    if not retention_cron_is_safe(retention) or len(jobs) != len(retention) + len(workers) or len(workers) != 1:
        return False
    job = workers[0]
    command = r"select public\.integration_scheduled_sync\('[a-f0-9-]{36}','[a-z0-9]+@group\.calendar\.google\.com'\)"
    return job.get('schedule') == '* * * * *' and type(job.get('active')) is bool and bool(re.fullmatch(command, job.get('command', '').strip()))


def integration_recovery_config(path):
    config = Path(path)
    private(config)
    if not config.is_file() or not config.read_bytes().startswith(b'age-encryption.org/v1\n'):
        raise ValueError('encrypted_integration_recovery_config_required')
    return config


def event(state):
    print(json.dumps({'timestamp': dt.datetime.now(dt.timezone.utc).isoformat(),
                      'category': 'backup_completed' if state == 'success' else 'backup_failed',
                      'component': 'database_backup', 'state': state}), flush=True)


def private(path, directory=False):
    mode = path.stat().st_mode
    if path.is_symlink() or (mode & 0o077) or (directory and not path.is_dir()):
        raise ValueError('private_path_required')


def pipeline(commands, output):
    """Discard tool errors: Postgres errors can contain SQL/patient values."""
    processes = []
    try:
        with output.open('xb') as target:
            previous = None
            for i, command in enumerate(commands):
                process = subprocess.Popen(command, stdin=previous,
                    stdout=target if i == len(commands)-1 else subprocess.PIPE,
                    stderr=subprocess.DEVNULL)
                if previous is not None:
                    previous.close()
                previous = process.stdout
                processes.append(process)
            codes = [process.wait() for process in processes]
            if any(codes) or output.stat().st_size == 0:
                raise ValueError('pipeline_failed')
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.wait()


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024*1024), b''):
            result.update(chunk)
    return result.hexdigest()


def backup(destination, recipients, snapshot=None, snapshot_catalog=None):
    for tool in ('pg_dump', 'pg_dumpall', 'pg_restore', 'psql', 'age'):
        if shutil.which(tool) is None:
            raise ValueError('missing_tool')
    if os.environ.get('BACKUP_DESTINATION_APPROVED') != 'yes':
        raise ValueError('destination_not_approved')
    if not os.environ.get('PGHOST') or not os.environ.get('PGDATABASE') or not os.environ.get('PGUSER'):
        raise ValueError('missing_libpq_connection')
    if os.environ.get('PGSSLMODE') not in ('verify-full',):
        raise ValueError('verified_tls_required')
    password_file = Path(os.environ.get('PGPASSFILE', ''))
    if not password_file.is_file():
        raise ValueError('private_pgpass_required')
    private(password_file)
    if 'PGPASSWORD' in os.environ or 'PGSERVICE' in os.environ:
        raise ValueError('use_explicit_libpq_and_pgpass')
    destination = destination.resolve()
    private(destination, directory=True)
    repo = Path(__file__).resolve().parents[2]
    if destination == repo or repo in destination.parents:
        raise ValueError('destination_inside_repository')
    if not recipients.is_file():
        raise ValueError('recipient_file_required')
    # Recipient list contains public keys only. Reject passphrase/key prompts.
    lines = [x.strip() for x in recipients.read_text(encoding="utf-8").splitlines() if x.strip() and not x.startswith('#')]
    if not lines or any(not x.startswith('age1') for x in lines):
        raise ValueError('age_public_recipients_required')
    # Refuse silently dropping new persistent schemas or encryption/external jobs.
    query = """select json_build_object(
      'schemas', (select coalesce(json_agg(distinct n.nspname), '[]') from pg_class c
        join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p')
        and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'),
      'vault_count', (select count(*) from vault.secrets),
      'net_tables_reviewed', not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='net' and c.relkind in ('r','p') and (c.relpersistence<>'u' or c.relname not in ('http_request_queue','_http_response'))),
      'vault_names', (select coalesce(json_agg(name order by name),'[]') from vault.secrets),
      'integration_vault_valid', (select count(*)=2 and bool_and(case name when 'apero_integration_worker_url' then decrypted_secret ~ '^https://[a-z]{20}\\.supabase\\.co/functions/v1/integration-worker$' when 'apero_integration_worker_secret' then decrypted_secret ~ '^[a-f0-9]{64}$' else false end) from vault.decrypted_secrets),
      'extensions', (select json_agg(extname) from pg_extension),
      'extension_schemas', (select json_object_agg(e.extname,n.nspname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace),
      'server_version', current_setting('server_version'))"""
    preflight = subprocess.run(['psql', '--no-password', '-X', '-A', '-t',
        '-v', 'ON_ERROR_STOP=1', '-c', query], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if preflight.returncode:
        raise ValueError('catalog_preflight_failed')
    catalog = json.loads(preflight.stdout)
    allowed = set(SCHEMAS) | {'realtime', 'vault'}
    recovery_config = None
    integration_jobs = False
    if 'pg_cron' in catalog['extensions']:
        # Retention adds one fixed SQL-only job. Never allow arbitrary cron
        # commands, HTTP jobs or credentials to silently escape recovery scope.
        cron_query = "select coalesce(json_agg(json_build_object('name',jobname,'schedule',schedule,'command',command,'active',active)), '[]') from cron.job"
        cron = subprocess.run(['psql','--no-password','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',cron_query],
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        if cron.returncode:
            raise ValueError('cron_scope_review_required')
        jobs = json.loads(cron.stdout)
        integration_jobs = integration_cron_is_safe(jobs)
        if not retention_cron_is_safe(jobs) and not integration_jobs:
            raise ValueError('cron_scope_review_required')
        if integration_jobs:
            catalog['integration_cron_recovery'] = jobs
        allowed.add('cron')
        catalog['retention_cron_recovery'] = 'operations/retention/schedule.sql'
    if integration_jobs:
        if not catalog.get('net_tables_reviewed') or not catalog.get('integration_vault_valid') or catalog.get('vault_names') != ['apero_integration_worker_secret','apero_integration_worker_url'] or 'pg_net' not in catalog['extensions']:
            raise ValueError('integration_runtime_scope_review_required')
        recovery_config = integration_recovery_config(os.environ.get('INTEGRATION_RECOVERY_CONFIG', ''))
        allowed.add('net')
        catalog['integration_runtime_recovery'] = 'Restore encrypted integration-settings.json.age into the secret manager/Vault, install pg_net and re-create only the recorded scoped cron after successful fresh synchronization. net HTTP queues are transient and excluded.'
    if set(catalog['schemas']) - allowed or (catalog['vault_count'] and not integration_jobs) or set(catalog['extensions']) & ({'wrappers','pgsodium'} | (set() if integration_jobs else {'pg_net'})):
        raise ValueError('scope_review_required')
    started = dt.datetime.now(dt.timezone.utc)
    name = started.strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex
    pending = destination / ('.pending-' + name)
    pending.mkdir(mode=0o700)  # exclusive reservation; no silent overwrite
    try:
        archive = pending / 'database.dump.age'
        dump = ['pg_dump', '--format=custom', '--compress=6', '--no-password', '--lock-wait-timeout=60s']
        if snapshot:
            dump += ['--snapshot', snapshot]
        for schema in SCHEMAS:
            dump += ['--schema', schema]
        # Vault values / decrypted view excluded by positive schema allowlist.
        # Auth hashes/tokens are deliberately preserved, encrypted account state.
        pipeline([dump, ['age', '-R', str(recipients)]], archive)
        roles = pending / 'roles.sql.age'
        pipeline([['pg_dumpall', '--roles-only', '--no-role-passwords', '--no-password'],
                  ['age', '-R', str(recipients)]], roles)
        if recovery_config:
            shutil.copyfile(recovery_config, pending / 'integration-settings.json.age')
            (pending / 'integration-settings.json.age').chmod(0o600)
        files = {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in (archive, roles)}
        manifest = {'format_version': 1, 'started_at': started.isoformat(),
                    'completed_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                    'schemas': SCHEMAS, 'files': files, 'catalog': catalog,
                    'snapshot_catalog': snapshot_catalog, 'dump_format': 'pg_dump custom', 'encryption': 'age',
                    'archive_validated': False, 'restore_tested': False,
                    'scope': 'database + password-free roles; optional separately age-encrypted integration recovery settings; no object bytes or plaintext platform secrets'}
        with (pending / 'manifest.json').open('x', encoding="utf-8") as file:
            json.dump(manifest, file, indent=2)
        for path in pending.iterdir():
            with path.open('rb') as file:
                os.fsync(file.fileno())
        final = destination / name
        if final.exists():
            raise ValueError('collision')
        pending.rename(final)
        # Separate validation + upload receipt are required before offsite success.
        event('success')
        return final
    except BaseException:
        shutil.rmtree(pending)  # only this invocation's generated ciphertext
        raise


def verify(bundle, identity):
    private(bundle, directory=True)
    private(identity)
    if not identity.is_file():
        raise ValueError('identity_required')
    manifest = json.loads((bundle / 'manifest.json').read_text(encoding="utf-8"))
    expected = {'database.dump.age', 'roles.sql.age'}
    if manifest.get('catalog', {}).get('integration_runtime_recovery'):
        expected.add('integration-settings.json.age')
    if set(manifest['files']) != expected:
        raise ValueError('invalid_manifest')
    for name, info in manifest['files'].items():
        path = bundle / name
        if path.is_symlink() or path.stat().st_size != info['bytes'] or digest(path) != info['sha256']:
            raise ValueError('integrity_failure')
    # Decrypted data goes only through pipes into pg_restore, never a disk file.
    for command in (['pg_restore', '--list'], ['pg_restore', '--file=/dev/null']):
        decrypt = subprocess.Popen(['age', '-d', '-i', str(identity), str(bundle / 'database.dump.age')],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            result = subprocess.run(command, stdin=decrypt.stdout, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL)
            decrypt.stdout.close()
            if result.returncode or decrypt.wait():
                raise ValueError('archive_validation_failed')
        finally:
            if decrypt.poll() is None:
                decrypt.kill()
            decrypt.wait()
    if 'integration-settings.json.age' in expected:
        result = subprocess.run(['age', '-d', '-i', str(identity), str(bundle / 'integration-settings.json.age')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise ValueError('integration_config_decryption_failed')
    result = subprocess.run(['age', '-d', '-i', str(identity), str(bundle / 'roles.sql.age')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise ValueError('roles_decryption_failed')
    print(json.dumps({'category': 'backup_integrity_verified', 'state': 'success',
                      'restore_tested': False}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    create = sub.add_parser('create')
    create.add_argument('--destination', type=Path, required=True)
    create.add_argument('--recipients', type=Path, required=True)
    check = sub.add_parser('verify')
    check.add_argument('--bundle', type=Path, required=True)
    check.add_argument('--identity', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == 'create':
            backup(args.destination, args.recipients)
        else:
            verify(args.bundle, args.identity)
    except Exception:
        event('failure')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
