import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  humanEscalationFollowUp,
  humanEscalationResult,
  HUMAN_SAVE_FAILED,
} from "../supabase/functions/_shared/human-escalation.ts";
import { createClinicDatabase, asUser, tenants } from "./helpers/clinic-database.mjs";
const db = await createClinicDatabase({ appointments: true });
after(() => db.close());
const [a, b] = tenants;
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

let sequence = 0;
const details = {
  clinicId: a.clinic,
  callId: a.call,
  requested: true,
  category: "explicit_human_request",
  reason: "Please ask the receptionist to help with my appointment dispute.",
  name: "Private Patient",
  phone: "+12025550109",
};
async function run(overrides = {}, store = adapter(), ms = 1000) {
  const logs = [],
    old = console.info,
    oldError = console.error;
  console.info = console.error = (...args) => logs.push(args.join(" "));
  try {
    return {
      result: await humanEscalationFollowUp(
        store,
        { ...details, callId: `human-${++sequence}`, ...overrides },
        ms,
      ),
      logs,
    };
  } finally {
    console.info = old;
    console.error = oldError;
  }
}
test("human escalation result contains no invented answer or price", () => {
  const result = humanEscalationResult();
  assert.equal(result.resolved, false);
  assert.equal(result.category, "human_assistance");
  assert.equal(result.message, "No human assistance request was saved.");
  assert.equal(result.follow_up_saved, false);
  assert.equal(result.follow_up_status, "not_requested");
  assert.equal(Object.hasOwn(result, "price"), false);
  assert.equal(Object.hasOwn(result, "practitioner"), false);
});
test("no requested follow-up means no collection, database writes or logs", async () => {
  const store = {
    from() {
      throw Error("must not access database");
    },
  };
  const { result, logs } = await run({ requested: false }, store);
  assert.deepEqual(result, humanEscalationResult());
  assert.deepEqual(logs, []);
});
test("requested reason is retained in existing Requests queue and clinic RLS blocks other clinics", async () => {
  const { result, logs } = await run();
  assert.equal(result.follow_up_saved, true);
  assert.equal(result.follow_up_status, "Open");
  const row = (
    await asUser(db, a.user, (sql) =>
      sql.query("select * from voice_requests where id=$1", [result.follow_up_request_id]),
    )
  ).rows[0];
  assert.equal(row.clinic_id, a.clinic);
  assert.equal(row.kind, "message");
  assert.equal(row.patient_name, details.name);
  assert.equal(row.phone, details.phone);
  assert.ok(row.created_at);
  assert.ok(row.call_id);
  assert.equal(
    row.reason,
    "Human assistance required\nCategory: explicit_human_request\nRequest: " + details.reason,
  );
  assert.equal(
    (
      await asUser(db, b.user, (sql) =>
        sql.query("select * from voice_requests where id=$1", [result.follow_up_request_id]),
      )
    ).rows.length,
    0,
  );
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(), [
    "category",
    "clinic_id",
    "component",
    "follow_up_saved",
    "state",
    "timestamp",
  ]);
  for (const sensitive of [details.name, details.phone, details.reason, "secret-token"])
    assert.equal(logs.join().includes(sensitive), false);
});
test("name and phone are optional and absent data is not fabricated", async () => {
  const { result } = await run({ name: "", phone: "" });
  assert.equal(result.follow_up_saved, true);
  const row = (
    await db.query("select patient_name,phone from voice_requests where id=$1", [
      result.follow_up_request_id,
    ])
  ).rows[0];
  assert.equal(row.patient_name, null);
  assert.equal(row.phone, "");
});
test("same reason is idempotent; a different reason in the same call is kept", async () => {
  const callId = "human-dedupe";
  const first = (await run({ callId })).result,
    second = (await run({ callId })).result;
  assert.equal(second.follow_up_request_id, first.follow_up_request_id);
  const third = (await run({ callId, reason: "What are the holiday hours?" })).result;
  assert.notEqual(third.follow_up_request_id, first.follow_up_request_id);
});
for (const [label, store, overrides, ms] of [
  ["throw", adapter({ unavailable: true }), {}, 1000],
  [
    "database error",
    {
      from: () => ({
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return this;
        },
        abortSignal() {
          return Promise.resolve({ data: null, error: { message: "secret-token" } });
        },
      }),
    },
    {},
    1000,
  ],
  [
    "timeout",
    {
      from: () => ({
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return this;
        },
        abortSignal() {
          return new Promise(() => {});
        },
      }),
    },
    {},
    10,
  ],
  ["empty reason", adapter(), { reason: "" }, 1000],
])
  test(`${label}: save failure is safe and logs no reason or dependency secrets`, async () => {
    const { result, logs } = await run(overrides, store, ms);
    assert.equal(result.follow_up_saved, false);
    assert.equal(result.follow_up_status, "not_saved");
    assert.equal(result.message, HUMAN_SAVE_FAILED);
    assert.equal(result.resolved, false);
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(logs[0]).follow_up_saved, false);
    for (const sensitive of [details.reason, details.name, details.phone, "secret-token"])
      assert.equal(logs.join().includes(sensitive), false);
  });

test("actual Requests card renders human assistance, reason, Open status and optional contact", async () => {
  const { readFileSync } = await import("node:fs");
  const { transpileModule } = await import("typescript");
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const source = readFileSync(new URL("../src/components/requests.tsx", import.meta.url), "utf8");
  const card = source.slice(
    source.indexOf("const kindLabel:"),
    source.indexOf("function RequestState("),
  );
  const js = transpileModule(card + "\nreturn RequestCard;", {
    compilerOptions: { target: 99, jsx: 2 },
  }).outputText;
  const Button = ({ children, ...props }) => React.createElement("button", props, children);
  const Card = new Function(
    "React",
    "useState",
    "useCloseVoiceRequest",
    "cn",
    "AlertCircle",
    "Phone",
    "Check",
    "Button",
    "formatDate",
    "formatTime",
    "toast",
    js,
  )(
    React,
    React.useState,
    () => ({ isPending: false }),
    (...values) => values.filter(Boolean).join(" "),
    () => null,
    () => null,
    () => null,
    Button,
    () => "date",
    () => "time",
    { success() {} },
  );
  const row = {
    id: "test-request",
    kind: "message",
    status: "Open",
    created_at: "2026-10-05T00:00:00Z",
    reason:
      "Human assistance required\nCategory: explicit_human_request\nRequest: Help with appointment dispute",
    phone: "",
    patient_name: null,
    caller_name: null,
  };
  const html = renderToStaticMarkup(React.createElement(Card, { row, timeZone: "Asia/Kuwait" }));
  assert.ok(html.includes('<h3 class="font-semibold">Human assistance required</h3>'));
  assert.ok(html.includes("Help with appointment dispute"));
  assert.ok(html.includes("Open"));
  assert.ok(html.includes("No contact number supplied"));
  assert.equal(html.includes('href="tel:'), false);
  const withPhone = renderToStaticMarkup(
    React.createElement(Card, { row: { ...row, phone: "+12025550109" } }),
  );
  assert.ok(withPhone.includes('href="tel:+12025550109"'));
  for (const label of ["Calendar unavailable — follow-up", "Booking not confirmed — follow-up"]) {
    const other = renderToStaticMarkup(
      React.createElement(Card, { row: { ...row, reason: label } }),
    );
    assert.ok(other.includes(label.startsWith("Booking") ? "Failed booking — follow-up" : label));
  }
});

test("unsupported operational request is saved with its category", async () => {
  const { result } = await run({
    category: "unsupported_operation",
    reason: "Request to change a billing record",
  });
  assert.equal(result.follow_up_saved, true);
  const row = (
    await db.query("select reason from voice_requests where id=$1", [result.follow_up_request_id])
  ).rows[0];
  assert.ok(row.reason.includes("Category: unsupported_operation"));
});
test("normal supported requests and specific fallback categories do not escalate", async () => {
  for (const category of [
    "supported_request",
    "booking_failed",
    "calendar_unavailable",
    "unknown_answer",
  ]) {
    const { result, logs } = await run(
      { category },
      {
        from() {
          throw Error("must not write");
        },
      },
    );
    assert.equal(result.follow_up_saved, false);
    assert.deepEqual(logs, []);
  }
});

for (const category of [
  "unsafe_to_complete",
  "clinic_judgment",
  "repeated_failure",
  "appointment_dispute",
])
  test(`${category} retains a concise staff request`, async () => {
    const { result, logs } = await run({
      category,
      reason: "Staff must review this operational issue",
    });
    assert.equal(result.follow_up_saved, true);
    assert.equal(JSON.parse(logs[0]).category, "human_escalation_saved");
  });
