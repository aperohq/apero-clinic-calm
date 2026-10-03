import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createClinicDatabase,
  tenants,
  uuid,
  asUser,
  attempt,
  loadSql,
} from "./helpers/clinic-database.mjs";
const [a, b] = tenants;
let db;
const second = uuid(8100),
  third = uuid(8101),
  manager = uuid(8102),
  staff = uuid(8103);
after(async () => db?.close());
const reserve = (actor, email, action = "invite", profile = null, clinic = null) =>
  db
    .query("select reserve_clinic_invitation($1,$2,$3,$4,$5) value", [
      actor,
      clinic,
      email,
      action,
      profile,
    ])
    .then((r) => r.rows[0].value);
const finish = (token) => db.query("select finish_clinic_invitation($1)", [token]);
const reset = () =>
  db.exec("delete from clinic_invitation_claims;delete from clinic_invitation_budgets");
const age = (email) =>
  db.query(
    "update clinic_invitation_claims set last_attempt_at=clock_timestamp()-interval '61 seconds',lease_until=null where email=$1",
    [email],
  );
test("Shared invitation authority, cooldown, persistent claims and concurrent admission", async (t) => {
  db = await createClinicDatabase({ team: true, appointments: true });
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ role: "service_role" }),
  ]);
  for (const [id, role] of [
    [second, "owner"],
    [third, "owner"],
    [manager, "manager"],
    [staff, "staff"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, id + "@example.test"]);
    await db.query(
      "insert into profiles(auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3::text,$4,$3::text::profile_role)",
      [id, a.clinic, role, id + "@example.test"],
    );
  }
  await t.test(
    "Anonymous/authenticated direct private RPCs and tables remain inaccessible",
    async () => {
      for (const user of [a.user, manager, staff])
        await asUser(db, user, async () => {
          await assert.rejects(
            attempt(db, () => reserve(a.user, "direct@example.test")),
            (e) => e.code === "42501",
          );
          await assert.rejects(
            attempt(db, () => db.query("select * from clinic_invitation_claims")),
            (e) => e.code === "42501",
          );
          await assert.rejects(
            attempt(db, () => finish(uuid(9))),
            (e) => e.code === "42501",
          );
        });
      const acl = (
        await db.query(
          "select has_function_privilege('anon','reserve_clinic_invitation(uuid,uuid,text,text,uuid)','execute') allowed",
        )
      ).rows[0];
      assert.equal(acl.allowed, false);
    },
  );
  await t.test(
    "Manager, Staff, revoked Owner and supplied foreign clinic fail admission",
    async () => {
      await reset();
      for (const actor of [manager, staff])
        assert.equal((await reserve(actor, "denied@example.test")).code, "not_authorized");
      assert.equal(
        (await reserve(a.user, "denied@example.test", "invite", null, b.clinic)).code,
        "not_authorized",
      );
      await db.query("update profiles set revoked_at=now() where auth_user_id=$1", [second]);
      assert.equal((await reserve(second, "denied@example.test")).code, "not_authorized");
      await db.query("update profiles set revoked_at=null where auth_user_id=$1", [second]);
      assert.equal(
        (await db.query("select count(*)::int n from clinic_invitation_claims")).rows[0].n,
        0,
      );
    },
  );
  await t.test(
    "Owner budget allows 30 attempts/hour, blocks the 31st and resets after the window",
    async () => {
      await reset();
      for (let i = 0; i < 30; i++)
        assert.equal((await reserve(a.user, `owner-${i}@example.test`)).code, "ready");
      assert.equal((await reserve(a.user, "owner-over@example.test")).code, "rate_limited");
      assert.equal((await reserve(second, "other-owner@example.test")).code, "ready");
      await db.exec(
        "update clinic_invitation_budgets set window_start=now()-interval '61 minutes'",
      );
      assert.equal((await reserve(a.user, "owner-reset@example.test")).code, "ready");
    },
  );
  await t.test(
    "Clinic budget spans Owners: 60 attempts/hour, then rejects another Owner",
    async () => {
      await reset();
      for (const actor of [a.user, second])
        for (let i = 0; i < 30; i++)
          assert.equal((await reserve(actor, `clinic-${actor}-${i}@example.test`)).code, "ready");
      assert.equal((await reserve(third, "clinic-over@example.test")).code, "rate_limited");
      assert.equal((await reserve(b.user, "other-clinic@example.test")).code, "ready");
    },
  );
  await t.test(
    "Normalized target budget spans Owners: five generations/hour, then fail closed",
    async () => {
      await reset();
      for (let i = 0; i < 5; i++) {
        const r = await reserve(i % 2 ? second : a.user, " Target-Budget@EXAMPLE.test ");
        assert.equal(r.code, "ready");
        await finish(r.token);
        await age("target-budget@example.test");
      }
      assert.equal((await reserve(a.user, "target-budget@example.test")).code, "rate_limited");
      assert.equal(
        (await reserve(b.user, "target-budget@example.test")).code,
        "invite_unavailable",
      );
    },
  );
  await t.test(
    "Concurrent new-email cross-clinic requests grant exactly one persistent claim",
    async () => {
      await reset();
      const results = await Promise.all([
        reserve(a.user, "race@example.test"),
        reserve(b.user, "RACE@example.test"),
      ]);
      assert.equal(results.filter((r) => r.code === "ready").length, 1);
      assert.equal(results.filter((r) => r.code === "invite_unavailable").length, 1);
      const winner = results.find((r) => r.code === "ready");
      const user = uuid(8200);
      await db.query(
        "insert into auth.users(id,email,invited_at) values($1,'race@example.test',now())",
        [user],
      );
      const loser = winner.clinic_id === a.clinic ? b : a;
      await db.exec("begin;savepoint foreign_insert");
      await assert.rejects(
        attempt(db, () =>
          db.query(
            "insert into profiles(auth_user_id,clinic_id,full_name,email,role) values($1,$2,'Foreign','race@example.test','staff')",
            [user, loser.clinic],
          ),
        ),
        (e) => e.code === "42501",
      );
      await db.exec("rollback");
      const actor = winner.clinic_id === a.clinic ? a : b;
      await db.query(
        "select owner_invite_clinic_member($1,$2,'race@example.test','Winner','staff')",
        [actor.user, user],
      );
      assert.equal(
        (await db.query("select * from profiles where auth_user_id=$1", [user])).rows.length,
        1,
      );
      assert.equal(
        (await db.query("select clinic_id from profiles where auth_user_id=$1", [user])).rows[0]
          .clinic_id,
        winner.clinic_id,
      );
      await finish(winner.token);
      await age("race@example.test");
      assert.equal((await reserve(loser.user, "race@example.test")).code, "invite_unavailable");
    },
  );
  await t.test(
    "Concurrent same-clinic requests admit one attempt and cannot create duplicates",
    async () => {
      await reset();
      const results = await Promise.all([
        reserve(a.user, "same@example.test"),
        reserve(second, "SAME@example.test"),
      ]);
      assert.equal(results.filter((r) => r.code === "ready").length, 1);
      assert.equal(results.filter((r) => r.code === "invite_recent").length, 1);
    },
  );
  await t.test(
    "Resend cooldown is atomic and expires; concurrent resends admit exactly one",
    async () => {
      await reset();
      const user = uuid(8201),
        profile = uuid(8202),
        email = "cooldown@example.test";
      const first = await reserve(a.user, email);
      assert.equal(first.code, "ready");
      await db.query("insert into auth.users(id,email,invited_at) values($1,$2,now())", [
        user,
        email,
      ]);
      await db.query(
        "insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3,'Pending',$4,'manager')",
        [profile, user, a.clinic, email],
      );
      await finish(first.token);
      assert.equal((await reserve(a.user, null, "resend", profile)).code, "invite_recent");
      await age(email);
      const results = await Promise.all([
        reserve(a.user, null, "resend", profile),
        reserve(second, null, "resend", profile),
      ]);
      assert.equal(results.filter((r) => r.code === "ready").length, 1);
      assert.equal(results.filter((r) => r.code === "invite_recent").length, 1);
      assert.equal(results.find((r) => r.code === "ready").role, "manager");
    },
  );
  await t.test(
    "Expired attempt lease never transfers ownership; stale cleanup cannot clear a newer attempt",
    async () => {
      await reset();
      const old = await reserve(a.user, "lease@example.test");
      await age("lease@example.test");
      assert.equal((await reserve(b.user, "lease@example.test")).code, "invite_unavailable");
      const retry = await reserve(a.user, "lease@example.test");
      assert.equal(retry.code, "ready");
      await finish(old.token);
      assert.equal((await reserve(second, "lease@example.test")).code, "invite_recent");
    },
  );
  await t.test(
    "Verified external account is generic for Owner and reserved only for explicit operator association",
    async () => {
      await reset();
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,'external@example.test',now())",
        [uuid(8203)],
      );
      assert.equal((await reserve(a.user, "external@example.test")).code, "invite_unavailable");
      const operator = await reserve(
        null,
        "external@example.test",
        "operator_associate",
        null,
        b.clinic,
      );
      assert.equal(operator.code, "ready");
      assert.equal((await reserve(a.user, "external@example.test")).code, "invite_unavailable");
    },
  );
  await t.test(
    "Operator and Owner share email serialization; old direct foreign insert is denied",
    async () => {
      await reset();
      const operator = await reserve(
        null,
        "operator-race@example.test",
        "operator_invite",
        null,
        b.clinic,
      );
      assert.equal(operator.code, "ready");
      assert.equal(
        (await reserve(a.user, "operator-race@example.test")).code,
        "invite_unavailable",
      );
    },
  );
  await t.test("Migration reapplication preserves claims, budgets and existing users", async () => {
    const before = (await db.query("select * from clinic_invitation_claims order by email")).rows;
    await loadSql(db, "../supabase/migrations/20261003160000_clinic_team_management.sql");
    assert.deepEqual(
      (await db.query("select * from clinic_invitation_claims order by email")).rows,
      before,
    );
  });
});
