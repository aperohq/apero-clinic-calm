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
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import uuid

SCHEMAS = ('public', 'auth', 'storage', 'supabase_migrations', 'extensions')


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
    lines = [x.strip() for x in recipients.read_text().splitlines() if x.strip() and not x.startswith('#')]
    if not lines or any(not x.startswith('age1') for x in lines):
        raise ValueError('age_public_recipients_required')
    # Refuse silently dropping new persistent schemas or encryption/external jobs.
    query = """select json_build_object(
      'schemas', (select coalesce(json_agg(distinct n.nspname), '[]') from pg_class c
        join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p')
        and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'),
      'vault_count', (select count(*) from vault.secrets),
      'extensions', (select json_agg(extname) from pg_extension),
      'server_version', current_setting('server_version'))"""
    preflight = subprocess.run(['psql', '--no-password', '-X', '-A', '-t',
        '-v', 'ON_ERROR_STOP=1', '-c', query], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if preflight.returncode:
        raise ValueError('catalog_preflight_failed')
    catalog = json.loads(preflight.stdout)
    allowed = set(SCHEMAS) | {'realtime', 'vault'}
    if set(catalog['schemas']) - allowed or catalog['vault_count'] or set(catalog['extensions']) & {'pg_cron','pg_net','wrappers','pgsodium'}:
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
        files = {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in (archive, roles)}
        manifest = {'format_version': 1, 'started_at': started.isoformat(),
                    'completed_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                    'schemas': SCHEMAS, 'files': files, 'catalog': catalog,
                    'snapshot_catalog': snapshot_catalog, 'dump_format': 'pg_dump custom', 'encryption': 'age',
                    'archive_validated': False, 'restore_tested': False,
                    'scope': 'database + password-free role definitions; no object bytes or platform secrets'}
        with (pending / 'manifest.json').open('x') as file:
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
    manifest = json.loads((bundle / 'manifest.json').read_text())
    expected = {'database.dump.age', 'roles.sql.age'}
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
