import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { disposablePostgres, command, pgBinary } from "./helpers/disposable-postgres.mjs";
const shim = `create role anon nologin nobypassrls;create role authenticated nologin nobypassrls;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,invited_at timestamptz,email_confirmed_at timestamptz);
grant usage on schema public,auth to anon,authenticated,service_role;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;`;
const ids = {
  a: "00000000-0000-4000-8000-000000000001",
  b: "00000000-0000-4000-8000-000000000002",
  ua: "00000000-0000-4000-8000-000000000011",
  ub: "00000000-0000-4000-8000-000000000012",
  ca: "00000000-0000-4000-8000-000000000021",
  cb: "00000000-0000-4000-8000-000000000022",
};
async function seed(sql) {
  for (const [clinic, user, client] of [
    [ids.a, ids.ua, ids.ca],
    [ids.b, ids.ub, ids.cb],
  ]) {
    await sql`insert into auth.users(id,email) values(${user},${user + "@example.test"})`;
    await sql`insert into clinics(id,name) values(${clinic},'Synthetic native clinic')`;
    await sql`insert into profiles(auth_user_id,clinic_id,full_name,email,role) values(${user},${clinic},'Synthetic Owner',${user + "@example.test"},'owner')`;
    await sql`insert into clients(id,clinic_id,full_name,phone) values(${client},${clinic},'عيادة اختبار','12345678')`;
    await sql`insert into client_notes(clinic_id,client_id,author_profile_id,note) select ${clinic},${client},id,'Synthetic historical note' from profiles where auth_user_id=${user}`;
    await sql`insert into demo_recovery_operators(auth_user_id,clinic_id) values(${user},${clinic})`;
    await sql`insert into demo_call_recovery_audit(actor_user_id,clinic_id,request_id,outcome) values(${user},${clinic},${client},'requested')`;
  }
}
async function snapshotRows(sql) {
  const result = {};
  for (const table of [
    "clinics",
    "profiles",
    "clients",
    "client_notes",
    "demo_call_sessions",
    "demo_recovery_operators",
    "demo_call_recovery_audit",
  ])
    result[table] = await sql.unsafe(
      `select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`,
    );
  return result;
}
async function verifyIsolation(sql) {
  await sql.begin(async (tx) => {
    await tx.unsafe("set local role authenticated");
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ role: "authenticated", sub: ids.ua })},true)`;
    assert.deepEqual(
      (await tx`select id from clients`).map((x) => x.id),
      [ids.ca],
    );
  });
}
const evidence = {
  native_postgresql: true,
  supabase_auth_shim: true,
  production_data: false,
  modes: [],
};
for (const mode of ["fresh", "existing-upgrade"]) {
  const cluster = await disposablePostgres({ cron: true });
  const sql = postgres({ ...cluster, max: 1, onnotice() {} });
  let success = false;
  try {
    await sql.unsafe(shim);
    const files = (await readdir("supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
    let snapshot;
    for (const file of files) {
      if (mode === "existing-upgrade" && file.startsWith("20261120") && !snapshot) {
        await seed(sql);
        snapshot = await snapshotRows(sql);
      }
      await sql.unsafe(await readFile("supabase/migrations/" + file, "utf8"));
    }
    if (mode === "fresh") {
      assert.equal((await sql`select count(*)::int n from clients`)[0].n, 0);
      await seed(sql);
    } else assert.deepEqual(await snapshotRows(sql), snapshot);
    await verifyIsolation(sql);
    const jobs =
      await sql`select command,schedule,active from cron.job where jobname='apero-retention-daily'`;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].active, true);
    assert.match(jobs[0].command, /retention_daily/);
    await sql`create table public.native_cron_probe(ok boolean default true)`;
    await sql`select cron.schedule('apero-native-probe','1 second','insert into public.native_cron_probe default values')`;
    let observed = false;
    for (let n = 0; n < 100; n++) {
      if ((await sql`select count(*)::int n from public.native_cron_probe`)[0].n > 0) {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(observed, true, "pg_cron background worker must execute a synthetic job");
    await sql`select cron.unschedule('apero-native-probe')`;
    await sql`drop table public.native_cron_probe`;
    const [identity] =
      await sql`select current_database() db,inet_server_addr() address,current_setting('data_directory') directory,current_setting('server_version') server_version`;
    evidence.postgresql_version = identity.server_version;
    assert.equal(identity.address, null);
    assert.equal(identity.directory, join(cluster.root, "data"));
    if (mode === "fresh") {
      // Run genuine pg_dump -> age -> pg_restore with production restoration helpers.
      await command(
        process.platform === "win32" ? "python" : "python3",
        ["scripts/operations/native_restore_acceptance.py"],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            APERO_NATIVE_ROOT: cluster.root,
            APERO_NATIVE_DB: cluster.database,
            APERO_NATIVE_PORT: String(cluster.port),
            APERO_TEST_PG_BIN: process.env.APERO_TEST_PG_BIN ?? "",
          },
        },
      );
    }
    if (mode === "fresh")
      evidence.genuine_synthetic_restore = {
        extension_schemas: ["public", "extensions"],
        encrypted: true,
        plaintext_dump_written: false,
      };
    evidence.modes.push({
      mode,
      migrations: files.length,
      cron_extension: true,
      cron_background_execution: true,
      tenant_rls: true,
      existing_rows_preserved: mode === "existing-upgrade",
    });

    await sql`delete from auth.users where id=${ids.ua}`;
    assert.equal(
      (await sql`select count(*)::int n from demo_recovery_operators where clinic_id=${ids.a}`)[0]
        .n,
      0,
    );
    assert.equal(
      (await sql`select actor_user_id from demo_call_recovery_audit where clinic_id=${ids.a}`)[0]
        .actor_user_id,
      null,
    );
    // Exercise the real approval/custody-gated cleanup path in this synthetic cluster.
    await sql`update retention_control set mode='enabled',approved_at=now(),restore_ledger_ready=true`;
    await sql`select retention_begin_offboarding(${ids.a}::uuid)`;
    await sql`update clinic_offboarding set grace_until=now()-interval '1 day',telephony_stopped_verified=true,provider_inventory_verified=true,secrets_revoked_verified=true where clinic_id=${ids.a}`;
    let offboarded = false;
    for (let n = 0; n < 40; n++) {
      await sql`update retention_deletion_ledger set durable_at=now() where clinic_id=${ids.a}`;
      const [result] = await sql`select retention_offboard_batch(${ids.a}::uuid,false,100) result`;
      if (result.result.state === "complete") {
        offboarded = true;
        break;
      }
    }
    assert.equal(
      offboarded,
      true,
      "Approved synthetic offboarding must finish with retained recovery audit",
    );
    assert.equal(
      (await sql`select clinic_id from demo_call_recovery_audit where request_id=${ids.ca}`)[0]
        .clinic_id,
      ids.a,
    );
    assert.equal((await sql`select count(*)::int n from clinics where id=${ids.b}`)[0].n, 1);
    evidence.recovery_history_preserved_after_user_and_clinic_deletion = true;
    success = true;
    console.log("PASS native migrations and pg_cron:", mode);
  } finally {
    await sql.end({ timeout: 2 });
    await cluster.close(success);
  }
}
if (process.env.APERO_TEST_RESULTS_DIR) {
  await mkdir(process.env.APERO_TEST_RESULTS_DIR, { recursive: true });
  await writeFile(
    join(process.env.APERO_TEST_RESULTS_DIR, "native-migrations.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
}
