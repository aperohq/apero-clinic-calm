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
const apply = async (db, file) =>
  db.exec(await readFile(new URL("../supabase/migrations/" + file, import.meta.url), "utf8"));
const row = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
test("note FK deletion preserves notes and forbids author/tenant reassignment", async () => {
  const db = await createClinicDatabase({ team: true });
  try {
    // Reproduce the reported failure before applying the repair.
    await assert.rejects(
      db.query("delete from auth.users where id=$1", [a.user]),
      /author, clinic and client/,
    );
    await apply(db, "20261120100000_note_author_deletion.sql");
    await db.exec(`select set_config('request.jwt.claims','{"role":"authenticated"}',false)`);
    for (const sql of [
      "author_profile_id=null",
      `author_profile_id='${b.profile}'`,
      `clinic_id='${b.clinic}'`,
      `client_id='${b.client}'`,
    ])
      await assert.rejects(db.query(`update client_notes set ${sql} where id=$1`, [a.note]));
    await db.exec(`select set_config('request.jwt.claims','{}',false)`);
    await db.query("delete from auth.users where id=$1", [a.user]);
    assert.deepEqual(
      await row(db, "select author_profile_id,note from client_notes where id=$1", [a.note]),
      { author_profile_id: null, note: "Private note" },
    );
    assert.equal(
      (await row(db, "select author_profile_id from client_notes where id=$1", [b.note]))
        .author_profile_id,
      b.profile,
    );
  } finally {
    await db.close();
  }
});
test("request status policy permits owners/managers, denies staff and foreign rows", async () => {
  const db = await createClinicDatabase({ team: true });
  try {
    await apply(db, "20261120101000_voice_requests_status_policy.sql");
    for (const role of ["owner", "manager", "staff"]) {
      await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
      await db.query("update profiles set role=$1 where id=$2", [role, a.profile]);
      await asUser(db, a.user, async () => {
        assert.equal(
          (
            await db.query("update voice_requests set status='Closed' where id=$1 returning id", [
              a.request,
            ])
          ).rows.length,
          role === "staff" ? 0 : 1,
        );
        assert.equal(
          (
            await db.query("update voice_requests set status='Closed' where id=$1 returning id", [
              b.request,
            ])
          ).rows.length,
          0,
        );
        await assert.rejects(
          attempt(db, () =>
            db.query("update voice_requests set reason='tampered' where id=$1", [a.request]),
          ),
          (e) => e.code === "42501",
        );
      });
    }
  } finally {
    await db.close();
  }
});
test("sessionless offboarding and ledger replay revoke only scoped profiles", async () => {
  const db = await createClinicDatabase({ team: true });
  try {
    for (const f of ["20261006160000_data_retention.sql", "20261006161000_retention_lifecycle.sql"])
      await apply(db, f);
    await db.exec(
      "update retention_control set mode='enabled',approved_at=now(),restore_ledger_ready=true",
    );
    await assert.rejects(
      db.query("select retention_begin_offboarding($1)", [a.clinic]),
      (e) => e.code === "42501",
    );
    await apply(db, "20261120102000_sessionless_retention_revocation.sql");
    await db.query("select retention_begin_offboarding($1)", [a.clinic]);
    assert.ok(
      (await row(db, "select revoked_at from profiles where id=$1", [a.profile])).revoked_at,
    );
    assert.equal(
      (await row(db, "select revoked_at from profiles where id=$1", [b.profile])).revoked_at,
      null,
    );
    await db.query("select retention_record($1::uuid,'clinics',($1::uuid)::text,'offboard')", [
      b.clinic,
    ]);
    await db.query("select retention_replay_ledger($1)", [b.clinic]);
    assert.ok(
      (await row(db, "select revoked_at from profiles where id=$1", [b.profile])).revoked_at,
    );
    await asUser(db, a.user, async () => {
      for (const f of ["retention_begin_offboarding", "retention_replay_ledger"])
        await assert.rejects(
          attempt(db, () => db.query(`select ${f}($1)`, [b.clinic])),
          (e) => e.code === "42501",
        );
      assert.equal(
        (
          await db.query("update profiles set revoked_at=null where id=$1 returning id", [
            a.profile,
          ])
        ).rows.length,
        0,
      );
    });
  } finally {
    await db.close();
  }
});
test("completed demo history survives user deletion; active demos block deletion", async () => {
  const db = await createClinicDatabase({ team: true });
  try {
    for (const f of [
      "20261006160000_data_retention.sql",
      "20261006161000_retention_lifecycle.sql",
      "20261031120000_demo_call_sessions.sql",
      "20261120100000_note_author_deletion.sql",
      "20261120103000_demo_offboarding.sql",
    ])
      await apply(db, f);
    await db.query(
      "insert into demo_call_sessions(request_id,clinic_id,auth_user_id) values($1,$2,$3)",
      [uuid(900), a.clinic, a.user],
    );
    await assert.rejects(
      db.query("delete from auth.users where id=$1", [a.user]),
      (e) => e.code === "23503",
    );
    await db.query("update demo_call_sessions set ended=true where request_id=$1", [uuid(900)]);
    await db.query("delete from auth.users where id=$1", [a.user]);
    assert.deepEqual(
      await row(
        db,
        "select auth_user_id,clinic_id,ended from demo_call_sessions where request_id=$1",
        [uuid(900)],
      ),
      { auth_user_id: null, clinic_id: a.clinic, ended: true },
    );
  } finally {
    await db.close();
  }
});
test("stale Booked eligibility respects recent edits, future work and preservation", async () => {
  const db = await createClinicDatabase({ team: true });
  try {
    for (const f of [
      "20261006160000_data_retention.sql",
      "20261006161000_retention_lifecycle.sql",
      "20261120111000_stale_appointment_retention.sql",
    ])
      await apply(db, f);
    for (const [n, status, end, edit, preserve] of [
      [910, "Booked", 800, 800, null],
      [911, "Booked", 800, 1, null],
      [912, "Booked", -1, 800, null],
      [913, "Booked", 800, 800, "infinity"],
      [914, "Cancelled", 800, 800, null],
      [915, "Completed", 800, 800, null],
      [916, "No Show", 800, 800, null],
    ]) {
      await db.query(
        `insert into appointments(id,clinic_id,service,start_time,end_time,status,updated_at,retention_preserve_until)
    values($1,$2,'Consultation',now()-make_interval(days=>$3+1),now()-make_interval(days=>$3),$4,now()-make_interval(days=>$5),$6)`,
        [uuid(n), a.clinic, end, status, edit, preserve],
      );
    }
    await assert.rejects(
      db.query("delete from appointments where id=$1", [uuid(913)]),
      (e) => e.code === "23503",
    );
    const ids = (
      await db.query(
        "select resource_key from retention_candidates where category='appointment' and clinic_id=$1",
        [a.clinic],
      )
    ).rows.map((x) => x.resource_key);
    assert.deepEqual(ids.sort(), [910, 914, 915, 916].map(uuid).sort());
    await db.query("update appointments set client_id=$1 where id=$2", [a.client, uuid(910)]);
    assert.equal(
      (
        await db.query(
          "select resource_key from retention_candidates where category='appointment' and resource_key=$1",
          [uuid(910)],
        )
      ).rows.length,
      0,
    );
    await asUser(db, a.user, async () => {
      await assert.rejects(
        attempt(db, () =>
          db.query("update appointments set retention_preserve_until=null where id=$1", [
            uuid(913),
          ]),
        ),
        (e) => e.code === "42501",
      );
    });
  } finally {
    await db.close();
  }
});
test("voice practitioner reschedule uses eligible staff and shared availability", async () => {
  const db = await createClinicDatabase({ appointments: true });
  try {
    await apply(db, "20261120104000_voice_practitioner_reschedule.sql");
    await apply(db, "20261120105000_bounded_availability_search.sql");
    await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await db.query("update clients set phone='+96512345678' where id=$1", [a.client]);
    const target = uuid(920);
    await db.query(
      "insert into staff(id,clinic_id,full_name,specialty,services) values($1,$2,'Second Practitioner','General',array['Consultation'])",
      [target, a.clinic],
    );
    await db.query(
      "insert into staff_availability(clinic_id,staff_id,day_of_week) values($1,$2,1)",
      [a.clinic, target],
    );
    const day = (
      await row(
        db,
        "select (date '2040-01-02'+((8-extract(dow from date '2040-01-02')::int)%7))::text as selected_day",
      )
    ).selected_day;
    const slots = (
      await db.query("select * from appointment_search_slots($1,$2,$3,$4,30)", [
        a.clinic,
        [target],
        "Consultation",
        day,
      ])
    ).rows;
    const preferred = (
      await db.query(
        "select * from appointment_search_slots($1,$2,$3,$4,1,null,null,null,'15:45'::time)",
        [a.clinic, [a.staff, target], "Consultation", day],
      )
    ).rows;
    assert.ok(preferred.length <= 12);
    assert.ok(
      preferred.some((slot) => new Date(slot.start_time).toISOString().includes("T15:45:")),
    );
    assert.ok(slots.length > 0);
    assert.equal(slots[0].duration_minutes, 45);
    const slot = slots[0],
      check = uuid(921),
      slotId = uuid(922),
      call = "practitioner-change";
    await db.query(
      "insert into voice_call_state(call_id,clinic_id,current_check_id) values($1,$2,$3)",
      [call, a.clinic, check],
    );
    await db.query(
      "insert into voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at) values($1,$2,$3,$4,$5,'Consultation',$6,$7,now()+interval '1 hour')",
      [slotId, check, call, a.clinic, target, slot.start_time, slot.end_time],
    );
    const args = [
      "reschedule",
      a.clinic,
      "reschedule-practitioner-operation",
      call,
      a.appointment,
      "Patient",
      "+96512345678",
      null,
      null,
      target,
      "Consultation",
      slot.start_time,
      slot.end_time,
      check,
      slotId,
    ];
    const result = await row(
      db,
      "select voice_apply_appointment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) result",
      args,
    );
    assert.equal(result.result.success, true);
    assert.equal(
      (await row(db, "select staff_id from appointments where id=$1", [a.appointment])).staff_id,
      target,
    );
    await db.query("update staff set services=array['Other'] where id=$1", [target]);
    assert.equal(
      (
        await db.query("select * from appointment_search_slots($1,$2,$3,$4,30)", [
          a.clinic,
          [target],
          "Consultation",
          day,
        ])
      ).rows.length,
      0,
    );
    for (const days of [0, 31])
      await assert.rejects(
        db.query("select * from appointment_search_slots($1,$2,$3,$4,$5)", [
          a.clinic,
          [target],
          "Consultation",
          day,
          days,
        ]),
        (e) => e.code === "22023",
      );
    await asUser(db, b.user, async () => {
      await assert.rejects(
        attempt(db, () =>
          db.query("select * from appointment_search_slots($1,$2,$3,$4,1)", [
            a.clinic,
            [target],
            "Consultation",
            day,
          ]),
        ),
        (e) => e.code === "42501",
      );
    });
  } finally {
    await db.close();
  }
});
test("indexed phone lookup finds late clients and keeps tenant matches distinct", async () => {
  const db = await createClinicDatabase({ appointments: true });
  try {
    await apply(db, "20261120110000_phone_lookup.sql");
    await db.query(
      "insert into clients(clinic_id,full_name,phone) select $1,'Synthetic '||n,'555'||lpad(n::text,5,'0') from generate_series(1,1100)n",
      [a.clinic],
    );
    const lateClient = uuid(925);
    await db.query(
      "insert into clients(id,clinic_id,full_name,phone) values($1,$2,'Late Synthetic Patient','1234 5678')",
      [lateClient, a.clinic],
    );
    await db.query("update clients set phone='+96512345678' where id=$1", [b.client]);
    const results = (
      await db.query("select * from clinic_clients_by_phone($1,$2)", [a.clinic, "0096512345678"])
    ).rows;
    assert.equal(results.length, 1);
    assert.equal(results[0].id, lateClient);
    await asUser(db, a.user, () =>
      assert.rejects(
        attempt(db, () =>
          db.query("select * from clinic_clients_by_phone($1,$2)", [b.clinic, "12345678"]),
        ),
        (e) => e.code === "42501",
      ),
    );
  } finally {
    await db.close();
  }
});
