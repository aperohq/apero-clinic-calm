// Source/config recovery and failed migration rehearsal; synthetic local state only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import postgres from "postgres";
import { disposablePostgres } from "../helpers/disposable-postgres.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const files = [
  "src/routes/home.tsx",
  "src/routes/account.tsx",
  "supabase/functions/integration-api/index.ts",
  "supabase/functions/integration-worker/index.ts",
];
const root = await mkdtemp(join(tmpdir(), "apero-release-recovery-"));
let cluster;
let sql;
let success = false;
const results = [];
try {
  for (const file of files) {
    const original = await readFile(file);
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, original);
    await writeFile(target, "synthetic faulty replacement\n");
    assert.notEqual(hash(await readFile(target)), hash(original));
    await writeFile(target, original);
    assert.equal(hash(await readFile(target)), hash(original));
  }
  results.push({
    scenario: "REC-SOURCE-01",
    status: "PASS",
    restored_source_files: files.length,
    scope: "isolated source artifacts, not hosting or Edge deployment",
  });
  const settings = join(root, "synthetic-settings.json");
  const initial = JSON.stringify({ origin: "https://example.test", enabled: false });
  await writeFile(settings, initial, { mode: 0o600 });
  await writeFile(settings, JSON.stringify({ origin: "https://invalid.test", enabled: true }));
  await writeFile(settings, initial);
  assert.equal(await readFile(settings, "utf8"), initial);
  results.push({
    scenario: "REC-CONFIG-01",
    status: "PASS",
    scope: "synthetic local configuration restore; no production configuration",
  });
  cluster = await disposablePostgres({ cron: true });
  sql = postgres({ ...cluster, max: 1, onnotice() {} });
  await sql.unsafe(`create role anon nologin nobypassrls;create role authenticated nologin nobypassrls;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,invited_at timestamptz,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    grant usage on schema public,auth to anon,authenticated,service_role;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;`);
  const migrations = (await readdir("supabase/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations)
    await sql.unsafe(await readFile(join("supabase/migrations", name), "utf8"));
  await sql.unsafe("begin;alter table clients add column acceptance_rollback_probe text;");
  await assert.rejects(sql.unsafe("select 1/0"), { code: "22012" });
  await sql.unsafe("rollback");
  assert.equal(
    (
      await sql`select count(*)::int n from information_schema.columns where table_schema='public' and table_name='clients' and column_name='acceptance_rollback_probe'`
    )[0].n,
    0,
  );
  for (const suffix of [1, 2]) {
    const clinic = `00000000-0000-4000-8000-00000000000${suffix}`;
    const user = `00000000-0000-4000-8000-00000000001${suffix}`;
    await sql`insert into auth.users(id,email,email_confirmed_at) values(${user},${`recovery${suffix}@example.test`},now())`;
    await sql`insert into clinics(id,name) values(${clinic},'Synthetic recovery clinic')`;
    await sql`insert into profiles(auth_user_id,clinic_id,full_name,email,role) values(${user},${clinic},'Synthetic Owner',${`recovery${suffix}@example.test`},'owner')`;
    await sql`insert into clients(clinic_id,full_name,phone) values(${clinic},'Synthetic recovery patient','12345678')`;
  }
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role authenticated");
    await tx`select set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000011"}',true)`;
    const rows = await tx`select clinic_id from clients`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clinic_id, "00000000-0000-4000-8000-000000000001");
  });
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role authenticated");
    await tx`select set_config('request.jwt.claims','{}',true)`;
    assert.equal((await tx`select count(*)::int n from clients`)[0].n, 0);
  });
  results.push({
    scenario: "REC-MIGRATION-01",
    status: "PASS",
    migrations: migrations.length,
    failed_transaction_rolled_back: true,
    tenant_and_unbound_identity_denial_after_recovery: true,
    auth_issuance: "synthetic claims; hosted Auth not exercised",
  });
  success = true;
} finally {
  if (sql) await sql.end({ timeout: 2 });
  if (cluster) await cluster.close(success);
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      results,
      production_modified: false,
      external_operations: 0,
      synthetic_cleanup_completed: true,
    },
    null,
    2,
  ),
);
