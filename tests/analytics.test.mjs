import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createClinicDatabase,
  tenants,
  asUser,
  asRole,
  uuid,
  productTables,
  attempt,
} from "./helpers/clinic-database.mjs";

const db = await createClinicDatabase({ team: true });
const [a, b] = tenants;
const migration = await readFile(
  new URL("../supabase/migrations/20261004120000_clinic_analytics.sql", import.meta.url),
  "utf8",
);
const policiesBefore = (
  await db.query(
    "select schemaname,tablename,policyname,cmd,qual,with_check from pg_policies order by schemaname,tablename,policyname",
  )
).rows;
const rowsBeforeMigration = await snapshot();
const functionsBefore = (
  await db.query(
    "select oid::regprocedure::text signature,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace order by oid::regprocedure::text",
  )
).rows;
await db.exec(migration);
assert.deepEqual(await snapshot(), rowsBeforeMigration);
assert.deepEqual(
  (
    await db.query(
      "select oid::regprocedure::text signature,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname <> 'clinic_analytics' order by oid::regprocedure::text",
    )
  ).rows,
  functionsBefore,
);
assert.equal(
  (
    await db.query(
      "select has_function_privilege('anon','public.clinic_analytics(uuid,date,date)','EXECUTE') allowed",
    )
  ).rows[0].allowed,
  false,
);
assert.equal(
  (
    await db.query(
      "select has_function_privilege('service_role','public.clinic_analytics(uuid,date,date)','EXECUTE') allowed",
    )
  ).rows[0].allowed,
  false,
);

assert.deepEqual(
  (
    await db.query(
      "select schemaname,tablename,policyname,cmd,qual,with_check from pg_policies order by schemaname,tablename,policyname",
    )
  ).rows,
  policiesBefore,
);
await db.query("select set_config('request.jwt.claims', $1, false)", [
  JSON.stringify({ role: "service_role" }),
]);
const call = async (conn, clinic = a.clinic, start = "2026-10-01", end = "2026-10-07") =>
  (
    await conn.query("select public.clinic_analytics($1::uuid,$2::date,$3::date) data", [
      clinic,
      start,
      end,
    ])
  ).rows[0].data;
async function snapshot() {
  const result = {};
  for (const table of productTables)
    result[table] = (
      await db.query(`select to_jsonb(t) r from public.${table} t order by to_jsonb(t)::text`)
    ).rows;
  return result;
}
try {
  await db.query("update public.clinics set timezone=$1 where id=$2", ["Asia/Kuwait", a.clinic]);
  // Move seed rows out of the deterministic window.
  await db.exec(
    `update public.appointments set start_time='2027-01-01',end_time='2027-01-01 01:00'; update public.conversations set started_at='2027-01-01';`,
  );
  const insertCall = async (id, instant) =>
    db.query("insert into public.conversations(id,clinic_id,started_at) values($1,$2,$3)", [
      uuid(id),
      a.clinic,
      instant,
    ]);
  await insertCall(800, "2026-09-30T20:59:59Z"); // Excluded before local midnight.
  await insertCall(801, "2026-09-30T21:00:00Z");
  await insertCall(802, "2026-10-07T20:59:59Z");
  await insertCall(803, "2026-10-07T21:00:00Z"); // Excluded at next local midnight.
  for (const [id, status, staff, service, instant] of [
    [810, "Booked", a.staff, "Consultation", "2026-09-30T21:00:00Z"],
    [811, "Cancelled", a.staff, "Consultation", "2026-10-01T10:00:00Z"],
    [812, "Legacy", null, "Other service", "2026-10-07T20:59:59Z"],
    [813, "Booked", a.staff, "Consultation", "2026-10-07T21:00:00Z"],
  ])
    await db.query(
      "insert into public.appointments(id,clinic_id,client_id,staff_id,service,start_time,end_time,status) values($1,$2,$3,$4,$5,$6,$6::timestamptz+interval '30 minutes',$7)",
      [uuid(id), a.clinic, a.client, staff, service, instant, status],
    );
  await db.exec("begin read only; set local role authenticated");
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: a.user, role: "authenticated" }),
    ]);
    assert.equal((await call(db)).totalCalls, 2);
  } finally {
    await db.exec("rollback");
  }
  const before = await snapshot();
  const result = await asUser(db, a.user, (c) => call(c));
  assert.equal(result.totalCalls, 2);
  assert.equal(result.totalAppointments, 3);
  assert.equal(result.bookedAppointments, 1);
  assert.equal(result.cancelledAppointments, 1);
  assert.equal(result.otherAppointments, 1);
  assert.equal(result.trend.length, 7);
  assert.deepEqual(result.trend[0], { date: "2026-10-01", calls: 1, appointments: 2 });
  assert.deepEqual(result.trend[6], { date: "2026-10-07", calls: 1, appointments: 1 });
  assert.equal(result.trend[1].calls, 0);
  assert.deepEqual(result.services, [
    { label: "Consultation", count: 2 },
    { label: "Other service", count: 1 },
  ]);
  assert.equal(result.practitioners[0].count, 2);
  assert.equal(result.practitioners[1].label, "Unassigned");
  const oneDay = await asUser(db, a.user, (c) => call(c, a.clinic, "2026-10-01", "2026-10-01"));
  assert.equal(oneDay.totalCalls, 1);
  assert.equal(oneDay.totalAppointments, 2);
  await asUser(db, a.user, async (c) => {
    for (const clinic of [b.clinic, uuid(999), null])
      await assert.rejects(() => attempt(c, () => call(c, clinic)), /Not authorized/);
  });
  await asUser(db, b.user, async (c) => {
    const r = await call(c, b.clinic);
    assert.equal(r.totalCalls, 0);
    assert.equal(r.totalAppointments, 0);
    assert.equal(r.trend.length, 7);
  });
  for (const [start, end] of [
    [null, "2026-10-07"],
    ["2026-10-01", null],
    ["2026-10-07", "2026-10-01"],
    ["2026-01-01", "2026-10-01"],
    ["1999-12-31", "2000-01-01"],
    ["bad", "2026-10-07"],
  ])
    await asUser(db, a.user, (c) => assert.rejects(() => call(c, a.clinic, start, end)));
  for (const role of ["manager", "staff"]) {
    await db.query("update public.profiles set role=$1 where id=$2", [role, a.profile]);
    await asUser(
      db,
      a.user,
      async (c) =>
        role === "manager"
          ? assert.equal((await call(c)).totalCalls, 2)
          : assert.rejects(() => call(c), /Not authorized/),
      { clinic_id: b.clinic, user_metadata: { role: "owner" }, app_metadata: { role: "owner" } },
    );
  }
  await db.query("update public.profiles set role='owner',revoked_at=now() where id=$1", [
    a.profile,
  ]);
  await asUser(db, a.user, (c) => assert.rejects(() => call(c), /Not authorized/));
  await asRole(db, "anon", {}, (c) => assert.rejects(() => call(c), /permission denied/));
  await asRole(db, "authenticated", {}, (c) => assert.rejects(() => call(c), /Not authorized/));
  await db.query("update public.profiles set revoked_at=null where id=$1", [a.profile]);
  assert.deepEqual(await snapshot(), before, "Analytics leaves all product rows unchanged");
  // Calls-only and appointments-only windows.
  await asUser(db, a.user, async (c) => {
    const calls = await call(c, a.clinic, "2026-09-30", "2026-09-30");
    assert.equal(calls.totalCalls, 1);
    assert.equal(calls.totalAppointments, 0);
    const visits = await call(c, a.clinic, "2026-10-01", "2026-10-01");
    assert.equal(visits.totalAppointments, 2);
  });
  await db.query("update public.conversations set started_at='2027-01-01' where clinic_id=$1", [
    a.clinic,
  ]);
  await asUser(db, a.user, async (c) => {
    const r = await call(c);
    assert.equal(r.totalCalls, 0);
    assert.equal(r.totalAppointments, 3);
  });
  // Real PostgreSQL timezone conversion over 23/25-hour DST days.
  for (const [date, start, end] of [
    ["2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
  ]) {
    await db.query("update public.clinics set timezone='America/New_York' where id=$1", [a.clinic]);
    await db.query("update public.conversations set started_at=$1::timestamptz where id=$2", [
      start,
      uuid(801),
    ]);
    await db.query(
      "update public.conversations set started_at=$1::timestamptz-interval '1 second' where id=$2",
      [end, uuid(802)],
    );
    await db.query("update public.conversations set started_at=$1::timestamptz where id=$2", [
      end,
      uuid(803),
    ]);
    await asUser(db, a.user, async (c) =>
      assert.equal((await call(c, a.clinic, date, date)).totalCalls, 2),
    );
  }
  // Bounded breakdowns retain their remaining counts.
  for (let i = 0; i < 25; i++)
    await db.query(
      "insert into public.appointments(clinic_id,service,start_time,end_time) values($1,$2,'2026-10-02T12:00Z','2026-10-02T13:00Z')",
      [a.clinic, `Service ${i}`],
    );
  await asUser(db, a.user, async (c) => {
    const r = await call(c);
    assert.equal(r.services.length, 20);
    assert.equal(
      r.services.reduce((n, s) => n + s.count, 0) + r.otherServiceAppointments,
      r.totalAppointments,
    );
  });
  // Same display name does not merge distinct practitioner IDs. Deletion
  // preserves the appointment and moves its reference into Unassigned.
  for (const id of [850, 851])
    await db.query(
      "insert into public.staff(id,clinic_id,full_name,specialty) values($1,$2,'Same Name','General')",
      [uuid(id), a.clinic],
    );
  for (const [id, staff, service] of [
    [852, 850, "Case"],
    [853, 851, "case"],
    [854, 851, "Case"],
    [855, 850, ""],
  ])
    await db.query(
      "insert into public.appointments(id,clinic_id,staff_id,service,start_time,end_time) values($1,$2,$3,$4,'2026-10-03T12:00Z','2026-10-03T13:00Z')",
      [uuid(id), a.clinic, uuid(staff), service],
    );
  await asUser(db, a.user, async (c) => {
    const r = await call(c);
    const same = r.practitioners.filter((p) => p.label === "Same Name");
    assert.equal(same.length, 2);
    assert.deepEqual(new Set(same.map((p) => p.id)), new Set([uuid(850), uuid(851)]));
    assert.ok(same.every((p) => p.count === 2));
  });
  await db.query("delete from public.staff where id=$1", [uuid(850)]);
  await asUser(db, a.user, async (c) => {
    const r = await call(c, a.clinic, "2026-10-03", "2026-10-03");
    assert.equal(r.practitioners.find((p) => p.id === null).count, 2);
    assert.equal(r.practitioners.find((p) => p.id === uuid(851)).count, 2);
    assert.deepEqual(r.services, [
      { label: "Case", count: 2 },
      { label: "", count: 1 },
      { label: "case", count: 1 },
    ]);
  });
  await db.query("update public.clinics set timezone='Asia/Kuwait' where id=$1", [a.clinic]);
  for (const days of [7, 30, 90]) {
    const end = "2026-10-07";
    const start = new Date(end + "T12:00:00Z");
    start.setUTCDate(start.getUTCDate() - days + 1);
    await asUser(db, a.user, async (c) => {
      const r = await call(c, a.clinic, start.toISOString().slice(0, 10), end);
      assert.equal(r.trend.length, days);
      assert.equal(
        r.trend.reduce((n, d) => n + d.calls, 0),
        r.totalCalls,
      );
      assert.equal(
        r.trend.reduce((n, d) => n + d.appointments, 0),
        r.totalAppointments,
      );
      assert.equal(
        r.bookedAppointments + r.cancelledAppointments + r.otherAppointments,
        r.totalAppointments,
      );
      assert.equal(
        r.practitioners.reduce((n, p) => n + p.count, 0) + r.otherPractitionerAppointments,
        r.totalAppointments,
      );
      const raw = (
        await c.query(
          "select count(*) n from public.appointments where clinic_id=$1 and (start_time at time zone 'Asia/Kuwait')::date between $2::date and $3::date",
          [a.clinic, r.startDate, end],
        )
      ).rows[0];
      assert.equal(Number(raw.n), r.totalAppointments);
    });
  }
  // Legacy NULL timezone cannot silently convert the range into empty results.
  // This schema loosening exists only inside this disposable test database.
  await db.exec("alter table public.clinics alter column timezone drop not null");
  for (const zone of [null, "", "Invalid/Zone"]) {
    await db.query("update public.clinics set timezone=$1 where id=$2", [zone, a.clinic]);
    await asUser(db, a.user, (c) =>
      assert.rejects(() => call(c), /Clinic timezone is unavailable/),
    );
  }
  await db.query("update public.clinics set timezone='Asia/Kuwait' where id=$1", [a.clinic]);
  await db.exec("alter table public.clinics alter column timezone set not null");
  const indexes = (
    await db.query(
      "select indexname from pg_indexes where tablename in ('appointments','conversations')",
    )
  ).rows.map((r) => r.indexname);
  assert.ok(indexes.includes("appointments_clinic_idx"));
  assert.ok(indexes.includes("conversations_clinic_idx"));
  assert.match(migration, /stable security invoker/);
  assert.doesNotMatch(
    migration,
    /create\s+policy|alter\s+table|insert\s+into|update\s+public|delete\s+from/i,
  );
  console.log(
    "PASS analytics: metrics, filtering, empty/calls-only/appointments-only, timezone/DST, Owner/Manager/Staff, revoked, anonymous, forged claims/IDs, isolation, malformed ranges, bounded groups, read-only",
  );
} finally {
  await db.close();
}
