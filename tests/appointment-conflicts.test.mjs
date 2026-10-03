import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appointmentWriteError,
  appointmentSlotConflictMessage,
} from "../src/lib/appointment-conflicts.ts";
import {
  createClinicDatabase,
  asRole,
  attempt,
  tenants,
  uuid,
} from "./helpers/clinic-database.mjs";
const [a] = tenants;
let sequence = 8000;
const id = () => uuid(++sequence);
for (const code of ["23P01", "40P01"]) {
  test(`dashboard protected write ${code} uses the existing friendly slot conflict`, () => {
    const original = { code, message: "private SQL diagnostic", details: "private parameters" };
    const mapped = appointmentWriteError(original);
    assert.equal(mapped.message, appointmentSlotConflictMessage);
    assert.equal(mapped.cause, original);
    assert.ok(!mapped.message.includes(code));
    assert.ok(!mapped.message.includes("private"));
  });
}
test("unrelated errors retain their original identity and diagnostics", () => {
  for (const error of [
    { code: "XX000", message: "internal" },
    { code: "42501", message: "permission denied" },
    { code: "23503", message: "reference" },
    new Error("network"),
    null,
  ])
    assert.equal(appointmentWriteError(error), error);
});

test("voice conflict handling is limited to the protected appointment write and preserves its contract", async (t) => {
  const db = await createClinicDatabase({ appointments: true });
  try {
    await db.query("update clients set phone='+96599123456' where id=$1", [a.client]);
    await db.exec(`insert into staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time)
    select '${a.clinic}','${a.staff}',d,'09:00','17:00' from generate_series(0,6)d where d<>1;
    create function public.test_slot_failure() returns trigger language plpgsql as $$begin
      if current_setting('apero_test.failure_table',true)=tg_table_name then
        raise exception 'private SQL diagnostic' using errcode=current_setting('apero_test.failure_code');
      end if;return new;end$$;
    create trigger zz_test_slot_failure before insert or update on appointments for each row execute function test_slot_failure();
    create trigger zz_test_client_failure before insert on clients for each row execute function test_slot_failure();
    create trigger zz_test_journal_failure before insert on voice_operations for each row execute function test_slot_failure();`);
    async function invoke(action, code, table = "appointments", newPatient = false) {
      const check = id(),
        slot = id(),
        call = `conflict-${id()}`,
        key = `operation-${id()}`,
        start = "2040-01-02T09:00:00Z",
        end = "2040-01-02T09:45:00Z";
      await db.query(
        "insert into voice_call_state(call_id,clinic_id,current_check_id) values($1,$2,$3)",
        [call, a.clinic, check],
      );
      await db.query(
        `insert into voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at) values($1,$2,$3,$4,$5,'Consultation',$6,$7,now()+interval '1 hour')`,
        [slot, check, call, a.clinic, a.staff, start, end],
      );
      await db.query(
        "select set_config('apero_test.failure_code',$1,true),set_config('apero_test.failure_table',$2,true)",
        [code, table],
      );
      return db.query(
        `select voice_apply_appointment($1,$2,$3,$4,$5,$6,'+96599123456',null,null,$7,'Consultation',$8,$9,$10,$11) as result`,
        [
          action,
          a.clinic,
          key,
          call,
          action === "reschedule" ? a.appointment : null,
          newPatient ? "New Patient" : "Patient",
          a.staff,
          start,
          end,
          check,
          slot,
        ],
      );
    }
    for (const action of ["book", "reschedule"])
      for (const code of ["23P01", "40P01"]) {
        await t.test(
          `${action}: ${code} returns slot_conflict after rollback, preserving appointments and clients`,
          () =>
            asRole(db, "service_role", { role: "service_role" }, async () => {
              const before = (await db.query("select * from appointments order by id")).rows;
              const clients = (await db.query("select * from clients order by id")).rows;
              const operations = (
                await db.query("select * from voice_operations order by operation_key")
              ).rows;
              const result = await invoke(action, code, "appointments", action === "book");
              assert.deepEqual(result.rows[0].result, {
                success: false,
                error_type: "slot_conflict",
              });
              assert.deepEqual(
                (await db.query("select * from appointments order by id")).rows,
                before,
              );
              assert.deepEqual((await db.query("select * from clients order by id")).rows, clients);
              assert.deepEqual(
                (await db.query("select * from voice_operations order by operation_key")).rows,
                operations,
              );
              assert.equal((await db.query("select 1 as usable")).rows[0].usable, 1);
            }),
        );
      }
    for (const [code, table, newPatient] of [
      ["XX000", "appointments", false],
      ["40P01", "clients", true],
      ["40P01", "voice_operations", false],
    ]) {
      await t.test(
        `${code} in ${table} remains a database error outside the classified write`,
        () =>
          asRole(db, "service_role", { role: "service_role" }, async () => {
            const before = (await db.query("select * from appointments order by id")).rows;
            const clients = (await db.query("select * from clients order by id")).rows;
            await assert.rejects(
              attempt(db, () => invoke("book", code, table, newPatient)),
              (e) => e.code === code && e.message === "private SQL diagnostic",
            );
            assert.deepEqual(
              (await db.query("select * from appointments order by id")).rows,
              before,
            );
            assert.deepEqual((await db.query("select * from clients order by id")).rows, clients);
          }),
      );
    }
    await t.test(
      "RPC signature/security/grants and absence of retry remain compatible",
      async () => {
        const { rows } = await db.query(
          "select pg_get_function_result(p.oid) result,p.prosecdef,p.proconfig,has_function_privilege('authenticated',p.oid,'EXECUTE') browser,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('service_role',p.oid,'EXECUTE') voice from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='voice_apply_appointment'",
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].result, "jsonb");
        assert.equal(rows[0].prosecdef, true);
        assert.deepEqual(rows[0].proconfig, ["search_path=public, pg_temp"]);
        assert.equal(rows[0].browser, false);
        assert.equal(rows[0].anon, false);
        assert.equal(rows[0].voice, true);
      },
    );
  } finally {
    await db.close();
  }
});
