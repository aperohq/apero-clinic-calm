import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { hasPermission, canAccess } from "../src/lib/permissions.ts";
import {
  createClinicDatabase,
  loadSql,
  tenants,
  uuid,
  asUser,
  asRole,
  attempt,
  productTables,
  internalTables,
} from "./helpers/clinic-database.mjs";

let db;
after(async () => {
  await db?.close();
});
const [a, b] = tenants;
const manager = { user: uuid(301), profile: uuid(302) };
const staff = { user: uuid(401), profile: uuid(402) };
const denied = (sql, values = []) =>
  assert.rejects(
    attempt(db, () => db.query(sql, values)),
    (error) => ["42501", "P0001"].includes(error.code),
  );

test("Owner/Admin/Staff permissions with real PostgreSQL and two clinics", async (t) => {
  db = await createClinicDatabase();
  await loadSql(db, "../tests/fixtures/10_clinic_access_privileges.sql");
  await db.exec(
    await readFile(
      new URL("../tests/fixtures/clinic_role_permissions.sql", import.meta.url),
      "utf8",
    ),
  );
  if (process.env.APERO_TEST_TEAM_MIGRATION === "1")
    await loadSql(db, "../supabase/migrations/20261003160000_clinic_team_management.sql");
  for (const [member, role] of [
    [manager, "manager"],
    [staff, "staff"],
  ]) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [
      member.user,
      `${role}@example.test`,
    ]);
    await db.query(
      "insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values ($1,$2,$3,$4,$5,$6)",
      [member.profile, member.user, a.clinic, role, `${role}@example.test`, role],
    );
  }

  for (const [role, member] of [
    ["owner", { user: a.user, profile: a.profile }],
    ["manager", manager],
    ["staff", staff],
  ]) {
    await t.test(
      `${role}: operational data and own details work; clinic B stays isolated`,
      async () => {
        await asUser(db, member.user, async () => {
          assert.equal((await db.query("select current_profile_role() role")).rows[0].role, role);
          for (const table of productTables) {
            if (internalTables.includes(table)) {
              await denied(`select * from public.${table}`);
            } else {
              const column = table === "clinics" ? "id" : "clinic_id";
              const rows = (await db.query(`select * from public.${table}`)).rows;
              assert.ok(rows.every((row) => row[column] === a.clinic));
              assert.equal(
                (await db.query(`select * from public.${table} where ${column}=$1`, [b.clinic]))
                  .rows.length,
                0,
              );
            }
          }
          for (const table of [
            "clients",
            "staff",
            "staff_availability",
            "staff_time_off",
            "appointments",
            "conversations",
            "client_notes",
          ])
            assert.ok((await db.query(`select * from public.${table}`)).rows.length > 0);
          const ownProfiles = (await db.query("select * from profiles")).rows;
          assert.equal(ownProfiles.length, role === "staff" ? 1 : 3);
          assert.equal(
            (
              await db.query(
                "update profiles set full_name='Personal name' where id=$1 returning id",
                [member.profile],
              )
            ).rows.length,
            1,
          );
          assert.equal(
            (
              await db.query("update clients set phone='+12025550199' where id=$1 returning id", [
                a.client,
              ])
            ).rows.length,
            1,
          );
          assert.equal(
            (
              await db.query(
                "update appointments set status='Cancelled' where id=$1 returning id",
                [a.appointment],
              )
            ).rows.length,
            1,
          );
          await db.query(
            "insert into appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values ($1,$2,$3,'Consultation',now()+interval '40 days',now()+interval '40 days 45 minutes')",
            [a.clinic, a.client, a.staff],
          );
          await db.query(
            "insert into client_notes(clinic_id,client_id,author_profile_id,note) values ($1,$2,$3,'Operational note')",
            [a.clinic, a.client, member.profile],
          );
          await denied("update profiles set role='owner' where id=$1", [member.profile]);
          await denied("update profiles set clinic_id=$1 where id=$2", [b.clinic, member.profile]);
          await denied(
            "insert into appointments(clinic_id,service,start_time,end_time) values ($1,'Forged',now(),now()+interval '45 minutes')",
            [b.clinic],
          );
          assert.equal(
            (
              await db.query(
                "update appointments set status='Cancelled' where id=$1 returning id",
                [b.appointment],
              )
            ).rows.length,
            0,
          );
          assert.equal(
            (await db.query("delete from appointments where id=$1 returning id", [b.appointment]))
              .rows.length,
            0,
          );
          await denied("update appointments set clinic_id=$1 where id=$2", [
            b.clinic,
            a.appointment,
          ]);
        });
      },
    );
    await t.test(
      `${role}: management/configuration rules are enforced on direct SQL requests`,
      async () => {
        await asUser(db, member.user, async () => {
          const manages = role !== "staff";
          assert.equal(
            (
              await db.query("update clinics set name='Clinic setting' where id=$1 returning id", [
                a.clinic,
              ])
            ).rows.length,
            role === "owner" ? 1 : 0,
          );
          assert.equal(
            (
              await db.query(
                "update staff set full_name='Updated practitioner' where id=$1 returning id",
                [a.staff],
              )
            ).rows.length,
            manages ? 1 : 0,
          );
          assert.equal(
            (
              await db.query(
                "update staff_availability set is_available=false where id=$1 returning id",
                [a.availability],
              )
            ).rows.length,
            manages ? 1 : 0,
          );
          assert.equal(
            (
              await db.query(
                "update staff_time_off set reason='Changed leave' where id=$1 returning id",
                [a.timeOff],
              )
            ).rows.length,
            manages ? 1 : 0,
          );
          assert.equal(
            (
              await db.query("update voice_requests set status='Closed' where id=$1 returning id", [
                a.request,
              ])
            ).rows.length,
            manages ? 1 : 0,
          );
          const createClient = () =>
            db.query(
              "insert into clients(clinic_id,full_name,phone) values ($1,'New patient','+12025550198')",
              [a.clinic],
            );
          const createStaff = () =>
            db.query(
              "select create_staff_with_schedule('New practitioner','General','','',array['Consultation'],'[]')",
            );
          if (manages) {
            await createClient();
            await createStaff();
          } else {
            await assert.rejects(attempt(db, createClient), (e) => e.code === "42501");
            await assert.rejects(attempt(db, createStaff), (e) => e.code === "P0001");
          }
          assert.equal(
            (await db.query("delete from appointments where id=$1 returning id", [a.appointment]))
              .rows.length,
            manages ? 1 : 0,
          );
          await denied("insert into conversations(clinic_id,title) values ($1,'Forged call')", [
            a.clinic,
          ]);
          await denied("update voice_integrations set active=false where clinic_id=$1", [a.clinic]);
        });
      },
    );
  }
  await t.test(
    "owner can assign manager/staff idempotently, but cannot modify owners or another clinic",
    async () => {
      await asUser(db, a.user, async () => {
        const before = (await db.query("select * from profiles where id=$1", [staff.profile]))
          .rows[0];
        for (const role of ["manager", "manager", "staff"]) {
          assert.equal(
            (await db.query("select set_clinic_member_role($1,$2) id", [staff.profile, role]))
              .rows[0].id,
            staff.profile,
          );
          assert.equal(
            (await db.query("select role from profiles where id=$1", [staff.profile])).rows[0].role,
            role,
          );
        }
        assert.deepEqual(
          (await db.query("select * from profiles where id=$1", [staff.profile])).rows[0],
          before,
        );
        for (const [profile, role] of [
          [staff.profile, "owner"],
          [a.profile, "staff"],
          [b.profile, "manager"],
          [uuid(999), "staff"],
          [staff.profile, null],
        ])
          await denied("select set_clinic_member_role($1,$2)", [profile, role]);
        await denied("update profiles set role='manager' where id=$1", [staff.profile]);
      });
    },
  );
  await t.test(
    "role changes take effect on existing authenticated claims immediately, including demotion",
    async () => {
      await asUser(db, a.user, async () => {
        await db.query("select set_clinic_member_role($1,'manager')", [staff.profile]);
        const claims = JSON.stringify({ sub: staff.user, role: "authenticated" });
        await db.query("select set_config('request.jwt.claims',$1,true)", [claims]);
        assert.equal(
          (
            await db.query("update staff set full_name='Manager action' where id=$1 returning id", [
              a.staff,
            ])
          ).rows.length,
          1,
        );
        await denied("select set_clinic_member_role($1,'manager')", [manager.profile]);
        await db.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: a.user, role: "authenticated" }),
        ]);
        await db.query("select set_clinic_member_role($1,'staff')", [staff.profile]);
        await db.query("select set_config('request.jwt.claims',$1,true)", [claims]);
        assert.equal(
          (
            await db.query(
              "update staff set full_name='Denied staff action' where id=$1 returning id",
              [a.staff],
            )
          ).rows.length,
          0,
        );
      });
    },
  );
  for (const member of [manager, staff])
    await t.test(
      "non-owners cannot change any role, including with forged owner metadata",
      async () => {
        await asUser(
          db,
          member.user,
          async () => {
            for (const target of [
              member.profile,
              staff.profile,
              manager.profile,
              a.profile,
              b.profile,
            ])
              await denied("select set_clinic_member_role($1,'manager')", [target]);
          },
          { user_metadata: { role: "owner" }, app_metadata: { role: "owner" } },
        );
      },
    );
  await t.test("Clinic B owner cannot access or mutate Clinic A accounts/settings", async () => {
    await asUser(db, b.user, async () => {
      assert.equal((await db.query("select * from profiles")).rows.length, 1);
      await denied("select set_clinic_member_role($1,'manager')", [staff.profile]);
      assert.equal(
        (await db.query("update clinics set name='Attack' where id=$1 returning id", [a.clinic]))
          .rows.length,
        0,
      );
    });
  });
  await t.test(
    "anonymous/unassociated users fail closed; service-role flows remain available",
    async () => {
      await asRole(db, "anon", {}, () =>
        denied("select set_clinic_member_role($1,'manager')", [staff.profile]),
      );
      await asUser(db, uuid(999), () =>
        denied("select set_clinic_member_role($1,'manager')", [staff.profile]),
      );
      await asRole(db, "service_role", { role: "service_role" }, async () => {
        await db.query("update profiles set role='manager' where id=$1", [staff.profile]);
        await db.query("update voice_integrations set active=false where clinic_id=$1", [a.clinic]);
        await db.query("insert into conversations(clinic_id,title) values ($1,'Trusted backend')", [
          a.clinic,
        ]);
      });
    },
  );
});

test("frontend route/action matrix reserves billing/ownership and fails closed", () => {
  for (const role of ["owner", "manager", "staff"]) {
    assert.equal(canAccess(role, "/calendar"), true);
    assert.equal(canAccess(role, "/conversations/record"), true);
    assert.equal(canAccess(role, "/staff/person"), role !== "staff");
    assert.equal(canAccess(role, "/account/billing"), role === "owner");
    assert.equal(canAccess(role, "/account/billing/details"), role === "owner");
    assert.equal(hasPermission(role, "ownership.manage"), role === "owner");
    assert.equal(hasPermission(role, "accounts.manage"), role === "owner");
    assert.equal(hasPermission(role, "analytics.view"), role !== "staff");
    assert.equal(hasPermission(role, "clinic.configure"), role === "owner");
    assert.equal(canAccess(role, "/account/unknown-sensitive-module"), false);
  }
  assert.equal(canAccess(null, "/staff"), false);
  assert.equal(canAccess("admin", "/staff"), false);
});
