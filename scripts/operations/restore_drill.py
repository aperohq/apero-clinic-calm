#!/usr/bin/env python3
"""Restore REAL ciphertext only into a disposable, networkless PostgreSQL container.
No host DB connection is used. Private recovery identity remains custodian-owned.
Data lives in container tmpfs; container is forcibly removed in finally.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid
from database_backup import private,digest,expected_backup_files
from recovery_catalog import STRUCTURE_SQL, structures_match


def execute(command,input=None):
    result=subprocess.run(command,input=input,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    if result.returncode:raise ValueError('drill_command_failed')
    return result.stdout


def stream(identity,path,command):
    decrypt=subprocess.Popen(['age','-d','-i',str(identity),str(path)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        restored=subprocess.run(command,stdin=decrypt.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        # A section restore may stop before the encrypted archive's end.
        for _ in iter(lambda: decrypt.stdout.read(1024 * 1024), b''):
            pass
        decrypt.stdout.close()
        if restored.returncode or decrypt.wait():raise ValueError('drill_restore_failed')
    finally:
        if decrypt.poll() is None:decrypt.kill()
        decrypt.wait()


def quote(identifier):
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',identifier):raise ValueError('invalid_identifier')
    return '"'+identifier+'"'


def prepare_extensions(psql, catalog):
    names = catalog.get('extensions', [])
    locations = catalog.get('extension_schemas', {})
    if 'btree_gist' in names:
        # Older Apero archives used the canonical public schema. New manifests
        # record the real location, supporting Supabase's extensions namespace.
        schema = locations.get('btree_gist', 'public')
        if schema not in ('public', 'extensions'):
            raise ValueError('unsupported_extension_schema')
        execute(psql, input=(f'create schema if not exists {quote(schema)}; '
            f'create extension if not exists btree_gist with schema {quote(schema)};').encode('utf-8'))


def restore_archive_sections(identity, archive, psql, restore, catalog):
    """Shared by the isolated Docker drill and native synthetic acceptance."""
    stream(identity, archive, restore + ['--section=pre-data'])
    prepare_extensions(psql, catalog)
    stream(identity, archive, restore + ['--section=data', '--section=post-data'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--identity',type=Path,required=True)
    parser.add_argument('--image',default='postgres:17-bookworm')
    parser.add_argument('--confirm-isolated-host',action='store_true',required=True)
    args=parser.parse_args();os.umask(0o077)
    container='apero-drill-'+uuid.uuid4().hex
    started=time.monotonic();created=False;success=False
    try:
        private(args.bundle,directory=True);private(args.identity)
        manifest=json.loads(execute(['age','-d','-i',str(args.identity),str(args.bundle/'manifest.json.age')]))
        expected_files=expected_backup_files(manifest)
        for name,info in manifest['files'].items():
            path=args.bundle/name
            if path.is_symlink() or digest(path)!=info['sha256'] or path.stat().st_size!=info['bytes']:
                raise ValueError('drill_checksum_failure')
        if not manifest.get('snapshot_catalog'):
            raise ValueError('snapshot_catalog_required')
        if 'integration-settings.json.age' in expected_files:
            valid=subprocess.run(['age','-d','-i',str(args.identity),str(args.bundle/'integration-settings.json.age')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if valid.returncode:raise ValueError('integration_config_decryption_failed')
        # Image download happens BEFORE any patient data is present.
        execute(['docker','pull',args.image])
        os.environ['POSTGRES_PASSWORD']=uuid.uuid4().hex
        execute(['docker','run','--detach','--name',container,'--network','none',
            '--read-only','--tmpfs','/tmp:rw,nosuid,nodev,noexec',
            '--tmpfs','/var/run/postgresql:rw,nosuid,nodev',
            '--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=2147483648',
            '--env','POSTGRES_USER=drill_admin','--env','POSTGRES_DB=drill_restore',
            '--env','POSTGRES_PASSWORD',args.image]);created=True
        os.environ.pop('POSTGRES_PASSWORD',None)
        for _ in range(60):
            ready=subprocess.run(['docker','exec',container,'pg_isready','-U','drill_admin','-d','drill_restore'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if ready.returncode==0:break
            time.sleep(1)
        else:raise ValueError('drill_database_not_ready')
        inspect=json.loads(execute(['docker','inspect',container]))[0]
        if inspect['HostConfig']['NetworkMode']!='none' or inspect['HostConfig'].get('PortBindings') or any(x.get('Type')!='tmpfs' for x in inspect.get('Mounts',[])):
            # tmpfs appears in HostConfig.Tmpfs, not volume mounts.
            raise ValueError('drill_isolation_failed')
        psql=['docker','exec','-i',container,'psql','-X','-A','-t','-U','drill_admin','-d','drill_restore','-v','ON_ERROR_STOP=1']
        execute(psql,input=b'drop schema public cascade;')
        stream(args.identity,args.bundle/'roles.sql.age',psql)
        restore = ['docker','exec','-i',container,'pg_restore','--exit-on-error',
            '--single-transaction','-U','drill_admin','-d','drill_restore']
        # Schema-filtered pg_dump archives may omit CREATE EXTENSION. Restore
        # namespaces first, then install operator classes before post-data GiST
        # exclusion constraints. Every phase stays inside the disposable container.
        restore_archive_sections(args.identity,args.bundle/'database.dump.age',psql,restore,manifest.get('catalog', {}))
        expected=manifest['snapshot_catalog']
        for table in expected['tables']:
            sql=f"select count(*) from {quote(table['schema'])}.{quote(table['table'])};"
            count=int(execute(psql,input=sql.encode()).strip())
            if count!=table['rows']:raise ValueError('row_count_mismatch')
            sql="select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='%s' and c.relname='%s';"%(table['schema'],table['table'])
            if (execute(psql,input=sql.encode()).strip()==b't')!=table['rls']:raise ValueError('rls_mismatch')
        schemas="('public','auth','storage','supabase_migrations','extensions')"
        queries={
          'policies':f'select count(*) from pg_policies where schemaname in {schemas};',
          'constraints':f'select count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in {schemas};',
          'triggers':f'select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in {schemas} and not t.tgisinternal;',
          'functions':f'select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in {schemas};'}
        for key,query in queries.items():
            if int(execute(psql,input=query.encode()).strip())!=expected[key]:raise ValueError('catalog_count_mismatch')
        if not structures_match(expected['structure'], json.loads(execute(psql,input=STRUCTURE_SQL.encode()).strip())):
            raise ValueError('structure_or_acl_mismatch')
        # Existing real data stays inside container; output is booleans/counts only.
        check="""select count(*) from appointments a left join clients c on c.id=a.client_id and c.clinic_id=a.clinic_id
          left join staff s on s.id=a.staff_id and s.clinic_id=a.clinic_id
          where (a.client_id is not null and c.id is null) or (a.staff_id is not null and s.id is null);"""
        if int(execute(psql,input=check.encode()).strip()):raise ValueError('relationship_mismatch')
        # No-profile authenticated identity must see zero clinic/patient rows.
        check="""set role authenticated;
          set request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000099","role":"authenticated"}';
          select count(*) from clients;"""
        if execute(psql,input=check.encode()).strip().splitlines()[-1]!=b'0':raise ValueError('unbound_user_rls_failed')
        # Choose one restored membership internally and check cross-clinic invisibility.
        # Suppress setup result (contains an identity) while retaining its session.
        check="""do $$declare v uuid; c uuid; k bigint; begin
          select auth_user_id,clinic_id into v,c from profiles where revoked_at is null limit 1;
          if v is null then raise exception 'missing representative member'; end if;
          select count(*) into k from clients where clinic_id=c;
          perform set_config('apero.drill.expected_clinic',c::text,false);
          perform set_config('apero.drill.expected_clients',k::text,false);
          perform set_config('request.jwt.claims',jsonb_build_object('sub',v,'role','authenticated')::text,false); end $$;
          set role authenticated;
          select public.current_clinic_id()::text=current_setting('apero.drill.expected_clinic')
            and (select count(*) from clients)=current_setting('apero.drill.expected_clients')::bigint
            and (select count(*) from clients where clinic_id <> public.current_clinic_id())=0;"""
        if execute(psql,input=check.encode()).strip().splitlines()[-1]!=b't':raise ValueError('clinic_isolation_failed')
        success=True
    except Exception:
        print(json.dumps({'category':'restore_drill_failed','state':'failure','patient_values_logged':False}))
    finally:
        os.environ.pop('POSTGRES_PASSWORD',None)
        if created:
            removed=subprocess.run(['docker','rm','--force','--volumes',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if removed.returncode:
                success=False
                print(json.dumps({'category':'restore_drill_cleanup_failed','state':'failure'}))
        # No decrypted dump/roles file was ever written; tmpfs dies with container.
    if success:
        print(json.dumps({'category':'restore_drill_completed','state':'success','real_backup_restored':True,
            'isolated_network':True,'row_counts_catalog_rls_relationships_verified':True,
            'auth_schema_restored':True,'container_destroyed':True,'plaintext_files_written':False,
            'duration_seconds':round(time.monotonic()-started)}))
    return 0 if success else 1


if __name__=='__main__':sys.exit(main())
