import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  operationalLog,
  safeOperationalEvent,
  monitorHandler,
  setOperationalContext,
} from "../supabase/functions/_shared/operational-log.ts";
import { logDatabaseFailure } from "../supabase/functions/_shared/request-security.ts";
import { downtimeBoundary } from "../supabase/functions/_shared/system-downtime.ts";
import { bookingWithFallback } from "../supabase/functions/_shared/booking-fallback.ts";
import { createRecordingAccessFunction } from "../supabase/functions/recording-access/function.ts";
const clinic = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const poison =
  "Bearer private-token patient Alice +96555555555 full transcript raw provider payload";
async function capture(fn) {
  const events = [],
    info = console.info,
    error = console.error;
  console.info = console.error = (line) => events.push(JSON.parse(line));
  try {
    return { value: await fn(), events };
  } finally {
    console.info = info;
    console.error = error;
  }
}
test("metadata is an allowlist, including bounded IDs, labels, booleans and SQLSTATE", () => {
  const event = safeOperationalEvent("booking_failed", "book-appointment", {
    clinic_id: clinic,
    call_id: "call_123",
    request_id: clinic,
    follow_up_request_id: clinic,
    state: "failure",
    reason: "booking_timeout",
    dependency_category: "timeout",
    database_code: "57014",
    follow_up_saved: false,
    status: 503,
    body: poison,
    error: poison,
    stack: poison,
    transcript: poison,
    recording_url: poison,
    Authorization: poison,
    password: poison,
    patient_name: poison,
  });
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      "timestamp",
      "category",
      "component",
      "state",
      "clinic_id",
      "call_id",
      "request_id",
      "follow_up_request_id",
      "reason",
      "dependency_category",
      "database_code",
      "follow_up_saved",
      "status",
    ].sort(),
  );
  assert.equal(event.clinic_id, clinic);
  assert.equal(event.call_id, "call_123");
  assert.ok(!JSON.stringify(event).includes(poison));
  assert.ok(Number.isFinite(Date.parse(event.timestamp)));
});
test("free text is rejected even inside allowed fields", () => {
  const event = safeOperationalEvent(
    poison,
    poison,
    Object.fromEntries(
      [
        "clinic_id",
        "call_id",
        "request_id",
        "conversation_id",
        "reason",
        "dependency_category",
        "database_code",
        "transfer_result",
        "state",
      ].map((k) => [k, poison]),
    ),
  );
  assert.deepEqual(Object.keys(event).sort(), ["category", "component", "state", "timestamp"]);
  assert.equal(event.category, "internal_error");
  assert.ok(!JSON.stringify(event).includes("Alice"));
});
for (const [component, status, category] of [
  ["retell-webhook", 500, "webhook_failed"],
  ["retell-webhook", 503, "webhook_failed"],
  ["book-appointment", 503, "booking_failed"],
  ["check-availability", 500, "calendar_unavailable"],
  ["recording-access", 502, "recording_access_failed"],
  ["recording-access", 404, "recording_access_failed"],
  ["manage-clinic-users", 401, "authentication_failed"],
  ["retell-webhook", 403, "authorization_denied"],
  ["clinic-operations", 500, "internal_error"],
])
  test(`${component} ${status} emits ${category} without response/body/header content`, async () => {
    const request = new Request("https://example.invalid/?token=" + encodeURIComponent(poison), {
      headers: { authorization: poison, "x-request-id": poison },
    });
    const { events, value } = await capture(() =>
      monitorHandler(component, (req) => {
        setOperationalContext(req, {
          clinic_id: clinic,
          call_id: "call_123",
          dependency_category: "database_error",
        });
        return new Response(poison, { status });
      })(request),
    );
    assert.equal(value.status, status);
    assert.equal(await value.text(), poison);
    assert.equal(events.length, 1);
    assert.equal(events[0].category, category);
    assert.equal(events[0].clinic_id, clinic);
    assert.match(events[0].request_id, /^[a-f0-9-]{36}$/);
    assert.ok(!JSON.stringify(events).includes(poison));
  });
test("normal requests including signed recording payloads emit no boundary events", async () => {
  const { events } = await capture(async () => {
    for (const status of [200, 204, 400, 405, 413])
      await monitorHandler(
        "retell-webhook",
        () => new Response(status === 204 ? null : poison, { status }),
      )(new Request("https://example.invalid"));
  });
  assert.deepEqual(events, []);
});
test("unexpected webhook exception is safe and request scoped", async () => {
  const { events, value } = await capture(() =>
    monitorHandler("retell-webhook", () => {
      throw new Error(poison, { cause: { body: poison } });
    })(new Request("https://example.invalid")),
  );
  assert.equal(value.status, 500);
  assert.equal(events[0].category, "webhook_failed");
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes(poison));
});
test("downtime JSON fallback remains visible even though HTTP is 200", async () => {
  const { events, value } = await capture(() =>
    monitorHandler(
      "clinic-operations",
      downtimeBoundary(async () => {
        throw Error(poison);
      }),
    )(new Request("https://example.invalid")),
  );
  assert.equal(value.status, 200);
  assert.equal((await value.json()).system_unavailable, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].category, "system_unavailable");
});
test("database errors cannot smuggle arbitrary codes or error payloads", async () => {
  const { events } = await capture(() =>
    logDatabaseFailure(poison, { code: poison, message: poison, details: poison }),
  );
  assert.equal(events[0].category, "database_error");
  assert.equal(events[0].database_code, undefined);
  assert.ok(!JSON.stringify(events).includes(poison));
});
test("throwing log sinks cannot break security responses, downtime or booking fallback", async () => {
  const oldInfo = console.info,
    oldError = console.error;
  console.info = console.error = () => {
    throw Error(poison);
  };
  try {
    operationalLog("database_error", "database");
    assert.equal(
      (
        await monitorHandler(
          "recording-access",
          () => new Response(null, { status: 401 }),
        )(new Request("https://example.invalid"))
      ).status,
      401,
    );
    const down = await downtimeBoundary(async () => {
      throw Error(poison);
    })(new Request("https://example.invalid"));
    assert.equal((await down.json()).system_unavailable, true);
    const failed = await bookingWithFallback(
      {
        from() {
          throw Error(poison);
        },
      },
      "operation",
      {
        clinicId: clinic,
        callId: "call_123",
        patientName: poison,
        patientPhone: poison,
        service: poison,
        practitioner: poison,
        date: poison,
        time: poison,
      },
      async () => {
        throw Error(poison);
      },
    );
    assert.equal(failed.appointment_booked, false);
    assert.equal(failed.follow_up_saved, false);
  } finally {
    console.info = oldInfo;
    console.error = oldError;
  }
});
test("recording factory logs auth/configuration failure without issuing provider requests", async () => {
  const env = { APERO_PORTAL_ORIGIN: "https://portal.example" };
  const { events, value } = await capture(() =>
    createRecordingAccessFunction(
      (name) => env[name],
      () => assert.fail("no provider request"),
    )(new Request("https://example.invalid", { method: "POST" })),
  );
  assert.equal(value.status, 401);
  assert.equal(events[0].category, "authentication_failed");
});
test("Lovable hooks receive only generic errors and cannot break error UI", async () => {
  const { transform } = await import("esbuild");
  const source = await readFile(
    new URL("../src/lib/lovable-error-reporting.ts", import.meta.url),
    "utf8",
  );
  const js = (await transform(source, { loader: "ts", format: "esm" })).code;
  const { reportLovableError } = await import(
    "data:text/javascript;base64," + Buffer.from(js).toString("base64")
  );
  const observed = [];
  globalThis.window = {
    __lovableEvents: { captureException: (...args) => observed.push(args) },
    __lovableReportRuntimeError: (...args) => observed.push(args),
  };
  try {
    reportLovableError(Error(poison), { transcript: poison });
    assert.equal(observed[0][0].message, "Unexpected application error");
    assert.equal(observed[0][0].stack, undefined);
    assert.ok(!JSON.stringify(observed).includes(poison));
    window.__lovableEvents.captureException = () => {
      throw Error(poison);
    };
    assert.doesNotThrow(() => reportLovableError(poison));
  } finally {
    delete globalThis.window;
  }
});
test("server console interception discards exception stacks, cause chains and raw arguments", async () => {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: ["src/lib/error-capture.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  const original = console.error,
    observed = [];
  console.error = (line) => observed.push(JSON.parse(line));
  try {
    const mod = await import(
      "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")
    );
    console.error(new Error(poison, { cause: { body: poison } }), { transcript: poison }, poison);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].category, "internal_error");
    assert.ok(!JSON.stringify(observed).includes(poison));
    assert.equal(mod.describeError(Error(poison)), "Unexpected application error");
    assert.ok(mod.consumeLastCapturedError() instanceof Error);
    operationalLog("booking_failed", "portal", { reason: "slot_conflict" });
    assert.equal(observed[1].category, "booking_failed");
    assert.equal(observed[1].reason, "slot_conflict");
  } finally {
    console.error = original;
  }
});
