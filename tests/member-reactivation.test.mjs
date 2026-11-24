import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { asRole, attempt } from "./helpers/clinic-database.mjs";

// Disposable account-only PostgreSQL schema. No providers, network, patient data
// or excluded integration/voice functionality is exercised.
test("Owner restoration is tenant scoped, verified, audited and retry safe", async () => {
  const db = new PGlite();
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  try {
    await db.exec(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; grant usage on schema auth,public to authenticated,service_role;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      create type public.profile_role as enum ('owner','manager','staff');
      create table clinics(id uuid primary key);
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,invited_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create table profiles(id uuid primary key default gen_random_uuid(),auth_user_id uuid unique references auth.users(id),clinic_id uuid references clinics(id),full_name text,email text,role profile_role);
    `);
    await db.exec(
      await readFile("supabase/migrations/20261003160000_clinic_team_management.sql", "utf8"),
    );
    await db.exec(`create trigger guard_profile_sensitive_fields before update on profiles for each row execute function guard_profile_sensitive_fields();
      alter table profiles enable row level security;
      grant select on profiles to authenticated;
      grant update(full_name) on profiles to authenticated;
      create policy profile_read on profiles for select to authenticated using(clinic_id=current_clinic_id());`);
    await db.exec(
      await readFile("supabase/migrations/20261124110000_clinic_member_reactivation.sql", "utf8"),
    );
    await db.exec(`create table clinic_onboarding(clinic_id uuid primary key references clinics(id), lifecycle text);
      create or replace function current_clinic_id() returns uuid language sql stable security definer set search_path=public,pg_temp as $$
      select p.clinic_id from profiles p where p.auth_user_id=auth.uid() and p.revoked_at is null
      and not exists(select 1 from clinic_onboarding o where o.clinic_id=p.clinic_id and o.lifecycle in ('suspended','closed')) limit 1 $$;`);
    const onboardingSql = await readFile(
      "supabase/migrations/20261124100000_clinic_onboarding.sql",
      "utf8",
    );
    await db.exec(
      onboardingSql.slice(
        onboardingSql.indexOf("create function public.clinic_lifecycle_allows_access("),
        onboardingSql.indexOf("create function public.validate_clinic_intake("),
      ),
    );
    await db.exec(
      await readFile("supabase/migrations/20261124111000_suspended_team_management.sql", "utf8"),
    );
    for (const clinic of [1, 2]) await db.query("insert into clinics values($1)", [id(clinic)]);
    for (const [n, clinic, role, confirmed] of [
      [10, 1, "owner", true],
      [11, 1, "manager", true],
      [12, 1, "staff", true],
      [13, 1, "staff", false],
      [20, 2, "owner", true],
      [21, 2, "staff", true],
    ]) {
      await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)", [
        id(n),
        `${n}@example.test`,
        confirmed ? "2026-11-24T00:00:00Z" : null,
      ]);
      await db.query(
        "insert into profiles(id,auth_user_id,clinic_id,full_name,email,role,revoked_at) values($1,$1,$2,$3,$4,$5,$6)",
        [
          id(n),
          id(clinic),
          `User ${n}`,
          `${n}@example.test`,
          role,
          role === "staff" ? "2026-11-23T00:00:00Z" : null,
        ],
      );
    }
    // Verify the retained SECURITY INVOKER maintenance boundary under broad
    // legacy grants, independently from ordinary column and RLS restrictions.
    await db.exec("begin");
    await db.query("select set_config('request.jwt.claims','{}',true)");
    await db.query("update profiles set revoked_at=now() where id=$1", [id(11)]);
    assert.ok(
      (await db.query("select revoked_at from profiles where id=$1", [id(11)])).rows[0].revoked_at,
    );
    await db.exec("rollback");
    await db.exec(
      "grant select,update(revoked_at) on profiles to service_role; grant update(revoked_at) on profiles to authenticated; create policy maintenance_boundary_test on profiles for update to authenticated using(true); create policy maintenance_read_boundary_test on profiles for select to authenticated using(true)",
    );
    for (const role of ["service_role", "authenticated"])
      await asRole(db, role, {}, async () => {
        await assert.rejects(
          attempt(db, () => db.query("update profiles set revoked_at=now() where id=$1", [id(11)])),
          (e) => e.code === "42501",
        );
      });
    await db.exec(
      "revoke update(revoked_at) on profiles from authenticated;drop policy maintenance_boundary_test on profiles;drop policy maintenance_read_boundary_test on profiles",
    );
    const as = async (n, fn) => {
      await db.exec("begin; set local role authenticated");
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: id(n), role: "authenticated", user_metadata: { role: "owner" } }),
      ]);
      try {
        await fn();
        await db.exec("commit");
      } catch (e) {
        await db.exec("rollback");
        throw e;
      }
    };
    const restore = (n) => db.query("select reactivate_clinic_member($1)", [id(n)]);
    for (const [actor, target] of [
      [11, 12],
      [12, 12],
      [20, 12],
      [10, 20],
      [10, 10],
      [10, 13],
      [10, 999],
    ]) {
      await assert.rejects(
        as(actor, () => restore(target)),
        (e) => e.code === "42501",
      );
    }
    for (const state of ["banned_until=now()+interval '1 day'", "deleted_at=now()"]) {
      await db.query(`update auth.users set ${state} where id=$1`, [id(12)]);
      await assert.rejects(
        as(10, () => restore(12)),
        (e) => e.code === "42501",
      );
      assert.ok(
        (await db.query("select revoked_at from profiles where id=$1", [id(12)])).rows[0]
          .revoked_at,
      );
      assert.equal(
        (await db.query("select count(*)::int n from clinic_membership_audit")).rows[0].n,
        0,
      );
      await db.query("update auth.users set banned_until=null,deleted_at=null where id=$1", [
        id(12),
      ]);
    }
    // A ban that has elapsed must not prevent authorized restoration.
    await db.query("update auth.users set banned_until=now()-interval '1 day' where id=$1", [
      id(12),
    ]);
    await as(10, async () => {
      await assert.rejects(
        (async () => {
          await db.exec("savepoint direct");
          try {
            await db.query("update profiles set revoked_at=null where id=$1", [id(12)]);
          } finally {
            await db.exec("rollback to savepoint direct");
          }
        })(),
        (e) => e.code === "42501",
      );
      await restore(12);
      await restore(12);
      assert.equal(
        (await db.query("select revoked_at,role from profiles where id=$1", [id(12)])).rows[0]
          .revoked_at,
        null,
      );
    });
    assert.equal(
      (await db.query("select count(*)::int n from clinic_membership_audit")).rows[0].n,
      1,
    );
    await as(12, async () =>
      assert.equal((await db.query("select current_clinic_id() id")).rows[0].id, id(1)),
    );
    await as(10, async () => {
      assert.equal(
        (await db.query("select count(*)::int n from clinic_membership_audit")).rows[0].n,
        1,
      );
      await db.query("select revoke_clinic_member($1)", [id(12)]);
    });
    await as(12, async () =>
      assert.equal((await db.query("select current_clinic_id() id")).rows[0].id, null),
    );
    await as(20, async () =>
      assert.equal(
        (await db.query("select count(*)::int n from clinic_membership_audit")).rows[0].n,
        0,
      ),
    );
    await as(11, async () =>
      assert.equal(
        (await db.query("select count(*)::int n from clinic_membership_audit")).rows[0].n,
        0,
      ),
    );
    assert.equal(
      (await db.query("select count(*)::int n from clinic_membership_audit")).rows[0].n,
      2,
    );
    await db.exec("begin;set local role service_role");
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "service_role" }),
    ]);
    assert.equal(
      (
        await db.query("select owner_invite_email_available($1,'available@example.test') ok", [
          id(10),
        ])
      ).rows[0].ok,
      true,
    );
    await db.exec("commit");
    for (const state of ["banned_until=now()+interval '1 day'", "deleted_at=now()"]) {
      await db.query(`update auth.users set ${state} where id=$1`, [id(10)]);
      await db.exec("begin;set local role service_role");
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      await assert.rejects(
        db.query("select reserve_clinic_invitation($1,null,'blocked@example.test','invite',null)", [
          id(10),
        ]),
        (e) => e.code === "42501",
      );
      await db.exec("rollback");
      await db.query("update auth.users set banned_until=null,deleted_at=null where id=$1", [
        id(10),
      ]);
    }
    await db.query("insert into clinic_onboarding values($1,'suspended')", [id(1)]);
    for (const operation of [
      () => restore(12),
      () => db.query("select revoke_clinic_member($1)", [id(11)]),
      () => db.query("select set_clinic_member_role($1,'staff')", [id(11)]),
      () => db.query("select member_access_original_revoke($1)", [id(11)]),
    ])
      await assert.rejects(as(10, operation), (e) => e.code === "42501");
    for (const [sql, args] of [
      ["select reserve_clinic_invitation($1,$2,'new@example.test','invite',null)", [id(10), null]],
      [
        "select reserve_clinic_invitation(null,$1,'new@example.test','operator_invite',null)",
        [id(1)],
      ],
      [
        "select owner_invite_clinic_member($1,$2,'13@example.test','Member','staff')",
        [id(10), id(13)],
      ],
      ["select owner_invite_email_available($1,'new@example.test')", [id(10)]],
    ]) {
      await db.exec("begin;set local role service_role");
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      await assert.rejects(db.query(sql, args), (e) => e.code === "42501");
      await db.exec("rollback");
    }
    // Authorized disposable erasure retains audit attribution without a clinic FK.
    await db.query("delete from profiles where clinic_id=$1", [id(1)]);
    await db.query("delete from clinic_onboarding where clinic_id=$1", [id(1)]);
    await db.query("delete from clinics where id=$1", [id(1)]);
    assert.equal(
      (
        await db.query("select count(*)::int n from clinic_membership_audit where clinic_id=$1", [
          id(1),
        ])
      ).rows[0].n,
      2,
    );
  } finally {
    await db.close();
  }
});
