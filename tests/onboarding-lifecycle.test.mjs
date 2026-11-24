import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  createClinicDatabase,
  tenants,
  uuid,
  asUser,
  asRole,
  attempt,
} from "./helpers/clinic-database.mjs";

const [a, b] = tenants;
const apply = async (db, filename) =>
  db.exec(await readFile(new URL(`../supabase/migrations/${filename}`, import.meta.url), "utf8"));
const applyOnboarding = async (db) => {
  for (const file of [
    "20261124100000_clinic_onboarding.sql",
    "20261124102000_clinic_activation.sql",
    "20261124110000_clinic_member_reactivation.sql",
    "20261124111000_suspended_team_management.sql",
  ])
    await apply(db, file);
};
const scopedTables = ["clients", "staff", "appointments", "client_notes", "conversations"];

test("offboarding denies retained sessions for every clinic role and preserves the other tenant", async () => {
  const db = await createClinicDatabase({ settings: true, appointments: true });
  try {
    for (const file of [
      "20261006160000_data_retention.sql",
      "20261006161000_retention_lifecycle.sql",
      "20261120102000_sessionless_retention_revocation.sql",
    ])
      await apply(db, file);
    await applyOnboarding(db);
    const users = [a.user];
    for (const [index, role] of ["manager", "staff"].entries()) {
      const user = uuid(830 + index);
      users.push(user);
      await db.query("insert into auth.users(id,email) values($1,$2)", [
        user,
        `${role}@example.test`,
      ]);
      await db.query(
        "insert into profiles(auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3,$4,$5)",
        [user, a.clinic, role, `${role}@example.test`, role],
      );
    }
    // Retention remains opt-in, even for the maintenance database owner.
    await assert.rejects(
      db.query("select retention_begin_offboarding($1)", [a.clinic]),
      /approval/i,
    );
    await db.exec(
      "update retention_control set mode='enabled',approved_at=now(),restore_ledger_ready=true",
    );
    await db.query("select retention_begin_offboarding($1)", [a.clinic]);
    for (const user of users) {
      await asUser(
        db,
        user,
        async () => {
          // Stale access tokens and role metadata cannot restore a revoked membership.
          for (const table of scopedTables) {
            assert.equal(
              (await db.query(`select id from ${table}`)).rows.length,
              0,
              `${table}: revoked ${user}`,
            );
          }
          assert.equal((await db.query("select current_clinic_id() id")).rows[0].id, null);
          await assert.rejects(
            attempt(db, () => db.query("select retention_begin_offboarding($1)", [b.clinic])),
            (e) => e.code === "42501",
          );
          assert.equal(
            (
              await db.query(
                "update profiles set full_name='restore attempt' where auth_user_id=$1 returning id",
                [user],
              )
            ).rows.length,
            0,
          );
        },
        { app_metadata: { role: "owner", clinic_id: b.clinic } },
      );
    }
    await asUser(db, b.user, async () => {
      for (const table of scopedTables) {
        const rows = (await db.query(`select clinic_id from ${table}`)).rows;
        assert.ok(rows.length > 0);
        assert.ok(rows.every((row) => row.clinic_id === b.clinic));
      }
    });
    const first = (
      await db.query("select requested_at,grace_until from clinic_offboarding where clinic_id=$1", [
        a.clinic,
      ])
    ).rows[0];
    await db.query("select retention_begin_offboarding($1)", [a.clinic]);
    assert.deepEqual(
      (
        await db.query(
          "select requested_at,grace_until from clinic_offboarding where clinic_id=$1",
          [a.clinic],
        )
      ).rows[0],
      first,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from profiles where clinic_id=$1 and revoked_at is not null",
          [a.clinic],
        )
      ).rows[0].n,
      3,
    );
  } finally {
    await db.close();
  }
});

test("retention controls and audit ledger cannot be changed by browser or service credentials", async () => {
  const db = await createClinicDatabase({ settings: true, appointments: true });
  try {
    await apply(db, "20261006160000_data_retention.sql");
    await apply(db, "20261006161000_retention_lifecycle.sql");
    await apply(db, "20261120102000_sessionless_retention_revocation.sql");
    await applyOnboarding(db);
    for (const role of ["anon", "authenticated", "service_role"]) {
      await asRole(db, role, { role, sub: a.user }, async () => {
        for (const sql of [
          "update retention_control set mode='enabled',approved_at=now(),restore_ledger_ready=true",
          "insert into clinic_retention(clinic_id,legal_hold) values($1,true)",
          "delete from retention_deletion_ledger where clinic_id=$1",
          "select retention_begin_offboarding($1)",
          "select retention_ack_ledger(array[$1::uuid])",
          "select retention_replay_ledger($1)",
        ])
          await assert.rejects(
            attempt(db, () => db.query(sql, sql.includes("$1") ? [a.clinic] : [])),
            (e) => e.code === "42501",
            `${role}: ${sql}`,
          );
      });
    }
    await db.exec(
      "update retention_control set mode='enabled',approved_at=now(),restore_ledger_ready=true",
    );
    await db.query("insert into clinic_retention(clinic_id,legal_hold) values($1,true)", [
      a.clinic,
    ]);
    await db.query(
      "insert into clinic_offboarding(clinic_id,state,grace_until,telephony_stopped_verified,provider_inventory_verified) values($1,'grace',now()-interval '1 day',true,true)",
      [a.clinic],
    );
    assert.equal(
      (await db.query("select retention_run_clinic($1,false,100) result", [a.clinic])).rows[0]
        .result.state,
      "held",
    );
    await assert.rejects(
      db.query("select retention_offboard_batch($1,false,100)", [a.clinic]),
      /Legal hold/,
    );
    assert.equal(
      (await db.query("select count(*)::int n from retention_deletion_ledger")).rows[0].n,
      0,
    );
    assert.equal(
      (await db.query("select count(*)::int n from clinics where id=$1", [a.clinic])).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});

test("author removal preserves historical notes without permitting reassignment", async () => {
  const db = await createClinicDatabase({ settings: true, appointments: true });
  try {
    await apply(db, "20261120100000_note_author_deletion.sql");
    await applyOnboarding(db);
    await asUser(db, a.user, async () => {
      for (const update of [
        "author_profile_id=null",
        `author_profile_id='${b.profile}'`,
        `clinic_id='${b.clinic}'`,
        `client_id='${b.client}'`,
      ]) {
        await assert.rejects(
          attempt(db, () => db.query(`update client_notes set ${update} where id=$1`, [a.note])),
          (e) => e.code === "42501",
        );
      }
    });
    const original = (
      await db.query("select clinic_id,client_id,note,created_at from client_notes where id=$1", [
        a.note,
      ])
    ).rows[0];
    await db.query("delete from auth.users where id=$1", [a.user]);
    assert.deepEqual(
      (
        await db.query("select clinic_id,client_id,note,created_at from client_notes where id=$1", [
          a.note,
        ])
      ).rows[0],
      original,
    );
    assert.equal(
      (await db.query("select author_profile_id from client_notes where id=$1", [a.note])).rows[0]
        .author_profile_id,
      null,
    );
    assert.equal(
      (await db.query("select author_profile_id from client_notes where id=$1", [b.note])).rows[0]
        .author_profile_id,
      b.profile,
    );
  } finally {
    await db.close();
  }
});
