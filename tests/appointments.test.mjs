import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createClinicDatabase,
  tenants,
  asUser,
  asRole,
  attempt,
  uuid,
  loadSql,
} from "./helpers/clinic-database.mjs";

const [a, b] = tenants;
const date = "2040-01-02";
const start = `${date}T06:00:00Z`; // 9 AM Kuwait
const end = `${date}T06:45:00Z`;
const id = uuid(900);
async function slots(db, tenant = a, excluded = null, onDate = date) {
  return (
    await db.query("select * from appointment_available_slots($1,$2,'Consultation',$3,$4)", [
      tenant.clinic,
      tenant.staff,
      onDate,
      excluded,
    ])
  ).rows;
}
async function book(
  db,
  tenant = a,
  appointment = id,
  begin = start,
  finish = end,
  client = tenant.client,
  staff = tenant.staff,
  service = "Consultation",
) {
  return db.query(
    `insert into appointments(id,clinic_id,client_id,staff_id,service,start_time,end_time,notes)
    values ($1,$2,$3,$4,$5,$6,$7,'Original notes') returning *`,
    [appointment, tenant.clinic, client, staff, service, begin, finish],
  );
}

test("shared appointments in local PostgreSQL, without production access", async (t) => {
  const db = await createClinicDatabase({ appointments: true });
  try {
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ role: "service_role" }),
    ]);
    await db.query("update clinics set timezone='Asia/Kuwait' where id=$1", [a.clinic]);
    await db.query(
      "update clients set full_name='Existing Patient',phone='+965 9912 3456' where id=$1",
      [a.client],
    );
    await db.query(
      "update voice_integrations set dialing_prefix='+965',local_number_length=8,slot_minutes=45 where clinic_id=$1",
      [a.clinic],
    );
    await db.exec(`delete from staff_availability where staff_id='${a.staff}';
      insert into staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time)
      select '${a.clinic}','${a.staff}',d,'09:00','17:00' from generate_series(0,6) d;`);
    await t.test("migration is idempotent and retains RLS policies", async () => {
      const before = await db.query(
        "select tablename,policyname,qual,with_check from pg_policies order by tablename,policyname",
      );
      await loadSql(
        db,
        "../supabase/migrations/20261002190000_shared_appointment_availability.sql",
      );
      assert.deepEqual(
        (
          await db.query(
            "select tablename,policyname,qual,with_check from pg_policies order by tablename,policyname",
          )
        ).rows,
        before.rows,
      );
    });
    for (const role of ["owner", "manager", "staff"]) {
      await db.query("update profiles set role=$1 where id=$2", [role, a.profile]);
      await t.test(
        `${role}: shared slots, linked booking, conflict, reschedule, cancellation`,
        () =>
          asUser(db, a.user, async () => {
            const initial = await slots(db);
            assert.equal(new Date(initial[0].start_time).toISOString(), "2040-01-02T06:00:00.000Z");
            assert.equal(initial[0].duration_minutes, 45);
            const patients = (await db.query("select count(*)::int n from clients")).rows[0].n;
            const created = (await book(db)).rows[0];
            assert.equal(created.client_id, a.client);
            assert.equal(
              (await db.query("select count(*)::int n from clients")).rows[0].n,
              patients,
            );
            assert.equal(
              (await db.query("select id from appointments where id=$1", [id])).rows.length,
              1,
            );
            assert.equal((await slots(db)).length, initial.length - 1);
            await assert.rejects(
              attempt(db, () => book(db, a, uuid(901))),
              /unavailable|conflict|exclusion/i,
            );
            // Self exclusion permits same time; relationship/duration retained.
            assert.equal((await slots(db, a, id)).length, initial.length);
            const destination = initial[2];
            await db.query("update appointments set start_time=$1,end_time=$2 where id=$3", [
              destination.start_time,
              destination.end_time,
              id,
            ]);
            const moved = (await db.query("select * from appointments where id=$1", [id])).rows[0];
            assert.equal(moved.client_id, created.client_id);
            assert.equal(moved.staff_id, created.staff_id);
            assert.equal(moved.service, created.service);
            assert.equal(moved.source, created.source);
            assert.equal(
              (await db.query("select count(*)::int n from appointments where id=$1", [id])).rows[0]
                .n,
              1,
            );
            await book(db, a, uuid(902));
            await assert.rejects(
              attempt(db, () =>
                db.query("update appointments set start_time=$1,end_time=$2 where id=$3", [
                  start,
                  end,
                  id,
                ]),
              ),
              /unavailable|conflict/i,
            );
            assert.equal(
              Date.parse(
                (await db.query("select start_time from appointments where id=$1", [id])).rows[0]
                  .start_time,
              ),
              Date.parse(destination.start_time),
            );
            await db.query("update appointments set status='Cancelled' where id=$1", [id]);
            const cancelled = (await db.query("select * from appointments where id=$1", [id]))
              .rows[0];
            assert.equal(cancelled.notes, "Original notes");
            assert.equal(cancelled.status, "Cancelled");
            assert.ok(
              (await slots(db)).some(
                (s) => Date.parse(s.start_time) === Date.parse(destination.start_time),
              ),
            );
            await assert.rejects(
              attempt(db, () =>
                db.query("update appointments set status='Booked' where id=$1", [id]),
              ),
              /Only booked/i,
            );
          }),
      );
    }
    await t.test(
      "exclusion constraint is the final conflict boundary even without the schedule trigger",
      async () => {
        await db.exec("begin");
        try {
          await book(db);
          await db.exec("alter table appointments disable trigger guard_appointment_booking");
          await assert.rejects(
            attempt(db, () => book(db, a, uuid(901))),
            /exclusion constraint/i,
          );
          await db.query("update appointments set status='Cancelled' where id=$1", [id]);
          await book(db, a, uuid(901));
        } finally {
          await db.exec("rollback");
        }
      },
    );
    await t.test("configured AI duration is also the dashboard slot duration", async () => {
      await db.exec("begin");
      try {
        await db.query("update voice_integrations set slot_minutes=60 where clinic_id=$1", [
          a.clinic,
        ]);
        const ranges = await slots(db);
        assert.equal(ranges[0].duration_minutes, 60);
        assert.equal(Date.parse(ranges[0].end_time) - Date.parse(ranges[0].start_time), 3600000);
        await assert.rejects(
          attempt(db, () => book(db)),
          /duration/i,
        );
        await book(db, a, id, ranges[0].start_time, ranges[0].end_time);
      } finally {
        await db.exec("rollback");
      }
    });
    await t.test(
      "reschedule rejects relationship or duration changes and cancellation cannot move records",
      () =>
        asUser(db, a.user, async () => {
          await book(db);
          for (const patch of [
            "service='Unknown'",
            "end_time=end_time+interval '15 minutes'",
            "id='" + uuid(999) + "'",
            "status='Cancelled',start_time=start_time+interval '1 hour',end_time=end_time+interval '1 hour'",
          ]) {
            await assert.rejects(
              attempt(db, () => db.exec(`update appointments set ${patch} where id='${id}'`)),
              /preserve|identity/i,
            );
          }
          await db.query(
            "update appointments set status='Cancelled',notes=notes || E'\\nCancellation: Patient request' where id=$1",
            [id],
          );
          assert.equal(
            (await db.query("select notes from appointments where id=$1", [id])).rows[0].notes,
            "Original notes\nCancellation: Patient request",
          );
        }),
    );
    await t.test(
      "schedule, time off, inactive staff, unsupported service, invalid duration and overnight rejection",
      () =>
        asUser(db, a.user, async () => {
          await assert.rejects(
            attempt(db, () => book(db, a, id, `${date}T05:00Z`, `${date}T05:45Z`)),
            /unavailable/i,
          );
          await assert.rejects(
            attempt(db, () => book(db, a, id, start, end, a.client, a.staff, "Foreign service")),
            /unavailable/i,
          );
          await assert.rejects(
            attempt(db, () => book(db, a, id, start, `${date}T07:00Z`)),
            /duration/i,
          );
          await assert.rejects(
            attempt(db, () => book(db, a, id, `${date}T20:45Z`, `${date}T21:30Z`)),
            /unavailable/i,
          );
          assert.deepEqual(
            (
              await db.query("select * from appointment_available_slots($1,$2,'Unknown',$3,null)", [
                a.clinic,
                a.staff,
                date,
              ])
            ).rows,
            [],
          );
        }),
    );
    await db.query(
      "insert into staff_time_off(clinic_id,staff_id,start_time,end_time) values($1,$2,$3,$4)",
      [a.clinic, a.staff, start, end],
    );
    await t.test("time off is reflected by real discovery and rejects a stale selected slot", () =>
      asUser(db, a.user, async () => {
        assert.ok(!(await slots(db)).some((s) => Date.parse(s.start_time) === Date.parse(start)));
        await assert.rejects(
          attempt(db, () => book(db)),
          /unavailable/i,
        );
      }),
    );
    await db.query("delete from staff_time_off where staff_id=$1", [a.staff]);
    await db.query("update staff set active=false where id=$1", [a.staff]);
    await t.test("inactive practitioner cannot offer or accept bookings", () =>
      asUser(db, a.user, async () => {
        assert.deepEqual(await slots(db), []);
        await assert.rejects(
          attempt(db, () => book(db)),
          /unavailable/i,
        );
      }),
    );
    await db.query("update staff set services=array['Consultation','Clinic B only'] where id=$1", [
      b.staff,
    ]);
    await db.query("update staff set active=true where id=$1", [a.staff]);
    for (const role of ["owner", "manager", "staff"]) {
      await db.query("update profiles set role=$1 where id=$2", [role, a.profile]);
      await t.test(
        `${role}: cross-clinic reads, writes, cancellation, reschedule and foreign references rejected`,
        () =>
          asUser(db, a.user, async () => {
            assert.deepEqual(
              (await db.query("select * from appointments where clinic_id=$1", [b.clinic])).rows,
              [],
            );
            for (const patch of [
              "status='Cancelled'",
              "start_time=start_time+interval '1 hour',end_time=end_time+interval '1 hour'",
            ]) {
              assert.equal(
                (
                  await db.query(`update appointments set ${patch} where id=$1 returning id`, [
                    b.appointment,
                  ])
                ).rows.length,
                0,
              );
            }
            await assert.rejects(
              attempt(db, () => slots(db, b)),
              /access denied/i,
            );
            await assert.rejects(
              attempt(db, () => book(db, b)),
              /row-level|access denied|unavailable/i,
            );
            await assert.rejects(
              attempt(db, () => book(db, a, id, start, end, b.client)),
              /clinic|reference|client/i,
            );
            await assert.rejects(
              attempt(db, () => book(db, a, id, start, end, a.client, b.staff)),
              /clinic|reference|unavailable/i,
            );
            await assert.rejects(
              attempt(db, () => book(db, a, id, start, end, a.client, a.staff, "Clinic B only")),
              /unavailable/i,
            );
            await assert.rejects(
              attempt(db, () => slots(db, a, b.appointment)),
              /unavailable/i,
            );
          }),
      );
    }
    await t.test(
      "AI books existing patient into the calendar table; dashboard changes affect AI slots",
      () =>
        asRole(db, "service_role", { role: "service_role" }, async () => {
          const check = uuid(950),
            slot = uuid(951),
            call = "appointment-integration-test";
          await db.query(
            "insert into voice_call_state(call_id,clinic_id,current_check_id) values($1,$2,$3)",
            [call, a.clinic, check],
          );
          await db.query(
            `insert into voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at)
        values($1,$2,$3,$4,$5,'Consultation',$6,$7,now()+interval '1 hour')`,
            [slot, check, call, a.clinic, a.staff, start, end],
          );
          const { rows } = await db.query(
            `select voice_apply_appointment('book',$1,'appointment-integration-key',$2,null,
        'Existing Patient','+96599123456',null,null,$3,'Consultation',$4,$5,$6,$7) result`,
            [a.clinic, call, a.staff, start, end, check, slot],
          );
          assert.equal(rows[0].result.success, true, JSON.stringify(rows[0].result));
          const aiId = rows[0].result.appointment_id;
          const ai = (await db.query("select * from appointments where id=$1", [aiId])).rows[0];
          assert.equal(ai.client_id, a.client);
          assert.equal(ai.source, "Booked by Apero");
          assert.ok(!(await slots(db)).some((s) => Date.parse(s.start_time) === Date.parse(start)));
          await db.exec("set local role authenticated");
          await db.query("select set_config('request.jwt.claims',$1,true)", [
            JSON.stringify({ sub: a.user, role: "authenticated" }),
          ]);
          assert.equal(
            (await db.query("select id from appointments where id=$1", [aiId])).rows.length,
            1,
          );
          const destination = (await slots(db))[0];
          await book(db, a, id, destination.start_time, destination.end_time);
          await db.exec("set local role service_role");
          await db.query("select set_config('request.jwt.claims',$1,true)", [
            JSON.stringify({ role: "service_role" }),
          ]);
          assert.equal(
            (await db.query("select id from appointments where id=$1", [id])).rows.length,
            1,
          );
          assert.ok(
            !(await slots(db)).some(
              (s) => Date.parse(s.start_time) === Date.parse(destination.start_time),
            ),
          );
          await db.query("update appointments set status='Cancelled' where id=$1", [id]);
          assert.ok(
            (await slots(db)).some(
              (s) => Date.parse(s.start_time) === Date.parse(destination.start_time),
            ),
          );
        }),
    );
    await t.test("DST transitions return valid wall times and exact real durations", async () => {
      await db.query("update clinics set timezone='America/New_York' where id=$1", [a.clinic]);
      await db.query(
        "update staff_availability set start_time='01:00',end_time='05:00' where staff_id=$1",
        [a.staff],
      );
      await asUser(db, a.user, async () => {
        const spring = await slots(db, a, null, "2040-03-11");
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
        for (const s of spring) {
          assert.equal(Date.parse(s.end_time) - Date.parse(s.start_time), 45 * 60000);
          assert.ok(!fmt.format(new Date(s.start_time)).startsWith("02:"));
        }
        assert.ok(spring.length > 0);
      });
    });
    await t.test("read-only production readiness inventory executes locally", async () => {
      const result = await loadSql(db, "audits/appointment_readiness.sql");
      assert.ok(result.length >= 10);
    });
    await t.test("anonymous callers cannot discover appointment slots", () =>
      asRole(db, "anon", { role: "anon" }, async () => {
        await assert.rejects(
          attempt(db, () => slots(db)),
          /permission denied/i,
        );
      }),
    );
  } finally {
    await db.close();
  }
});
