"""Genuine synthetic pg_dump/age/pg_restore; requires the disposable native harness.
Never accepts a backup path, credentials, DATABASE_URL, TCP host or production DB.
"""
import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
from restore_drill import restore_archive_sections
from recovery_catalog import STRUCTURE_SQL, structures_match


def main():
    root = Path(os.environ['APERO_NATIVE_ROOT']).resolve()
    if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('apero-native-'):
        raise ValueError('disposable_root_required')
    marker = json.loads((root / '.apero-disposable.json').read_text(encoding='utf-8'))
    if marker['database'] != 'apero_native_validation' or str(marker['port']) != os.environ['APERO_NATIVE_PORT']:
        raise ValueError('disposable_marker_mismatch')
    binary = Path(os.environ['APERO_TEST_PG_BIN'])
    connection = ['-h', str(root / 'socket'), '-p', str(marker['port']), '-U', 'apero_test']
    source = marker['database']
    clean_env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
    def run(args, **kwargs):
        return subprocess.run(args, check=True, env=clean_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs).stdout
    def psql(database, statement):
        return run([str(binary / 'psql'), *connection, '-d', database, '-XAt', '-v', 'ON_ERROR_STOP=1'], input=statement.encode('utf-8')).decode().strip()
    actual = json.loads(psql(source, "select json_build_object('database',current_database(),'directory',current_setting('data_directory'),'address',inet_server_addr())"))
    if actual != {'database': source, 'directory': str(root / 'data'), 'address': None}:
        raise ValueError('native_identity_mismatch')
    work = root / 'synthetic-backup'
    work.mkdir(mode=0o700)
    identity = work / 'identity.txt'
    run(['age-keygen', '-o', str(identity)])
    recipient = run(['age-keygen', '-y', str(identity)]).decode().strip()
    psql(source, "create schema if not exists extensions; create table native_restore_slots(kind uuid, period tstzrange, exclude using gist(kind with =,period with &&)); insert into native_restore_slots values('00000000-0000-4000-8000-000000009999',tstzrange('2040-01-01 09:00Z','2040-01-01 10:00Z','[)'));")
    # Incompressible payload exceeds pipe capacity: pg_restore --list must not
    # truncate age authentication after reading just the archive catalog.
    psql(source, "create table native_backup_payload as select g as id,string_agg(md5((g*10000+j)::text),'') payload from generate_series(1,32) g cross join generate_series(1,512) j group by g;")
    results = []
    for schema in ('public', 'extensions'):
        if schema == 'extensions':
            psql(source, 'alter extension btree_gist set schema extensions;')
        expected = json.loads(psql(source, STRUCTURE_SQL))
        archive = work / (schema + '.dump.age')
        dump = subprocess.Popen([str(binary / 'pg_dump'), *connection, '-d', source, '--format=custom', '--schema=public', '--schema=auth', '--schema=extensions'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=clean_env)
        try:
            run(['age', '-r', recipient, '-o', str(archive)], stdin=dump.stdout)
            dump.stdout.close()
            if dump.wait() != 0:
                raise ValueError('synthetic_dump_failed')
        finally:
            if dump.poll() is None:
                dump.kill()
            dump.wait()
        if schema == 'public':
            from database_backup import verify, digest
            check = work / 'verification'
            check.mkdir(mode=0o700)
            identity.chmod(0o600)
            shutil.copyfile(archive, check / 'database.dump.age')
            roles = run([str(binary / 'pg_dumpall'), *connection, '--roles-only', '--no-role-passwords'])
            run(['age','-r',recipient,'-o',str(check / 'roles.sql.age')],input=roles)
            run(['age','-r',recipient,'-o',str(check / 'integration-settings.json.age')],input=b'{"INTEGRATION_WORKER_SECRET":"synthetic-fixture"}')
            files = {file.name:{'bytes':file.stat().st_size,'sha256':digest(file)} for file in check.iterdir()}
            (check / 'manifest.json').write_text(json.dumps({'files':files,'catalog':{'integration_runtime_recovery':True}}),encoding='utf-8')
            previous_path = os.environ.get('PATH','')
            try:
                os.environ['PATH'] = str(binary) + os.pathsep + previous_path
                verify(check,identity)
            finally:
                os.environ['PATH'] = previous_path
        restored = 'apero_restore_' + schema
        run([str(binary / 'createdb'), *connection, restored])
        target = [str(binary / 'psql'), *connection, '-d', restored, '-XAt', '-v', 'ON_ERROR_STOP=1']
        # pg_dump's pre-data creates namespaces. A clean target must not already
        # contain public; this is the same prerequisite as the production drill.
        psql(restored, 'drop schema public cascade;')
        restore = [str(binary / 'pg_restore'), *connection, '-d', restored, '--exit-on-error', '--single-transaction']
        restore_archive_sections(identity, archive, target, restore, {'extensions': ['btree_gist'], 'extension_schemas': {'btree_gist': schema}})
        if not structures_match(expected, json.loads(psql(restored, STRUCTURE_SQL))):
            raise ValueError('restored_catalog_or_acl_mismatch')
        assert psql(restored, "select count(*) from clients where full_name='عيادة اختبار'") == '2'
        assert psql(restored, "begin; set local role authenticated; set local request.jwt.claims='{\"role\":\"authenticated\",\"sub\":\"00000000-0000-4000-8000-000000000011\"}'; select count(*) from clients; rollback;").splitlines()[-2] == '1'
        assert psql(restored, "begin; set local role authenticated; select count(*) from clients; rollback;").splitlines()[-2] == '0'
        overlap = subprocess.run([*target, '-c', "insert into native_restore_slots values('00000000-0000-4000-8000-000000009999',tstzrange('2040-01-01 09:30Z','2040-01-01 10:30Z','[)'))"], env=clean_env, capture_output=True)
        assert overlap.returncode != 0 and b'exclusion constraint' in overlap.stderr
        assert psql(restored, "select count(*) from pg_constraint where conname='appointments_shared_no_overlap'") == '1'
        run([str(binary / 'dropdb'), *connection, restored])
        results.append({'extension_schema': schema, 'pg_dump_age_pg_restore': True, 'structure_and_acl_match': True, 'arabic_rows': 2, 'tenant_rls': True, 'gist_exclusion_enforced': True})
    print(json.dumps({'native_synthetic_restore': results, 'production_backup_used': False, 'plaintext_dump_written': False}))


if __name__ == '__main__':
    main()
