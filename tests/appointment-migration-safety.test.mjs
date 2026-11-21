import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createClinicDatabase,
  loadSql,
  asUser,
  attempt,
  tenants,
  uuid,
} from "./helpers/clinic-database.mjs";
const [a, b] = tenants;
const migration = "../supabase/migrations/20261002190000_shared_appointment_availability.sql";
const migrationSql = await readFile(
  new URL(
    "../supabase/migrations/20261002190000_shared_appointment_availability.sql",
    import.meta.url,
  ),
  "utf8",
);
const readinessSql = await readFile(
  new URL("../db/audits/appointment_readiness.sql", import.meta.url),
  "utf8",
);
const nextId = (() => {
  let n = 2000;
  return () => uuid(++n);
})();
async function fixture(
  db,
  {
    id = nextId(),
    clinic = a.clinic,
    client = a.client,
    staff = a.staff,
    start = "2000-01-03T02:00Z",
    end = "2000-01-03T03:00Z",
    status = "Booked",
    service = "Consultation",
  } = {},
) {
  await db.query(
    `insert into appointments(id,clinic_id,client_id,staff_id,service,start_time,end_time,status,notes)
 values($1,$2,$3,$4,$5,$6,$7,$8,'Legacy note')`,
    [id, clinic, client, staff, service, start, end, status],
  );
  return id;
}
async function snapshot(db) {
  return (await db.query("select * from appointments order by id")).rows;
}
async function apis(db) {
  return (
    await db.query(
      "select proname,pg_get_functiondef(oid) def,proacl::text acl from pg_proc where pronamespace='public'::regnamespace order by proname,oid",
    )
  ).rows;
}
async function failedInstall(db, pattern, ids = []) {
  const before = await snapshot(db),
    functions = await apis(db);
  let error;
  try {
    await db.exec(migrationSql);
  } catch (e) {
    error = e;
  } finally {
    await db.exec("rollback");
  }
  assert.ok(error, "migration must abort");
  assert.match(error.message, pattern);
  for (const id of ids) assert.ok(error.detail?.includes(id), `operator must receive ID ${id}`);
  assert.deepEqual(await snapshot(db), before);
  assert.deepEqual(
    await apis(db),
    functions,
    "failed transaction must not replace/install functions",
  );
  return error;
}
async function rollbackCase(db, run) {
  await db.exec("begin");
  try {
    await run();
  } finally {
    await db.exec("rollback");
  }
}
async function slots(db, appointment = null, date = "2040-01-02") {
  return (
    await db.query("select * from appointment_available_slots($1,$2,'Consultation',$3,$4)", [
      a.clinic,
      a.staff,
      date,
      appointment,
    ])
  ).rows;
}

test("deployment preflight rejects incompatible history before structural changes", async (t) => {
  const db = await createClinicDatabase();
  try {
    await loadSql(db, "10_clinic_access_privileges.sql");
    await t.test(
      "historical overlapping records abort with both appointment IDs and full rollback",
      async () => {
        const one = await fixture(db, { start: "1999-01-01T09:00Z", end: "1999-01-01T10:00Z" });
        const two = await fixture(db, { start: "1999-01-01T09:30Z", end: "1999-01-01T10:30Z" });
        await failedInstall(db, /preflight: historical overlaps/i, [one, two]);
        const reports = await db.exec(readinessSql);
        assert.ok(
          reports.some((r) =>
            r.rows.some((row) => row.appointment_a === one && row.appointment_b === two),
          ),
        );
        await db.query("delete from appointments where id=any($1::uuid[])", [[one, two]]); // ephemeral test fixtures only
      },
    );
    await t.test(
      "non-cancelled reversed and infinite intervals abort with record IDs",
      async () => {
        for (const range of [
          { start: "1998-01-01T10:00Z", end: "1998-01-01T09:00Z" },
          { start: "-infinity", end: "infinity" },
        ]) {
          const id = await fixture(db, range);
          await failedInstall(db, /preflight: non-cancelled reversed or non-finite/i, [id]);
          await db.query("delete from appointments where id=$1", [id]);
        }
      },
    );
    await t.test(
      "historical cancellation variants are detected, never normalized or exempted",
      async () => {
        for (const status of ["cancelled", "CANCELLED", " Cancelled ", "Canceled", "canceled"]) {
          const id = await fixture(db, { status });
          await failedInstall(db, /noncanonical cancellation statuses/i, [id]);
          assert.equal(
            (await db.query("select status from appointments where id=$1", [id])).rows[0].status,
            status,
          );
          await db.query("delete from appointments where id=$1", [id]);
        }
      },
    );
    await t.test(
      "no overlaps, cancelled overlaps, zero intervals, overnight and unsupported legacy service preserve history",
      async () => {
        await fixture(db, {
          status: "Cancelled",
          start: "1997-01-01T09:00Z",
          end: "1997-01-01T10:00Z",
        });
        await fixture(db, {
          status: "Cancelled",
          start: "1997-01-01T09:30Z",
          end: "1997-01-01T10:30Z",
        });
        await fixture(db, {
          status: "Cancelled",
          start: "1996-01-01T10:00Z",
          end: "1996-01-01T09:00Z",
        });
        await fixture(db, { start: "1995-01-01T10:00Z", end: "1995-01-01T10:00Z" });
        await fixture(db, {
          start: "1994-01-01T23:30Z",
          end: "1994-01-02T00:30Z",
          staff: null,
          client: null,
          service: "",
        });
        const before = await snapshot(db);
        await loadSql(db, migration);
        assert.deepEqual(await snapshot(db), before);
        assert.equal(
          (
            await db.query(
              "select count(*)::int n from pg_constraint where conrelid='appointments'::regclass and conname='appointments_shared_no_overlap' and contype='x'",
            )
          ).rows[0].n,
          1,
        );
      },
    );
  } finally {
    await db.close();
  }
});

test("legacy safe updates, exact duration contract, FK behavior and secured writes", async (t) => {
  const db = await createClinicDatabase();
  try {
    await loadSql(db, "10_clinic_access_privileges.sql");
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ role: "service_role" }),
    ]);
    const zero = await fixture(db, { start: "1993-01-01T10:00Z", end: "1993-01-01T10:00Z" });
    const reversed = await fixture(db, {
      status: "Cancelled",
      start: "1992-01-01T10:00Z",
      end: "1992-01-01T09:00Z",
    });
    const infinite = await fixture(db, {
      status: "Cancelled",
      start: "-infinity",
      end: "infinity",
    });
    const whole = await fixture(db, { start: "2040-01-02T09:00Z", end: "2040-01-02T10:30Z" });
    const fractional = await fixture(db, {
      start: "2040-01-03T09:00Z",
      end: "2040-01-03T09:45:30Z",
    });
    const microseconds = await fixture(db, {
      start: "2040-01-04T09:00Z",
      end: "2040-01-04T09:45:00.000001Z",
    });
    await db.exec(`insert into staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time)
 select '${a.clinic}','${a.staff}',d,'09:00','17:00' from generate_series(0,6)d where d<>1;`);
    await loadSql(db, migration);
    for (const role of ["owner", "manager", "staff"]) {
      await t.test(
        `${role}: guard permits actual cancellation of reversed legacy history without repairing times`,
        () =>
          rollbackCase(db, async () => {
            await db.query("update profiles set role=$1 where id=$2", [role, a.profile]);
            // Local-only fault injection: deployment preflight would reject this
            // active reversed row. Exercise the trigger ordering independently,
            // then roll back the row and every structural change together.
            await db.exec(
              "alter table appointments drop constraint appointments_shared_no_overlap",
            );
            await db.exec("alter table appointments disable trigger guard_appointment_booking");
            const legacy = await fixture(db, {
              start: "1991-01-01T10:00Z",
              end: "1991-01-01T09:00Z",
            });
            await db.exec("alter table appointments enable trigger guard_appointment_booking");
            await db.exec("set local role authenticated");
            await db.query("select set_config('request.jwt.claims',$1,true)", [
              JSON.stringify({ sub: a.user, role: "authenticated" }),
            ]);
            await db.query("update appointments set notes='Safe history annotation' where id=$1", [
              legacy,
            ]);
            await assert.rejects(
              attempt(db, () =>
                db.query(
                  "update appointments set start_time='2040-01-10T09:00Z',end_time='2040-01-10T09:45Z' where id=$1",
                  [legacy],
                ),
              ),
              /invalid legacy/i,
            );
            await db.query("update appointments set status='Cancelled' where id=$1", [legacy]);
            const saved = (
              await db.query(
                "select status,(start_time at time zone 'UTC')::text start_time,(end_time at time zone 'UTC')::text end_time from appointments where id=$1",
                [legacy],
              )
            ).rows[0];
            assert.equal(saved.status, "Cancelled");
            assert.match(saved.start_time, /1991-01-01 10:00/);
            assert.match(saved.end_time, /1991-01-01 09:00/);
          }),
      );
    }
    for (const role of ["owner", "manager", "staff"]) {
      await db.query("update profiles set role=$1 where id=$2", [role, a.profile]);
      await t.test(
        `${role}: safe invalid-history annotations/cancellation but immutable booking fields`,
        () =>
          asUser(db, a.user, async () => {
            for (const id of [zero, reversed, infinite]) {
              const original = (await db.query("select * from appointments where id=$1", [id]))
                .rows[0];
              await db.query("update appointments set notes='Safe annotation' where id=$1", [id]);
              for (const patch of [
                "id='" + nextId() + "'",
                "clinic_id='" + b.clinic + "'",
                "client_id=null",
                "staff_id=null",
                "service='Unknown'",
                "start_time='2041-01-01T09:00Z',end_time='2041-01-01T09:45Z'",
                "status='Booked'",
              ]) {
                // Zero legacy row is already Booked; a no-op status update is harmless.
                if (id === zero && patch === "status='Booked'") continue;
                await assert.rejects(
                  attempt(db, () => db.exec(`update appointments set ${patch} where id='${id}'`)),
                  /cannot change|preserve|legacy|row-level/i,
                );
              }
              await assert.rejects(
                attempt(db, () =>
                  db.query(
                    "update appointments set status='Cancelled',client_id=null where id=$1",
                    [id],
                  ),
                ),
                /preserve/i,
              );
              await db.query("update appointments set status='Cancelled' where id=$1", [id]);
              const cancelled = (await db.query("select * from appointments where id=$1", [id]))
                .rows[0];
              assert.equal(cancelled.status, "Cancelled");
              assert.deepEqual(cancelled.start_time, original.start_time);
              assert.deepEqual(cancelled.end_time, original.end_time);
              assert.equal(cancelled.client_id, original.client_id);
              assert.equal(cancelled.staff_id, original.staff_id);
            }
            await assert.rejects(
              attempt(db, () =>
                db.query(
                  "select * from appointment_available_slots($1,$2,'Consultation','2040-01-05',null)",
                  [b.clinic, b.staff],
                ),
              ),
              /access denied/i,
            );
          }),
      );
    }
    await t.test(
      "whole-minute legacy duration is preserved exactly on reschedule, independent of creation duration",
      () =>
        asUser(db, a.user, async () => {
          const ranges = await slots(db, whole, "2040-01-05");
          assert.ok(ranges.length);
          assert.equal(ranges[0].duration_minutes, 90);
          assert.equal(
            Date.parse(ranges[0].end_time) - Date.parse(ranges[0].start_time),
            90 * 60000,
          );
          await db.query("update appointments set start_time=$1,end_time=$2 where id=$3", [
            ranges[0].start_time,
            ranges[0].end_time,
            whole,
          ]);
          assert.equal(
            (
              await db.query(
                "select extract(epoch from end_time-start_time)::int seconds from appointments where id=$1",
                [whole],
              )
            ).rows[0].seconds,
            5400,
          );
        }),
    );
    await t.test(
      "fractional and microsecond legacy durations reject before returning any slots; records remain exact",
      () =>
        asUser(db, a.user, async () => {
          for (const id of [fractional, microseconds]) {
            const before = (
              await db.query(
                "select extract(epoch from end_time-start_time)::text seconds from appointments where id=$1",
                [id],
              )
            ).rows[0].seconds;
            await assert.rejects(
              attempt(db, () => slots(db, id, "2040-01-05")),
              (e) => e.code === "22023" && /not supported by whole-minute slots/i.test(e.message),
            );
            assert.equal(
              (
                await db.query(
                  "select extract(epoch from end_time-start_time)::text seconds from appointments where id=$1",
                  [id],
                )
              ).rows[0].seconds,
              before,
            );
          }
        }),
    );
    await t.test(
      "normal creation and reschedule reject zero/reversed/non-finite intervals and duration drift",
      () =>
        asUser(db, a.user, async () => {
          const ranges = await slots(db, null, "2040-01-05");
          assert.equal(ranges[0].duration_minutes, 45);
          const id = await fixture(db, { start: ranges[0].start_time, end: ranges[0].end_time });
          const destination = ranges[1];
          await db.query("update appointments set start_time=$1,end_time=$2 where id=$3", [
            destination.start_time,
            destination.end_time,
            id,
          ]);
          await assert.rejects(
            attempt(db, () =>
              db.query(
                "update appointments set end_time=end_time+interval '30 seconds' where id=$1",
                [id],
              ),
            ),
            /preserve.*duration/i,
          );
          for (const range of [
            { start: "2040-01-06T09:00Z", end: "2040-01-06T09:00Z" },
            { start: "2040-01-06T09:00Z", end: "2040-01-06T08:00Z" },
            { start: "-infinity", end: "infinity" },
          ]) {
            await assert.rejects(
              attempt(db, () => fixture(db, range)),
              /finite positive interval/i,
            );
            await assert.rejects(
              attempt(db, () =>
                db.query("update appointments set start_time=$1,end_time=$2 where id=$3", [
                  range.start,
                  range.end,
                  id,
                ]),
              ),
              /preserve|finite positive interval/i,
            );
          }
        }),
    );
    await db.query("update profiles set role='owner' where id=$1", [a.profile]);
    await t.test("existing checked voice slots still restrict practitioner deletion", () =>
      asUser(db, a.user, async () => {
        await assert.rejects(
          attempt(db, () => db.query("delete from staff where id=$1", [a.staff])),
          (e) => e.code === "23503",
        );
      }),
    );
    // Remove only this local checked-slot fixture before exercising permitted deletion.
    await db.query("delete from voice_checked_slots where staff_id=$1", [a.staff]);
    for (const role of ["owner", "manager"]) {
      await db.query("update profiles set role=$1 where id=$2", [role, a.profile]);
      await t.test(
        `${role}: practitioner FK SET NULL preserves every historic appointment and other fields`,
        () =>
          asUser(db, a.user, async () => {
            const before = await snapshot(db);
            await assert.rejects(
              attempt(db, () =>
                db.query("update appointments set staff_id=null where id=$1", [whole]),
              ),
              /preserve.*practitioner/i,
            );
            // A nested user UPDATE is still forbidden while the practitioner exists.
            await db.exec(
              `create or replace function pg_temp.probe_nested() returns trigger language plpgsql as $$ begin update public.appointments set staff_id=null where id='${whole}'; return new; end $$`,
            );
            // Browser cannot install such a trigger on any product table.
            await assert.rejects(
              attempt(db, () =>
                db.exec(
                  "create trigger malicious_nested after update on clients for each row execute function pg_temp.probe_nested()",
                ),
              ),
              /permission denied/i,
            );
            await db.query("delete from staff where id=$1", [a.staff]);
            const after = await snapshot(db);
            assert.equal(after.length, before.length);
            for (let i = 0; i < before.length; i++) {
              const { staff_id: oldStaff, updated_at: oldUpdated, ...oldRest } = before[i];
              const { staff_id: newStaff, updated_at: newUpdated, ...newRest } = after[i];
              assert.deepEqual(newRest, oldRest);
              assert.equal(newStaff, oldStaff === a.staff ? null : oldStaff);
            }
          }),
      );
    }
    await t.test(
      "client FK SET NULL contract also preserves history; staff cannot delete practitioners",
      () =>
        asUser(db, a.user, async () => {
          const before = await snapshot(db);
          await db.query("delete from clients where id=$1", [a.client]);
          assert.equal((await snapshot(db)).length, before.length);
          assert.equal(
            (await db.query("select client_id from appointments where id=$1", [whole])).rows[0]
              .client_id,
            null,
          );
        }),
    );
    await db.query("update profiles set role='staff' where id=$1", [a.profile]);
    await t.test(
      "Staff role cannot gain practitioner/configuration deletion through the FK bypass",
      () =>
        asUser(db, a.user, async () => {
          assert.equal(
            (await db.query("delete from staff where id=$1 returning id", [a.staff])).rows.length,
            0,
          );
        }),
    );
    await t.test(
      "simultaneous dashboard/voice/reschedule attempts reach one database authority and only one wins",
      async () => {
        const destination = (await slots(db, null, "2040-01-07"))[0];
        await db.exec("begin");
        try {
          // Disable the schedule-check trigger locally to prove the exclusion constraint
          // itself is authoritative. PGlite queues a single PostgreSQL connection;
          // this tests simultaneously submitted writes, not multi-session MVCC races.
          await db.exec("alter table appointments disable trigger guard_appointment_booking");
          const results = await Promise.allSettled([
            fixture(db, { start: destination.start_time, end: destination.end_time }),
            fixture(db, { start: destination.start_time, end: destination.end_time }),
          ]);
          assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
          assert.equal(results.find((r) => r.status === "rejected").reason.code, "23P01");
          // A failed SQL statement aborts the transaction; use independent savepoints
          // below for voice/move constraint assertions, after restoring this fixture.
        } finally {
          await db.exec("rollback");
        }
        await rollbackCase(db, async () => {
          const collision = await fixture(db, {
            start: destination.start_time,
            end: destination.end_time,
          });
          const existing = (await slots(db, null, "2040-01-08"))[0];
          const moveId = await fixture(db, { start: existing.start_time, end: existing.end_time });
          const call = "migration-voice-probe",
            check = nextId(),
            slot = nextId();
          await db.query(
            "insert into voice_call_state(call_id,clinic_id,current_check_id) values($1,$2,$3)",
            [call, a.clinic, check],
          );
          await db.query(
            `insert into voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at)
     values($1,$2,$3,$4,$5,'Consultation',$6,$7,now()+interval '1 hour')`,
            [slot, check, call, a.clinic, a.staff, existing.start_time, existing.end_time],
          );
          const voice = (
            await db.query(
              `select voice_apply_appointment('book',$1,'migration-voice-key',$2,null,
     'Patient','+96599123456',null,null,$3,'Consultation',$4,$5,$6,$7) result`,
              [a.clinic, call, a.staff, existing.start_time, existing.end_time, check, slot],
            )
          ).rows[0].result;
          assert.equal(voice.success, false);
          assert.equal(voice.error_type, "slot_conflict");
          // Free the independently-created move fixture, then let the real voice RPC book it.
          await db.query("update appointments set status='Cancelled' where id=$1", [moveId]);
          const booked = (
            await db.query(
              `select voice_apply_appointment('book',$1,'migration-voice-book-key',$2,null,
     'Patient','+96599123456',null,null,$3,'Consultation',$4,$5,$6,$7) result`,
              [a.clinic, call, a.staff, existing.start_time, existing.end_time, check, slot],
            )
          ).rows[0].result;
          assert.equal(booked.success, true, JSON.stringify(booked));
          await db.exec("alter table appointments disable trigger guard_appointment_booking");
          await assert.rejects(
            attempt(db, () => fixture(db, { start: existing.start_time, end: existing.end_time })),
            (e) => e.code === "23P01",
          );
          await assert.rejects(
            attempt(db, () =>
              db.query("update appointments set start_time=$1,end_time=$2 where id=$3", [
                destination.start_time,
                destination.end_time,
                booked.appointment_id,
              ]),
            ),
            (e) => e.code === "23P01",
          );
          await db.query("update appointments set status='Cancelled' where id=$1", [collision]);
          await db.query("update appointments set start_time=$1,end_time=$2 where id=$3", [
            destination.start_time,
            destination.end_time,
            booked.appointment_id,
          ]);
        });
      },
    );
  } finally {
    await db.close();
  }
});

test("same-named exclusion constraint must match actual definition and index metadata", async (t) => {
  const db = await createClinicDatabase();
  try {
    await loadSql(db, "10_clinic_access_privileges.sql");
    for (const [name, definition] of [
      ["check instead of exclusion", "check (true)"],
      [
        "missing clinic key",
        "exclude using gist (staff_id with =,tstzrange(start_time,end_time,'[)') with &&) where (status <> 'Cancelled')",
      ],
      [
        "wrong practitioner key",
        "exclude using gist (clinic_id with =,client_id with =,tstzrange(start_time,end_time,'[)') with &&) where (status <> 'Cancelled')",
      ],
      [
        "wrong time range",
        "exclude using gist (clinic_id with =,staff_id with =,tstzrange(start_time,start_time,'[)') with &&) where (status <> 'Cancelled')",
      ],
      [
        "inclusive end",
        "exclude using gist (clinic_id with =,staff_id with =,tstzrange(start_time,end_time,'[]') with &&) where (status <> 'Cancelled')",
      ],
      [
        "wrong status predicate",
        "exclude using gist (clinic_id with =,staff_id with =,tstzrange(start_time,end_time,'[)') with &&) where (status = 'Booked')",
      ],
      [
        "deferrable exclusion",
        "exclude using gist (clinic_id with =,staff_id with =,tstzrange(start_time,end_time,'[)') with &&) where (status <> 'Cancelled') deferrable initially deferred",
      ],
    ]) {
      await t.test(`mismatch fails atomically and is never dropped: ${name}`, async () => {
        await db.exec("create extension if not exists btree_gist");
        await db.exec(
          `alter table appointments add constraint appointments_shared_no_overlap ${definition}`,
        );
        const before = (
          await db.query(
            "select pg_get_constraintdef(oid) def from pg_constraint where conrelid='appointments'::regclass and conname='appointments_shared_no_overlap'",
          )
        ).rows;
        await failedInstall(db, /incompatible definition/i);
        assert.deepEqual(
          (
            await db.query(
              "select pg_get_constraintdef(oid) def from pg_constraint where conrelid='appointments'::regclass and conname='appointments_shared_no_overlap'",
            )
          ).rows,
          before,
        );
        await db.exec("alter table appointments drop constraint appointments_shared_no_overlap"); // ephemeral fixture only
      });
    }
    await t.test(
      "correct definition is repeat-safe; unrelated constraints remain untouched",
      async () => {
        await db.exec(
          "create table public.unrelated_constraint_fixture(id int constraint appointments_shared_no_overlap check(id>0))",
        );
        await loadSql(db, migration);
        const before = (
          await db.query(
            "select oid,pg_get_constraintdef(oid) def from pg_constraint where conrelid='appointments'::regclass and conname='appointments_shared_no_overlap'",
          )
        ).rows;
        await loadSql(db, migration);
        assert.deepEqual(
          (
            await db.query(
              "select oid,pg_get_constraintdef(oid) def from pg_constraint where conrelid='appointments'::regclass and conname='appointments_shared_no_overlap'",
            )
          ).rows,
          before,
        );
        assert.equal(
          (
            await db.query(
              "select count(*)::int n from pg_constraint where conrelid='unrelated_constraint_fixture'::regclass and conname='appointments_shared_no_overlap'",
            )
          ).rows[0].n,
          1,
        );
      },
    );
  } finally {
    await db.close();
  }
});
