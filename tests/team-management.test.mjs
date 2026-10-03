import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createClinicDatabase,
  loadSql,
  tenants,
  uuid,
  asUser,
  asRole,
  attempt,
  portalTables,
  internalTables,
} from "./helpers/clinic-database.mjs";
const [a, b] = tenants;
let db;
after(async () => {
  await db?.close();
});
const manager = { user: uuid(501), profile: uuid(502) },
  staff = { user: uuid(601), profile: uuid(602) },
  secondOwner = { user: uuid(701), profile: uuid(702) };
const service = async (fn) => {
  await db.exec("begin; set local role service_role");
  await db.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ role: "service_role" }),
  ]);
  try {
    const result = await fn();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
};
const denied = (fn) => assert.rejects(attempt(db, fn), (e) => ["42501", "P0001"].includes(e.code));
const roleChange = (id, role) => db.query("select set_clinic_member_role($1,$2)", [id, role]);
const revoke = (id) => db.query("select revoke_clinic_member($1)", [id]);
const invite = (actor, user, email, role = "staff") =>
  db.query("select owner_invite_clinic_member($1,$2,$3,$4,$5) id", [
    actor,
    user,
    email,
    "Invited Member",
    role,
  ]);

test("Team management database acceptance uses real PostgreSQL, RLS and retained JWT claims", async (t) => {
  db = await createClinicDatabase({ team: true, appointments: true });
  for (const [member, role] of [
    [manager, "manager"],
    [staff, "staff"],
    [secondOwner, "owner"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [
      member.user,
      role + member.user + "@example.test",
    ]);
    await db.query(
      "insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3,$4,$5,$6)",
      [member.profile, member.user, a.clinic, role, role + member.user + "@example.test", role],
    );
  }
  const history = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "staff",
          "staff_availability",
          "staff_time_off",
          "appointments",
          "conversations",
          "client_notes",
          "notifications",
        ].map(async (table) => [
          table,
          (await db.query("select * from " + table + " order by id")).rows,
        ]),
      ),
    );
  const before = await history();
  for (const [member, role, size] of [
    [{ user: a.user }, "owner", 4],
    [manager, "manager", 4],
    [staff, "staff", 1],
  ])
    await t.test(role + " directory and own-profile behavior", () =>
      asUser(db, member.user, async () => {
        assert.equal((await db.query("select * from profiles")).rows.length, size);
        if (role === "staff") await denied(() => db.query("select * from clinic_team_members()"));
        else {
          const rows = (await db.query("select * from clinic_team_members()")).rows;
          assert.equal(rows.length, 4);
          assert.ok(
            rows.every((r) => !Object.keys(r).some((k) => /token|password|auth_user_id/.test(k))),
          );
        }
      }),
    );
  for (const role of ["manager", "staff"])
    await t.test("Owner invites " + role + " through service-only actor-checked RPC", async () => {
      const user = uuid(role === "manager" ? 801 : 802),
        email = role + "-invite@example.test";
      await db.query("insert into auth.users(id,email,invited_at) values($1,$2,now())", [
        user,
        email,
      ]);
      await service(async () => {
        const id = (await invite(a.user, user, email, role)).rows[0].id;
        const p = (await db.query("select * from profiles where id=$1", [id])).rows[0];
        assert.equal(p.role, role);
        assert.equal(p.clinic_id, a.clinic);
        assert.equal(p.revoked_at, null);
        assert.equal((await invite(a.user, user, email, role)).rows[0].id, id);
      });
      await asUser(db, a.user, async () => {
        const pending = (
          await db.query("select * from clinic_team_members() where email=$1", [email])
        ).rows[0];
        assert.equal(pending.invite_status, "pending");
      });
      await db.query("update auth.users set email_confirmed_at=now() where id=$1", [user]);
      await asUser(db, a.user, async () => {
        assert.equal(
          (await db.query("select * from clinic_team_members() where email=$1", [email])).rows[0]
            .invite_status,
          "accepted",
        );
      });
    });
  await t.test(
    "Invitation rejects Owner role, unverified identities, foreign membership and forged service actors",
    async () => {
      const unlinked = uuid(901);
      await db.query("insert into auth.users(id,email) values($1,'available@example.test')", [
        unlinked,
      ]);
      await service(async () => {
        await denied(() => invite(a.user, unlinked, "available@example.test", "owner"));
        await denied(() => invite(manager.user, unlinked, "available@example.test"));
        await denied(() => invite(staff.user, unlinked, "available@example.test"));
        await denied(() => invite(a.user, unlinked, "wrong@example.test"));
        await denied(() => invite(a.user, b.user, b.user + "@example.test"));
      });
      for (const user of [a.user, manager.user, staff.user])
        await asUser(db, user, async () => {
          await denied(() => invite(a.user, unlinked, "available@example.test"));
        });
    },
  );
  await t.test(
    "Owner changes Manager/Staff both ways; Owner, self and foreign targets remain protected",
    () =>
      asUser(db, a.user, async () => {
        for (const role of ["staff", "manager"]) {
          await roleChange(manager.profile, role);
          assert.equal(
            (await db.query("select role from profiles where id=$1", [manager.profile])).rows[0]
              .role,
            role,
          );
        }
        for (const [id, role] of [
          [manager.profile, "owner"],
          [a.profile, "staff"],
          [secondOwner.profile, "staff"],
          [b.profile, "staff"],
        ])
          await denied(() => roleChange(id, role));
        for (const id of [a.profile, secondOwner.profile, b.profile, uuid(999)])
          await denied(() => revoke(id));
      }),
  );
  for (const member of [manager, staff])
    await t.test("Non-owner cannot call role/revoke RPCs directly or forge Owner metadata", () =>
      asUser(
        db,
        member.user,
        async () => {
          await denied(() => roleChange(staff.profile, "manager"));
          await denied(() => revoke(staff.profile));
          await denied(() =>
            db.query("update profiles set revoked_at=now() where id=$1", [member.profile]),
          );
        },
        { user_metadata: { role: "owner" }, app_metadata: { role: "owner" } },
      ),
    );
  await t.test("Clinic B Owner cannot manage Clinic A accounts", () =>
    asUser(db, b.user, async () => {
      assert.ok(
        !(await db.query("select * from clinic_team_members()")).rows.some(
          (r) => r.id === staff.profile,
        ),
      );
      await denied(() => roleChange(staff.profile, "manager"));
      await denied(() => revoke(staff.profile));
    }),
  );
  await t.test(
    "Revocation retains profile/Auth/history while same preexisting session loses reads, writes and slot access",
    async () => {
      // Commit access revocation as a real authenticated Owner transaction.
      await db.exec("begin;set local role authenticated");
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: a.user, role: "authenticated" }),
      ]);
      await revoke(staff.profile);
      await db.exec("commit");
      assert.ok(
        (await db.query("select revoked_at from profiles where id=$1", [staff.profile])).rows[0]
          .revoked_at,
      );
      assert.equal(
        (await db.query("select id from auth.users where id=$1", [staff.user])).rows.length,
        1,
      );
      await asUser(
        db,
        staff.user,
        async () => {
          const helpers = (
            await db.query(
              "select current_clinic_id() clinic,current_profile_id() profile,current_profile_role() role",
            )
          ).rows[0];
          assert.deepEqual(helpers, { clinic: null, profile: null, role: null });
          for (const table of portalTables) {
            assert.equal((await db.query("select * from " + table)).rows.length, 0, table);
          }
          for (const table of internalTables)
            await denied(() => db.query("select * from " + table));
          assert.equal(
            (await db.query("update clients set phone=phone returning id")).rows.length,
            0,
          );
          assert.equal(
            (await db.query("update appointments set status='Cancelled' returning id")).rows.length,
            0,
          );
          assert.equal((await db.query("delete from appointments returning id")).rows.length, 0);
          await denied(() =>
            db.query(
              "insert into appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values($1,$2,$3,'Consultation','2030-01-07T09:00Z','2030-01-07T09:45Z')",
              [a.clinic, a.client, a.staff],
            ),
          );
          await denied(() =>
            db.query(
              "select * from appointment_available_slots($1,$2,'Consultation','2030-01-07',null)",
              [a.clinic, a.staff],
            ),
          );
          await denied(() => roleChange(manager.profile, "manager"));
          await denied(() => revoke(manager.profile));
          await denied(() =>
            db.query("update profiles set revoked_at=null where id=$1", [staff.profile]),
          );
        },
        { user_metadata: { role: "owner", clinic_id: a.clinic } },
      );
      await asUser(db, a.user, async () => {
        await revoke(staff.profile);
        await denied(() => roleChange(staff.profile, "manager"));
        assert.equal(
          (await db.query("select * from clinic_team_members() where id=$1", [staff.profile]))
            .rows[0].invite_status,
          "revoked",
        );
      });
    },
  );
  await t.test(
    "Account operations never create/delete practitioners or rewrite clinical history",
    async () => {
      assert.deepEqual(await history(), before);
    },
  );
  await t.test("Existing scheduling and appointment lifecycle still works for active Manager", () =>
    asUser(db, manager.user, async () => {
      const profileCount = (await db.query("select count(*)::int n from profiles")).rows[0].n;
      await db.query(
        "select create_staff_with_schedule('Separate Practitioner','General','','',array['Consultation'],'[]')",
      );
      assert.equal(
        (await db.query("select count(*)::int n from profiles")).rows[0].n,
        profileCount,
      );
      await db.query(
        "update staff set specialty='General', services=array['Consultation'] where id=$1",
        [a.staff],
      );
      const slots = (
        await db.query(
          "select * from appointment_available_slots($1,$2,'Consultation','2030-01-07',null)",
          [a.clinic, a.staff],
        )
      ).rows;
      assert.ok(slots.length > 1);
      const appt = (
        await db.query(
          "insert into appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values($1,$2,$3,'Consultation',$4,$5) returning id",
          [a.clinic, a.client, a.staff, slots[0].start_time, slots[0].end_time],
        )
      ).rows[0];
      await db.query("update appointments set start_time=$1,end_time=$2 where id=$3", [
        slots[1].start_time,
        slots[1].end_time,
        appt.id,
      ]);
      await db.query("update appointments set status='Cancelled' where id=$1", [appt.id]);
      assert.ok(
        (
          await db.query(
            "select * from appointment_available_slots($1,$2,'Consultation','2030-01-07',null)",
            [a.clinic, a.staff],
          )
        ).rows.some((s) => String(s.start_time) === String(slots[1].start_time)),
      );
      await db.query("update staff set active=false where id=$1", [a.staff]);
      assert.equal(
        (
          await db.query(
            "select * from appointment_available_slots($1,$2,'Consultation','2030-01-07',null)",
            [a.clinic, a.staff],
          )
        ).rows.length,
        0,
      );
      await db.query("update staff set active=true where id=$1", [a.staff]);
      const off = (
        await db.query(
          "insert into staff_time_off(clinic_id,staff_id,start_time,end_time,reason) values($1,$2,$3,$4,$5) returning id",
          [a.clinic, a.staff, slots[0].start_time, slots[0].end_time, "Leave"],
        )
      ).rows[0];
      assert.ok(
        !(
          await db.query(
            "select * from appointment_available_slots($1,$2,'Consultation','2030-01-07',null)",
            [a.clinic, a.staff],
          )
        ).rows.some((s) => String(s.start_time) === String(slots[0].start_time)),
      );
      await db.query("delete from staff_time_off where id=$1", [off.id]);
      await db.query("update staff_availability set is_available=false where id=$1", [
        a.availability,
      ]);
      assert.equal(
        (
          await db.query(
            "select * from appointment_available_slots($1,$2,'Consultation','2030-01-07',null)",
            [a.clinic, a.staff],
          )
        ).rows.length,
        0,
      );
    }),
  );
  await t.test("Migration is idempotent and does not restore revoked access", async () => {
    await loadSql(db, "../supabase/migrations/20261003160000_clinic_team_management.sql");
    assert.ok(
      (await db.query("select revoked_at from profiles where id=$1", [staff.profile])).rows[0]
        .revoked_at,
    );
  });
});
