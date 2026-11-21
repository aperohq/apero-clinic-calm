import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
test("fresh schema-only migration chain boots without development patients", async () => {
  const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
  try {
    await db.exec(`create role anon nologin nobypassrls;create role authenticated nologin nobypassrls;create role service_role nologin bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,invited_at timestamptz,email_confirmed_at timestamptz);
 grant usage on schema public,auth to anon,authenticated,service_role;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;`);
    const files = (await readdir("supabase/migrations")).filter((x) => x.endsWith(".sql")).sort();
    for (const file of files) {
      // pg_cron is a native background-worker extension unavailable in WASM.
      // Its installation/schedule is separately required in native Supabase CI.
      if (file === "20261006162000_retention_daily_schedule.sql") continue;
      try {
        await db.exec(await readFile("supabase/migrations/" + file, "utf8"));
      } catch (e) {
        throw new Error("Migration failed: " + file, { cause: e });
      }
    }
    for (const table of ["clinics", "profiles", "clients", "staff", "appointments"])
      assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n, 0);
    assert.ok(
      (await db.query("select 1 from pg_constraint where conname='appointments_shared_no_overlap'"))
        .rows.length,
    );
    assert.ok(
      (
        await db.query(
          "select 1 from pg_policies where tablename='voice_requests' and cmd='UPDATE'",
        )
      ).rows.length,
    );
    console.log("PASS ordered migration chain; native pg_cron validation remains required");
  } finally {
    await db.close();
  }
});
