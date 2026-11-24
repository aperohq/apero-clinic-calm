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

// Full existing product schema, disposable PostgreSQL only. The historical helper
// installs legacy fixtures; no excluded provider/integration functionality runs.
test("Onboarding/account migrations enforce full-schema tenant and lifecycle boundaries", async (t) => {
  const db = await createClinicDatabase({ settings: true, appointments: true });
  const [a, b] = tenants;
  const members = [];
  const denied = (run) => assert.rejects(attempt(db, run), (e) => e.code === "42501");
  try {
    for (const file of [
      "20261124100000_clinic_onboarding.sql",
      "20261124102000_clinic_activation.sql",
      "20261124110000_clinic_member_reactivation.sql",
      "20261124111000_suspended_team_management.sql",
    ])
      await loadSql(db, `../supabase/migrations/${file}`);
    // Exercise recording column grants with a synthetic legacy URL; no provider
    // retrieval, call data, media request or voice workflow is involved.
    await db.exec(
      "alter table public.conversations add column if not exists recording_url text; update public.conversations set recording_url='https://synthetic.invalid/private'",
    );
    await loadSql(db, "../supabase/migrations/20261004140000_recording_access.sql");
    for (const [index, tenant] of tenants.entries()) {
      for (const [offset, role] of [
        [1, "manager"],
        [2, "staff"],
      ]) {
        const member = {
          user: uuid(9000 + index * 10 + offset),
          profile: uuid(9100 + index * 10 + offset),
          tenant,
          role,
        };
        await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [
          member.user,
          `${member.user}@example.test`,
        ]);
        await db.query(
          "insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3,$4,$5,$6)",
          [member.profile, member.user, tenant.clinic, role, `${member.user}@example.test`, role],
        );
        members.push(member);
      }
      await db.query(
        "insert into clinic_onboarding(clinic_id,submission_key,payload,synthetic) values($1,$2,'{}',true)",
        [tenant.clinic, `synthetic-access-${index}`],
      );
      await db.query(
        "insert into clinic_onboarding_audit(clinic_id,event,reason) values($1,'provisioned','Synthetic contract fixture')",
        [tenant.clinic],
      );
    }
    for (const tenant of tenants) {
      const target = members.find((m) => m.tenant === tenant && m.role === "staff");
      await db.query(
        "insert into clinic_membership_audit(clinic_id,target_profile_id,previous_role,next_role) values($1,$2,'staff','staff')",
        [tenant.clinic, target.profile],
      );
    }
    await t.test(
      "Direct privileges exclude security mutations and internal RPC execution",
      async () => {
        for (const role of ["anon", "authenticated", "service_role"]) {
          for (const table of [
            "clinic_onboarding",
            "clinic_onboarding_audit",
            "clinic_membership_audit",
          ]) {
            for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
              assert.equal(
                (
                  await db.query("select has_table_privilege($1,$2,$3) allowed", [
                    role,
                    table,
                    privilege,
                  ])
                ).rows[0].allowed,
                false,
                `${role} ${table} ${privilege}`,
              );
          }
          assert.equal(
            (
              await db.query(
                "select has_function_privilege($1,'member_access_original_revoke(uuid)','execute') allowed",
                [role],
              )
            ).rows[0].allowed,
            false,
          );
        }
      },
    );
    for (const tenant of tenants)
      await t.test(`Owner sees only own intake ${tenant.clinic}`, () =>
        asUser(db, tenant.user, async () => {
          assert.deepEqual((await db.query("select clinic_id from clinic_onboarding")).rows, [
            { clinic_id: tenant.clinic },
          ]);
          assert.deepEqual((await db.query("select clinic_id from clinic_membership_audit")).rows, [
            { clinic_id: tenant.clinic },
          ]);
          assert.equal(
            (
              await db.query("select * from clinic_onboarding where clinic_id=$1", [
                tenant === a ? b.clinic : a.clinic,
              ])
            ).rows.length,
            0,
          );
          for (const table of [
            "clinic_onboarding",
            "clinic_onboarding_audit",
            "clinic_membership_audit",
          ]) {
            await denied(() => db.query(`update ${table} set clinic_id=clinic_id`));
            await denied(() => db.query(`delete from ${table}`));
            await denied(() => db.query(`truncate ${table}`));
          }
          await denied(() =>
            db.query(
              "insert into clinic_onboarding(clinic_id,submission_key,payload) values($1,'forged-key','{}')",
              [uuid(9999)],
            ),
          );
          await denied(() => db.query("select * from clinic_onboarding_audit"));
          await denied(() =>
            db.query("select clinic_activation_readiness($1)", [
              tenant === a ? b.clinic : a.clinic,
            ]),
          );
          await denied(() => db.query("select clinic_activation_readiness($1)", [uuid(9999)]));
          await denied(() => db.query("select provision_clinic('forged-key','{}')"));
          await denied(() =>
            db.query("select decide_clinic_lifecycle($1,'activate','forged','consent',true)", [
              tenant.clinic,
            ]),
          );
        }),
      );
    for (const member of members)
      await t.test(`${member.role} cannot read intake or escalate`, () =>
        asUser(
          db,
          member.user,
          async () => {
            assert.equal((await db.query("select * from clinic_onboarding")).rows.length, 0);
            assert.equal((await db.query("select * from clinic_membership_audit")).rows.length, 0);
            await denied(() =>
              db.query("select clinic_activation_readiness($1)", [member.tenant.clinic]),
            );
            await denied(() =>
              db.query("select set_clinic_member_role($1,'manager')", [member.profile]),
            );
            await denied(() => db.query("select revoke_clinic_member($1)", [member.profile]));
            await denied(() => db.query("select reactivate_clinic_member($1)", [member.profile]));
            await denied(() =>
              db.query("update profiles set role='owner' where id=$1", [member.profile]),
            );
          },
          { user_metadata: { role: "owner" }, app_metadata: { role: "owner" } },
        ),
      );
    await t.test(
      "Recording metadata is tenant-scoped and legacy URLs cannot be selected by any clinic role",
      async () => {
        for (const actor of [
          ...tenants.map((tenant) => ({ user: tenant.user, tenant })),
          ...members,
        ])
          await asUser(db, actor.user, async () => {
            const rows = (await db.query("select id,clinic_id from conversations")).rows;
            assert.equal(rows.length, 1);
            assert.equal(rows[0].clinic_id, actor.tenant.clinic);
            await denied(() => db.query("select recording_url from conversations"));
            const foreign = actor.tenant === a ? b : a;
            assert.equal(
              (await db.query("select id from conversations where clinic_id=$1", [foreign.clinic]))
                .rows.length,
              0,
            );
          });
      },
    );
    await t.test("Audit grants are append-only even for service credentials", () =>
      asRole(db, "service_role", { role: "service_role" }, async () => {
        assert.equal(
          (await db.query("select count(*)::int n from clinic_onboarding_audit")).rows[0].n,
          2,
        );
        for (const table of ["clinic_onboarding_audit", "clinic_membership_audit"]) {
          await denied(() => db.query(`update ${table} set clinic_id=clinic_id`));
          await denied(() => db.query(`delete from ${table}`));
          await denied(() => db.query(`truncate ${table}`));
        }
        await denied(() =>
          db.query(
            "insert into clinic_onboarding_audit(clinic_id,event,reason) values($1,'activated','forged')",
            [a.clinic],
          ),
        );
        await denied(() =>
          db.query("select member_access_original_revoke($1)", [members[1].profile]),
        );
      }),
    );
    await t.test(
      "Real profile guard and audit trigger remain compatible with role/revoke/restore",
      () =>
        asUser(db, a.user, async () => {
          const target = members.find((m) => m.tenant === a && m.role === "staff");
          await db.query("select set_clinic_member_role($1,'manager')", [target.profile]);
          await db.query("select revoke_clinic_member($1)", [target.profile]);
          await db.query("select reactivate_clinic_member($1)", [target.profile]);
          assert.equal(
            (await db.query("select count(*)::int n from clinic_membership_audit")).rows[0].n,
            4,
          );
          for (const foreign of members.filter((m) => m.tenant === b)) {
            await denied(() =>
              db.query("select set_clinic_member_role($1,'staff')", [foreign.profile]),
            );
            await denied(() => db.query("select revoke_clinic_member($1)", [foreign.profile]));
            await denied(() => db.query("select reactivate_clinic_member($1)", [foreign.profile]));
          }
        }),
    );
    await db.query("update clinic_onboarding set lifecycle='suspended' where clinic_id=$1", [
      a.clinic,
    ]);
    await t.test("Suspended retained Owner JWT cannot use definer team RPCs", () =>
      asUser(db, a.user, async () => {
        assert.equal((await db.query("select current_clinic_id() id")).rows[0].id, null);
        assert.equal((await db.query("select * from profiles")).rows.length, 0);
        assert.equal((await db.query("select * from clinic_onboarding")).rows.length, 0);
        for (const target of members.filter((m) => m.tenant === a)) {
          await denied(() =>
            db.query("select set_clinic_member_role($1,'staff')", [target.profile]),
          );
          await denied(() => db.query("select revoke_clinic_member($1)", [target.profile]));
          await denied(() => db.query("select reactivate_clinic_member($1)", [target.profile]));
        }
      }),
    );
    await t.test("Suspended invitations rejected at trusted RPC boundary", () =>
      asRole(db, "service_role", { role: "service_role" }, async () => {
        await denied(() =>
          db.query(
            "select reserve_clinic_invitation($1,null,'pending@example.test','invite',null)",
            [a.user],
          ),
        );
        await denied(() =>
          db.query(
            "select reserve_clinic_invitation(null,$1,'pending@example.test','operator_invite',null)",
            [a.clinic],
          ),
        );
        await denied(() =>
          db.query("select owner_invite_email_available($1,'pending@example.test')", [a.user]),
        );
        await denied(() =>
          db.query(
            "select owner_invite_clinic_member($1,$2,'pending@example.test','Pending','staff')",
            [a.user, uuid(9999)],
          ),
        );
      }),
    );
    await t.test("Other clinic remains authorized", () =>
      asUser(db, b.user, async () => {
        assert.equal((await db.query("select current_clinic_id() id")).rows[0].id, b.clinic);
        assert.equal(
          (await db.query("select count(*)::int n from clinic_team_members()")).rows[0].n,
          3,
        );
      }),
    );
    await t.test("Anonymous clients receive no new table or RPC access", () =>
      asRole(db, "anon", { role: "anon" }, async () => {
        for (const table of [
          "clinic_onboarding",
          "clinic_onboarding_audit",
          "clinic_membership_audit",
        ])
          await denied(() => db.query(`select * from ${table}`));
        await denied(() => db.query("select clinic_activation_readiness(null)"));
        await denied(() => db.query("select reactivate_clinic_member($1)", [members[1].profile]));
      }),
    );
  } finally {
    await db.close();
  }
});
