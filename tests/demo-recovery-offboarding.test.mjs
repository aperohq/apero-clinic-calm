import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  createClinicDatabase,
  tenants,
  uuid,
  asUser,
  attempt,
} from "./helpers/clinic-database.mjs";
const [a, b] = tenants;
test("recovery enrollment revokes, audit survives, active calls and tenant permissions remain protected", async () => {
  const db = await createClinicDatabase({ team: true });
  const apply = async (name) =>
    db.exec(await readFile(new URL("../supabase/migrations/" + name, import.meta.url), "utf8"));
  try {
    for (const name of [
      "20261006160000_data_retention.sql",
      "20261006161000_retention_lifecycle.sql",
      "20261031120000_demo_call_sessions.sql",
      "20261101120000_demo_call_recovery.sql",
      "20261116120000_retention_guard_fixes.sql",
      "20261120100000_note_author_deletion.sql",
      "20261120102000_sessionless_retention_revocation.sql",
      "20261120103000_demo_offboarding.sql",
    ])
      await apply(name);
    await db.query("insert into demo_recovery_operators(auth_user_id,clinic_id) values($1,$2)", [
      a.user,
      a.clinic,
    ]);
    await db.query(
      "insert into demo_call_recovery_audit(actor_user_id,clinic_id,request_id,outcome) values($1,$2,$3,'requested')",
      [a.user, a.clinic, uuid(901)],
    );
    await assert.rejects(
      db.query("delete from auth.users where id=$1", [a.user]),
      (e) => e.code === "23503",
    );
    await apply("20261121100000_demo_recovery_offboarding.sql");
    await asUser(db, b.user, async () => {
      for (const table of ["demo_recovery_operators", "demo_call_recovery_audit"])
        await assert.rejects(
          attempt(db, () => db.query("select * from " + table)),
          (e) => e.code === "42501",
        );
    });
    await db.query(
      "insert into demo_call_sessions(request_id,clinic_id,auth_user_id,ended) values($1,$2,$3,false)",
      [uuid(902), a.clinic, a.user],
    );
    await assert.rejects(
      db.query("delete from auth.users where id=$1", [a.user]),
      /Finish active demo/,
    );
    await db.query("update demo_call_sessions set ended=true where request_id=$1", [uuid(902)]);
    await db.query("delete from auth.users where id=$1", [a.user]);
    assert.equal(
      (await db.query("select * from demo_recovery_operators where clinic_id=$1", [a.clinic])).rows
        .length,
      0,
    );
    assert.deepEqual(
      (
        await db.query(
          "select actor_user_id,clinic_id,outcome from demo_call_recovery_audit where request_id=$1",
          [uuid(901)],
        )
      ).rows,
      [{ actor_user_id: null, clinic_id: a.clinic, outcome: "requested" }],
    );
    assert.equal(
      (await db.query("select author_profile_id from client_notes where id=$1", [a.note])).rows[0]
        .author_profile_id,
      null,
    );
    assert.ok((await db.query("select id from profiles where id=$1", [b.profile])).rows.length);
  } finally {
    await db.close();
  }
});
