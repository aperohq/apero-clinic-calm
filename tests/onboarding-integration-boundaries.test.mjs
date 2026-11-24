import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createClinicDatabase,
  loadSql,
  tenants,
  uuid,
  asUser,
  asRole,
  attempt,
} from "./helpers/clinic-database.mjs";

// Database credential authorization only; no provider, worker, Calendar or voice
// functionality executes. All identities/keys/credential strings are synthetic.
test("Existing clinic API credentials respect onboarding lifecycle and tenant boundaries", async (t) => {
  const db = await createClinicDatabase({ settings: true, appointments: true });
  const [a, b] = tenants,
    keys = new Map(),
    hashes = new Map();
  const denied = (fn, codes = ["42501"]) =>
    assert.rejects(attempt(db, fn), (e) => codes.includes(e.code));
  try {
    for (const file of [
      "20261006160000_data_retention.sql",
      "20261122120000_integration_system.sql",
      "20261124100000_clinic_onboarding.sql",
      "20261124102000_clinic_activation.sql",
      "20261124110000_clinic_member_reactivation.sql",
      "20261124111000_suspended_team_management.sql",
      "20261124112000_integration_access_lifecycle.sql",
    ])
      await loadSql(db, `../supabase/migrations/${file}`);
    await db.exec(
      "alter table auth.users add column banned_until timestamptz;alter table auth.users add column deleted_at timestamptz",
    );
    for (const [index, tenant] of tenants.entries()) {
      await db.query("update auth.users set email_confirmed_at=now() where id=$1", [tenant.user]);
      await db.query(
        "insert into clinic_onboarding(clinic_id,submission_key,payload) values($1,$2,'{}')",
        [tenant.clinic, `credential-access-${index}`],
      );
      const key = uuid(9800 + index),
        hash = String(index + 1).repeat(64);
      keys.set(tenant.clinic, key);
      hashes.set(tenant.clinic, hash);
      await db.query(
        "insert into integration_keys(id,clinic_id,name,key_hash,prefix,scopes) values($1,$2,'Synthetic',$3,'synthetic',array['appointments:read','appointments:write','availability:read'])",
        [key, tenant.clinic, hash],
      );
      await db.query(
        "insert into calendar_connections(clinic_id,credentials) values($1,'synthetic-no-provider-secret')",
        [tenant.clinic],
      );
      for (const [offset, role] of [
        [1, "manager"],
        [2, "staff"],
      ]) {
        const user = uuid(9900 + index * 10 + offset);
        await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [
          user,
          `${user}@example.test`,
        ]);
        await db.query(
          "insert into profiles(auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3::text,$4,$3::text::profile_role)",
          [user, tenant.clinic, role, `${user}@example.test`],
        );
        await t.test(`${role} credential escalation denied for clinic ${index}`, () =>
          asUser(db, user, async () => {
            await denied(() => db.query("select integration_dashboard()"));
            await denied(() =>
              db.query(
                "select integration_create_key('Escalation',array['appointments:read'],null)",
              ),
            );
            await denied(() => db.query("select integration_revoke_key($1)", [key]));
            await denied(() =>
              db.query("select integration_authorize($1,'appointments:read')", [hash]),
            );
          }),
        );
      }
      await t.test(`Owner metadata and private credential boundaries ${index}`, () =>
        asUser(db, tenant.user, async () => {
          const data = (await db.query("select integration_dashboard() value")).rows[0].value;
          assert.deepEqual(
            data.keys.map((k) => k.id),
            [key],
          );
          assert.equal(data.connections.length, 1);
          assert.ok(!JSON.stringify(data).includes("synthetic-no-provider-secret"));
          assert.ok(!JSON.stringify(data).includes(hash));
          for (const table of [
            "integration_keys",
            "calendar_connections",
            "integration_oauth_states",
            "integration_requests",
            "integration_audit",
          ]) {
            await denied(() => db.query(`select * from ${table}`));
            await denied(() =>
              db.query(
                `update ${table} set ${table === "integration_oauth_states" ? "actor_id=actor_id" : table === "integration_requests" ? "key_id=key_id" : "clinic_id=clinic_id"}`,
              ),
            );
            await denied(() => db.query(`delete from ${table}`));
            await denied(() => db.query(`truncate ${table}`));
          }
          const created = (
            await db.query(
              "select integration_create_key('Local only',array['appointments:read'],null) value",
            )
          ).rows[0].value;
          assert.match(created.key, /^apero_[a-f0-9]{64}$/);
          const metadata = (await db.query("select integration_dashboard() value")).rows[0].value;
          assert.ok(!JSON.stringify(metadata).includes(created.key));
          assert.ok(metadata.keys.every((k) => !Object.hasOwn(k, "key_hash")));
          await denied(
            () =>
              db.query("select integration_create_key('Bad scope',array['security:write'],null)"),
            ["22023"],
          );
        }),
      );
    }
    await t.test("Owner cannot rotate/revoke foreign or nonexistent keys", () =>
      asUser(db, a.user, async () => {
        for (const target of [keys.get(b.clinic), uuid(9999)]) {
          await denied(
            () =>
              db.query(
                "select integration_create_key('Wrong tenant',array['appointments:read'],$1)",
                [target],
              ),
            ["22023"],
          );
          await denied(() => db.query("select integration_revoke_key($1)", [target]), ["22023"]);
        }
      }),
    );
    for (const [field, value] of [
      ["banned_until", "now()+interval '1 day'"],
      ["deleted_at", "now()"],
    ]) {
      await db.query(`update auth.users set ${field}=${value} where id=$1`, [a.user]);
      await t.test(`${field} Owner retained token cannot manage API keys`, () =>
        asUser(db, a.user, async () => {
          await denied(() => db.query("select integration_dashboard()"));
          await denied(() =>
            db.query("select integration_create_key('Blocked',array['appointments:read'],null)"),
          );
        }),
      );
      await db.query("update auth.users set banned_until=null,deleted_at=null where id=$1", [
        a.user,
      ]);
    }
    await t.test("New configuration is not API-active before explicit activation", () =>
      asRole(db, "service_role", { role: "service_role" }, async () => {
        for (const scope of ["appointments:read", "appointments:write", "availability:read"])
          assert.equal(
            (
              await db.query("select integration_authorize($1,$2) value", [
                hashes.get(a.clinic),
                scope,
              ])
            ).rows[0].value,
            null,
          );
      }),
    );
    await t.test("Configuration keys cannot bypass activation through mutation RPC", () =>
      asRole(db, "service_role", { role: "service_role" }, async () => {
        await denied(() =>
          db.query("select integration_mutate($1,'synthetic-request','{\"action\":\"invalid\"}')", [
            keys.get(a.clinic),
          ]),
        );
      }),
    );
    // Direct synthetic state fixture, not a real-clinic activation decision.
    await db.exec("update clinic_onboarding set lifecycle='activated'");
    await t.test(
      "Credential mutation locks clinic before key and keeps original private",
      async () => {
        const definition = (
          await db.query(
            "select pg_get_functiondef('integration_mutate(uuid,text,jsonb)'::regprocedure) body",
          )
        ).rows[0].body;
        const clinicLock = definition.indexOf("from public.clinics where id=cid for share");
        const keyLock = definition.indexOf("and revoked_at is null and expires_at>now() for share");
        const originalCall = definition.indexOf("return public.integration_mutate_locked_original");
        assert.ok(clinicLock >= 0 && keyLock > clinicLock && originalCall > keyLock);
        for (const role of ["anon", "authenticated", "service_role"])
          assert.equal(
            (
              await db.query(
                "select has_function_privilege($1,'integration_mutate_locked_original(uuid,text,jsonb)','execute') allowed",
                [role],
              )
            ).rows[0].allowed,
            false,
          );
        // Operator post-wait admission is exercised using actual concurrent
        // transactions in onboarding-native, not a helper-name text match.
      },
    );
    await t.test("Mutation wrapper rechecks credential before invoking existing behavior", () =>
      asRole(db, "service_role", { role: "service_role" }, async () => {
        await denied(() =>
          db.query("select integration_mutate($1,'synthetic-request','{\"action\":\"invalid\"}')", [
            uuid(9999),
          ]),
        );
        // Valid credentials reach the unchanged original validation (no writes).
        await denied(
          () =>
            db.query(
              "select integration_mutate($1,'synthetic-request','{\"action\":\"invalid\"}')",
              [keys.get(a.clinic)],
            ),
          ["22023"],
        );
      }),
    );

    await t.test("Active API credential is service-only and clinic scoped", () =>
      asRole(db, "service_role", { role: "service_role" }, async () => {
        const result = (
          await db.query("select integration_authorize($1,'appointments:read') value", [
            hashes.get(a.clinic),
          ])
        ).rows[0].value;
        assert.equal(result.clinic_id, a.clinic);
        assert.equal(result.id, keys.get(a.clinic));
        assert.equal(
          (
            await db.query("select integration_authorize($1,'security:write') value", [
              hashes.get(a.clinic),
            ])
          ).rows[0].value,
          null,
        );
      }),
    );
    await db.query("delete from clinic_onboarding where clinic_id=$1", [b.clinic]);
    await t.test("Legacy clinic without onboarding preserves scoped API authorization", () =>
      asRole(db, "service_role", { role: "service_role" }, async () => {
        assert.equal(
          (
            await db.query("select integration_authorize($1,'appointments:read') value", [
              hashes.get(b.clinic),
            ])
          ).rows[0].value.clinic_id,
          b.clinic,
        );
        assert.equal(
          (await db.query("select integration_authorize($1,null) value", [hashes.get(b.clinic)]))
            .rows[0].value,
          null,
        );
      }),
    );
    await db.query("update clinic_onboarding set lifecycle='suspended' where clinic_id=$1", [
      a.clinic,
    ]);
    assert.ok(
      (await db.query("select revoked_at from integration_keys where id=$1", [keys.get(a.clinic)]))
        .rows[0].revoked_at,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from integration_audit where clinic_id=$1 and action='key.clinic_suspended'",
          [a.clinic],
        )
      ).rows[0].n,
      1,
    );
    await t.test("Suspended Owner cannot create/revoke keys or read credential metadata", () =>
      asUser(db, a.user, async () => {
        await denied(() => db.query("select integration_dashboard()"));
        await denied(() =>
          db.query("select integration_create_key('Blocked',array['appointments:read'],null)"),
        );
        await denied(() => db.query("select integration_revoke_key($1)", [keys.get(a.clinic)]));
      }),
    );
    for (const lifecycle of ["suspended", "configuration", "closed"]) {
      await db.query("update clinic_onboarding set lifecycle=$1 where clinic_id=$2", [
        lifecycle,
        a.clinic,
      ]);
      await t.test(`Old API keys remain invalid in ${lifecycle}`, () =>
        asRole(db, "service_role", { role: "service_role" }, async () => {
          for (const scope of ["appointments:read", "appointments:write", "availability:read"])
            assert.equal(
              (
                await db.query("select integration_authorize($1,$2) value", [
                  hashes.get(a.clinic),
                  scope,
                ])
              ).rows[0].value,
              null,
            );
          assert.equal(
            (
              await db.query("select integration_authorize($1,'appointments:read') value", [
                hashes.get(b.clinic),
              ])
            ).rows[0].value.clinic_id,
            b.clinic,
          );
        }),
      );
    }
    await t.test("Anonymous access denied", () =>
      asRole(db, "anon", { role: "anon" }, async () => {
        await denied(() => db.query("select integration_dashboard()"));
        await denied(() => db.query("select * from integration_keys"));
        await denied(() =>
          db.query("select integration_create_key('Anonymous',array['appointments:read'],null)"),
        );
      }),
    );
  } finally {
    await db.close();
  }
});
