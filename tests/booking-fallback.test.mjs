import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { bookingWithFallback } from "../supabase/functions/_shared/booking-fallback.ts";
import { createClinicDatabase, asUser, asRole, tenants } from "./helpers/clinic-database.mjs";

const db = await createClinicDatabase({ appointments: true });
after(() => db.close());
const [a, b] = tenants;
const details = {
  clinicId: a.clinic,
  callId: a.call,
  patientName: "Private Patient",
  patientPhone: "+12025550109",
  service: "Consultation",
  practitioner: a.staff,
  date: "2099-01-01",
  time: "10:00",
};
// Only the existing voice_requests API shape, backed by real PostgreSQL/RLS.
function adapter({ unavailable = false } = {}) {
  return {
    from(table) {
      assert.equal(table, "voice_requests");
      let row,
        filters = [],
        single = false;
      const q = {
        select: () => q,
        abortSignal: () => q,
        eq: (field, value) => {
          filters.push([field, value]);
          return q;
        },
        maybeSingle: () => {
          single = true;
          return q;
        },
        single: () => {
          single = true;
          return q;
        },
        insert: (value) => {
          row = value;
          return q;
        },
        then: (resolve, reject) =>
          Promise.resolve()
            .then(async () => {
              if (unavailable) throw new Error("secret-token-private-patient");
              const values = row ? Object.values(row) : filters.map(([, value]) => value);
              const sql = row
                ? `insert into voice_requests (${Object.keys(row).join(",")}) values (${values.map((_, i) => `$${i + 1}`).join(",")}) returning id,status`
                : `select id,status from voice_requests where ${filters.map(([field], i) => `${field} = $${i + 1}`).join(" and ")}`;
              try {
                const result = await db.query(sql, values);
                return { data: single ? (result.rows[0] ?? null) : result.rows, error: null };
              } catch (error) {
                return { data: null, error };
              }
            })
            .then(resolve, reject),
      };
      return q;
    },
  };
}
const limits = { bookingMs: 20, followUpMs: 1000 };
const success = {
  success: true,
  appointment_booked: true,
  appointment_id: a.appointment,
  start_time: "2099-01-01T10:00:00Z",
};
let sequence = 0;
async function attempt(create, store = adapter()) {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const key = `test-${++sequence}`;
    const result = await bookingWithFallback(store, key, details, create, limits);
    return { result, logs, key };
  } finally {
    console.error = original;
  }
}
function assertFailure(result, reason) {
  assert.equal(result.success, false);
  assert.equal(result.appointment_booked, false);
  assert.equal(result.appointment_confirmed, false);
  assert.equal(result.appointment_id, null);
  assert.equal(result.retry_allowed, false);
  assert.equal(result.error_type, reason);
  assert.equal(
    result.message,
    "The booking could not be completed. Your appointment is NOT confirmed.",
  );
}

test("successful booking passes through unchanged and does not create follow-up", async () => {
  const { result, logs, key } = await attempt(async () => success);
  assert.deepEqual(result, success);
  assert.deepEqual(logs, []);
  assert.equal(
    (
      await db.query("select id from voice_requests where request_key = $1", [
        `failed-booking:${a.clinic}:${key}`,
      ])
    ).rows.length,
    0,
  );
});

for (const [label, create, reason] of [
  [
    "backend error",
    async () => ({ success: false, error_type: "database_error", message: "secret-token" }),
    "database_error",
  ],
  [
    "throw",
    async () => {
      throw new Error("secret-token-private-patient");
    },
    "booking_exception",
  ],
  ["timeout", () => new Promise(() => {}), "booking_timeout"],
  [
    "database statement timeout",
    async () => {
      throw { code: "57014", message: "secret-token" };
    },
    "booking_timeout",
  ],
  ["null response", async () => null, "booking_invalid_response"],
  ["malformed response", async () => "booked", "booking_invalid_response"],
  [
    "missing confirmation flag",
    async () => ({ success: true, appointment_id: a.appointment }),
    "booking_invalid_response",
  ],
  [
    "missing appointment ID",
    async () => ({ success: true, appointment_booked: true }),
    "booking_invalid_response",
  ],
  [
    "invalid appointment ID",
    async () => ({ success: true, appointment_booked: true, appointment_id: "made-up" }),
    "booking_invalid_response",
  ],
  [
    "unsafe reason",
    async () => ({ success: false, error_type: "secret-token-private-patient" }),
    "database_error",
  ],
]) {
  test(`${label}: no success confirmation, details retained, logs contain no credentials or patient data`, async () => {
    const { result, logs } = await attempt(create);
    assertFailure(result, reason);
    assert.equal(result.follow_up_saved, true);
    assert.equal(result.follow_up_status, "Open");
    const row = (
      await db.query("select * from voice_requests where id = $1", [result.follow_up_request_id])
    ).rows[0];
    for (const [field, value] of Object.entries({
      clinic_id: a.clinic,
      call_id: a.call,
      patient_name: details.patientName,
      phone: details.patientPhone,
      status: "Open",
    }))
      assert.equal(row[field], value);
    for (const value of [
      details.service,
      details.practitioner,
      `${details.date} ${details.time}`,
      `Failure reason: ${reason}`,
      "Failure timestamp:",
      "Do not automatically retry",
    ])
      assert.ok(row.reason.includes(value));
    assert.equal(logs.length, 1);
    for (const forbidden of [
      "secret-token",
      "Private Patient",
      details.patientPhone,
      a.call,
      a.staff,
    ])
      assert.ok(!logs.join().includes(forbidden));
    assert.equal(JSON.parse(logs[0]).reason, reason);
    assert.ok(!row.reason.includes("secret-token"));
  });
}

test("deadline aborts creation; late completion does not return confirmation or cause a retry", async () => {
  let signal,
    calls = 0,
    finish;
  const { result, key } = await attempt((s) => {
    signal = s;
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  assertFailure(result, "booking_timeout");
  assert.equal(signal.aborted, true);
  finish(success);
  await Promise.resolve();
  const replay = await bookingWithFallback(
    adapter(),
    key,
    details,
    async () => {
      calls++;
      return success;
    },
    limits,
  );
  assertFailure(replay, "previous_booking_failure");
  assert.equal(calls, 1);
  await db.query("update voice_requests set status = 'Closed' where id = $1", [
    result.follow_up_request_id,
  ]);
  const closedReplay = await bookingWithFallback(
    adapter(),
    key,
    details,
    async () => {
      calls++;
      return success;
    },
    limits,
  );
  assert.equal(closedReplay.follow_up_status, "Closed");
  assert.equal(calls, 1);
});

test("storage outage fails closed without promising staff received follow-up or invoking creation", async () => {
  let calls = 0;
  const { result, logs } = await attempt(
    async () => {
      calls++;
      return success;
    },
    adapter({ unavailable: true }),
  );
  assertFailure(result, "follow_up_lookup_failed");
  assert.equal(result.follow_up_saved, false);
  assert.equal(result.follow_up_status, "not_saved");
  assert.ok(result.patient_instruction.includes("contact the clinic directly"));
  assert.equal(calls, 0);
  assert.ok(!logs.join().includes("secret-token"));
});

test("retained request is visible only to same-clinic authorized members; foreign reads and updates blocked", async () => {
  const { result } = await attempt(async () => ({ success: false, error_type: "database_error" }));
  const id = result.follow_up_request_id;
  await asUser(db, a.user, async (sql) => {
    assert.equal(
      (await sql.query("select id from voice_requests where id = $1", [id])).rows.length,
      1,
    );
  });
  await asUser(db, b.user, async (sql) => {
    assert.equal(
      (await sql.query("select id from voice_requests where id = $1", [id])).rows.length,
      0,
    );
    assert.equal(
      (
        await sql.query("update voice_requests set status = 'Closed' where id = $1 returning id", [
          id,
        ])
      ).rows.length,
      0,
    );
  });
  await asRole(db, "anon", { role: "anon" }, async (sql) => {
    await assert.rejects(
      sql.query("select id from voice_requests where id = $1", [id]),
      /permission denied/,
    );
  });
  // Same clinic receptionist cannot view requests under the existing role policy.
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ role: "service_role" }),
    ]);
    await db.query("update profiles set role = 'staff' where auth_user_id = $1", [a.user]);
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: a.user, role: "authenticated" }),
    ]);
    assert.equal(
      (await db.query("select id from voice_requests where id = $1", [id])).rows.length,
      0,
    );
  } finally {
    await db.exec("rollback");
  }
});

test("flow clears previous success before creation, so a transport timeout cannot confirm the old booking", () => {
  const flow = JSON.parse(
    readFileSync(new URL("../retell/master/reference/golden.json", import.meta.url), "utf8"),
  ).conversationFlow;
  const prepare = flow.nodes.find((node) => node.id === "node_prepare_booking_result");
  const stale = {
    booking_success: true,
    appointment_booked: true,
    booking_id: a.appointment,
    booking_follow_up_saved: true,
  };
  const cleared = new Function("dv", prepare.code)(stale);
  const current = {
    ...stale,
    ...Object.fromEntries(
      Object.entries(prepare.response_variables).map(([variable, field]) => [
        variable,
        cleared[field],
      ]),
    ),
  };
  assert.equal(current.booking_success, false);
  assert.equal(current.appointment_booked, false);
  assert.equal(current.booking_id, "");
  assert.equal(current.booking_follow_up_saved, false);
  assert.equal(prepare.wait_for_result, true);
  assert.equal(prepare.else_edge.destination_node_id, "node_book_failed");
  const book = flow.nodes.find((node) => node.id === "node_book");
  assert.equal(book.else_edge.destination_node_id, "node_book_failed");
  // No response leaves the freshly cleared flags false, not the previous success.
  assert.equal(
    book.edges[0].transition_condition.equations.every((e) =>
      e.operator === "exists"
        ? !!current[e.left.slice(2, -2)]
        : String(current[e.left.slice(2, -2)]) === e.right,
    ),
    false,
  );
});

test("slot_unavailable remains structured in the response and staff follow-up", async () => {
  const { result } = await attempt(async () => ({
    success: false,
    error_type: "slot_unavailable",
  }));
  assertFailure(result, "slot_unavailable");
  const row = (
    await db.query("select reason from voice_requests where id=$1", [result.follow_up_request_id])
  ).rows[0];
  assert.match(row.reason, /slot_unavailable/);
});
