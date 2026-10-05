// Synthetic, network-free recovery drill. PGlite physical snapshot is NOT pg_dump.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
const extensions = { pgcrypto };
let original, recovered;
try {
  original = new PGlite({ extensions });
  await original.exec(`
    create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
  `);
  const schema = await readFile(new URL('../../db/01_phase2_schema.sql', import.meta.url), 'utf8');
  const marker = '-- ----------------------------------------------------- development seed';
  assert.ok(schema.includes(marker));
  await original.exec(schema.split(marker)[0]);
  const ids = { clinic:'00000000-0000-4000-8000-000000000001', user:'00000000-0000-4000-8000-000000000002',
    patient:'00000000-0000-4000-8000-000000000003' };
  await original.exec(`insert into auth.users values ('${ids.user}');
    insert into public.clinics (id,name) values ('${ids.clinic}','Synthetic drill');
    insert into public.profiles (auth_user_id,clinic_id,full_name,email,role)
      values ('${ids.user}','${ids.clinic}','Synthetic operator','operator@example.test','owner');
    insert into public.clients (id,clinic_id,full_name,phone)
      values ('${ids.patient}','${ids.clinic}','Synthetic patient','+12025550101');`);
  const catalog = async db => (await db.query(`select
    (select count(*) from pg_policies where schemaname='public')::int policies,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')::int functions,
    (select count(*) from pg_constraint where contype='f')::int foreign_keys,
    (select count(*) from pg_trigger where not tgisinternal)::int triggers,
    (select count(*) from information_schema.tables where table_schema='public')::int tables`)).rows[0];
  const before = await catalog(original);
  const snapshot = await original.dumpDataDir();
  assert.ok(snapshot.size > 0);
  await original.close(); original = undefined;
  recovered = new PGlite({ extensions, loadDataDir:snapshot });
  assert.deepEqual(await catalog(recovered), before);
  await recovered.exec(`set role authenticated; set request.jwt.claim.sub='${ids.user}'`);
  assert.equal((await recovered.query('select count(*)::int count from public.clients')).rows[0].count,1);
  assert.equal((await recovered.query('select public.current_profile_role()::text role')).rows[0].role,'owner');
  await recovered.exec(`set request.jwt.claim.sub='00000000-0000-4000-8000-000000000099'`);
  assert.equal((await recovered.query('select count(*)::int count from public.clients')).rows[0].count,0);
  await recovered.exec('reset role');
  let rejected = false;
  try { await recovered.exec(`insert into public.clients(clinic_id,full_name,phone)
      values ('00000000-0000-4000-8000-000000000098','Synthetic invalid','+12025550102')`); }
  catch { rejected = true; }
  assert.ok(rejected, 'restored foreign key must reject orphan');
  console.log(JSON.stringify({state:'success',productionDataUsed:false,networkUsed:false,
    schemaRestored:true,rlsTenantChecks:true,rpcRestored:true,foreignKeyEnforced:true,
    catalog:before,limitation:'Synthetic baseline schema/PGlite physical snapshot only. Production pg_dump/Auth/managed extensions and full migration chain remain untested.'}));
} finally {
  await original?.close(); await recovered?.close();
}
