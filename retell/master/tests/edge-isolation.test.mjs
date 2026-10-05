// Execute the real Edge handlers in-process with a local Supabase query adapter.
// SQL/RLS/RPC constraints are covered separately by tenant_isolation.sql.
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transpileModule } from "typescript";
import * as routing from "../../../supabase/functions/_shared/voice-routing.ts";
import * as security from "../../../supabase/functions/_shared/request-security.ts";
import * as calendar from "../../../supabase/functions/_shared/calendar-fallback.ts";
import { bookingWithFallback } from "../../../supabase/functions/_shared/booking-fallback.ts";
import * as logic from "../../../supabase/functions/clinic-operations/logic.ts";


const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SA = "aaaaaaaa-1111-4111-8111-111111111111";
const SB = "bbbbbbbb-2222-4222-8222-222222222222";
const APPA = "aaaaaaaa-3333-4333-8333-333333333333";
const APPB = "bbbbbbbb-4444-4444-8444-444444444444";
const keys = { RETELL_A: "local-only-secret-a", RETELL_B: "local-only-secret-b" };
const integrations = [
  {
    clinic_id: A,
    agent_id: "agent-a",
    workspace_id: "workspace-a",
    secret_env_name: "RETELL_A",
    active: true,
    dialing_prefix: "+1",
    local_number_length: 10,
    slot_minutes: 45,
  },
  {
    clinic_id: B,
    agent_id: "agent-b",
    workspace_id: "workspace-b",
    secret_env_name: "RETELL_B",
    active: true,
    dialing_prefix: "+1",
    local_number_length: 10,
    slot_minutes: 45,
  },
];
function signature(body, key, time = Date.now()) {
  return `v=${time},d=${createHmac("sha256", key)
    .update(body + time)
    .digest("hex")}`;
}
const Retell = {
  verify: async (raw, key, sig) => {
    const match = /^v=(\d+),d=([0-9a-f]{64})$/.exec(sig);
    if (!match || Math.abs(Date.now() - Number(match[1])) > 300000) return false;
    return timingSafeEqual(Buffer.from(sig), Buffer.from(signature(raw, key, Number(match[1]))));
  },
};

function compile(path, bindings, extra = "") {
  const source = readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\s*$/gm, "")
    .replace("export default", "const handler =");
  const js = transpileModule(source + extra, { compilerOptions: { target: 99, module: 99 } })
    .outputText.replace(/export\s+(?=(async )?function)/g, "")
    .replace(/export \{[^}]*\};/g, "");
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

function abortable(value) {
  return Object.assign(Promise.resolve(value), { abortSignal() { return this; } });
}

class Database {
  constructor() {
    this.tables = {
      voice_integrations: structuredClone(integrations),
      clinics: [
        { id: A, timezone: "UTC" },
        { id: B, timezone: "UTC" },
      ],
      staff: [
        {
          id: SA,
          clinic_id: A,
          full_name: "Dr. Same Name",
          services: ["Consultation", "Radiography"],
          aliases: ["Same Alias", "ZetaExclusive"],
          active: true,
        },
        {
          id: SB,
          clinic_id: B,
          full_name: "Dr. Same Name",
          services: ["Consultation", "Vaccination"],
          aliases: ["Same Alias"],
          active: true,
        },
      ],
      clinic_service_aliases: [],
      voice_call_state: [],
      voice_checked_slots: [],
      voice_operations: [],
      voice_requests: [],
      conversations: [],
      clients: [
        { id: "patient-a", clinic_id: A, full_name: "Alex Test", phone: "+12025550101" },
        { id: "patient-b", clinic_id: B, full_name: "Alex Test", phone: "+12025550101" },
      ],
      appointments: [
        {
          id: APPA,
          clinic_id: A,
          client_id: "patient-a",
          staff_id: SA,
          service: "Radiography",
          start_time: "2099-01-01T10:00:00Z",
          status: "Booked",
        },
        {
          id: APPB,
          clinic_id: B,
          client_id: "patient-b",
          staff_id: SB,
          service: "Vaccination",
          start_time: "2099-01-01T10:00:00Z",
          status: "Booked",
        },
      ],
    };
    this.rpcCalls = [];
  }
  from(table) {
    const db = this;
    let filters = [],
      single = false,
      mutation,
      limit = Infinity;
    const q = {
      select: () => q,
      eq: (k, v) => {
        filters.push((r) => r[k] === v);
        return q;
      },
      neq: (k, v) => {
        filters.push((r) => r[k] !== v);
        return q;
      },
      gte: (k, v) => {
        filters.push((r) => r[k] >= v);
        return q;
      },
      ilike: (k, v) => {
        filters.push((r) => r[k].toLowerCase() === v.toLowerCase());
        return q;
      },
      in: (k, v) => {
        filters.push((r) => v.includes(r[k]));
        return q;
      },
      abortSignal: () => q,
      order: () => q,
      limit: (n) => {
        limit = n;
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
      upsert: (row, options) => {
        mutation = { row, field: options?.onConflict };
        return q;
      },
      insert: (row) => {
        mutation = { row };
        return q;
      },
      then: (yes, no) =>
        Promise.resolve()
          .then(() => {
            if (mutation) {
              for (const row of structuredClone(
                Array.isArray(mutation.row) ? mutation.row : [mutation.row],
              )) {
                const old =
                  mutation.field &&
                  db.tables[table].find((r) => r[mutation.field] === row[mutation.field]);
                if (old) Object.assign(old, row);
                else {
                  if (table === "voice_requests") row.id ??= crypto.randomUUID();
                  db.tables[table].push(row);
                }
              }
            }
            const rows = db.tables[table].filter((r) => filters.every((f) => f(r))).slice(0, limit);
            return { data: structuredClone(single ? (rows[0] ?? null) : rows), error: null };
          })
          .then(yes, no),
    };
    return q;
  }
  rpc(name, args) {
    this.rpcCalls.push({ name, args });
    if (name === "appointment_available_slots")
      return abortable({
        data: [
          {
            start_time: `${args.p_date}T10:00:00Z`,
            end_time: `${args.p_date}T10:45:00Z`,
            duration_minutes: 45,
          },
        ],
        error: null,
      });
    // Deliberately never implement appointment mutation in this adapter.
    return abortable({ data: { success: false, error_type: "local_rpc_not_executed" }, error: null });
  }
}

// Formatting shim for handler contract tests; production Luxon/DST is not
// simulated here. Database/browser suites cover the real appointment instants.
function utcTime(iso) {
  const millis = Date.parse(iso);
  return {
    isValid: Number.isFinite(millis),
    valueOf: () => millis,
    toUTC: () => ({ toISO: () => new Date(millis).toISOString() }),
    toFormat: (pattern) =>
      pattern === "yyyy-MM-dd"
        ? new Date(millis).toISOString().slice(0, 10)
        : new Date(millis).toISOString().slice(11, 16),
    startOf: () => utcTime(new Date(millis).toISOString().slice(0, 10) + "T00:00Z"),
    plus: ({ days = 0, minutes = 0 }) =>
      utcTime(new Date(millis + days * 86400000 + minutes * 60000).toISOString()),
    setZone: () => utcTime(iso),
  };
}

function environment() {
  const db = new Database();
  const localKeys = { ...keys };
  const resolveVoiceIntegration = compile(
    "../../../supabase/functions/_shared/voice-integration.ts",
    {
      ...routing,
      Retell,
      Deno: { env: { get: (k) => localKeys[k] } },
    },
    "\nreturn resolveVoiceIntegration;",
  );
  const common = {
    ...security,
    ...logic,
    bookingWithFallback,
    ...calendar,
    // Only a UTC formatting shim for the RPC/checked-slot contract test.
    // Actual clinic timezone and duration math are covered in PostgreSQL tests.
    DateTime: {
      fromFormat: (date) => utcTime(`${date}T00:00:00Z`),
      fromISO: (iso) => utcTime(iso),
      now: () => utcTime(new Date().toISOString()),
    },
    resolveVoiceIntegration,
    normalizePhone: logic.phone,
    withSupabase: (_options, fn) => (req) => fn(req, { supabaseAdmin: db }),
  };
  const operations = compile(
    "../../../supabase/functions/clinic-operations/index.ts",
    common,
    "\nreturn {handler, readToken, tokenFor, availableSlots};",
  );
  const webhook = compile(
    "../../../supabase/functions/retell-webhook/index.ts",
    common,
    "\nreturn handler;",
  );
  async function send(
    handler,
    agent,
    args,
    additions = {},
    key = keys[agent === "agent-a" ? "RETELL_A" : "RETELL_B"],
  ) {
    const raw = JSON.stringify({
      call: { agent_id: agent, call_id: "local-" + agent },
      args,
      ...additions,
    });
    return handler.fetch(
      new Request("https://local.test", {
        method: "POST",
        body: raw,
        headers: { "x-retell-signature": signature(raw, key) },
      }),
    );
  }
  return { db, localKeys, operations, webhook, send };
}

test("real handler scopes same-name practitioners, aliases and services to signed clinic", async () => {
  const { operations, send } = environment();
  for (const [agent, expected, spoof] of [
    ["agent-a", SA, B],
    ["agent-b", SB, A],
  ]) {
    const response = await send(
      operations.handler,
      agent,
      { action: "resolve", service_name: "Consultation", clinic_id: spoof },
      { clinic_id: spoof },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).qualified_practitioners.map((p) => p.id),
      [expected],
    );
  }
  const foreignService = await send(operations.handler, "agent-b", {
    action: "resolve",
    service_name: "Radiography",
  });
  assert.equal((await foreignService.json()).success, false);
  const foreignAlias = await send(operations.handler, "agent-b", {
    action: "resolve",
    service_name: "Consultation",
    practitioner_name: "ZetaExclusive",
  });
  assert.equal((await foreignAlias.json()).error_type, "practitioner_not_found");
  const foreignStaff = await send(operations.handler, "agent-b", {
    action: "resolve",
    service_name: "Consultation",
    practitioner_id: SA,
  });
  assert.equal((await foreignStaff.json()).error_type, "practitioner_not_found");
});

test("appointment lookup and mutation RPC arguments ignore claimed clinic", async () => {
  const { operations, send, db } = environment();
  for (const [agent, expected, spoof] of [
    ["agent-a", APPA, B],
    ["agent-b", APPB, A],
  ]) {
    const r = await send(operations.handler, agent, {
      action: "lookup",
      client_name: "Alex Test",
      client_phone: "+12025550101",
      clinic_id: spoof,
    });
    assert.deepEqual(
      (await r.json()).appointments.map((a) => a.id),
      [expected],
    );
  }
  await send(operations.handler, "agent-b", {
    action: "cancel",
    appointment_id: APPA,
    client_name: "Alex Test",
    client_phone: "+12025550101",
    confirmed: true,
    clinic_id: A,
  });
  assert.equal(db.rpcCalls[0].args.p_clinic_id, B);
});

test("actual checked-slot verifier rejects another clinic, key, expired token and tampering", async () => {
  const { operations } = environment();
  const start = { toUTC: () => ({ toISO: () => "2099-01-01T10:00:00Z" }) };
  const token = await operations.tokenFor(
    A,
    { id: SA },
    "Consultation",
    start,
    keys.RETELL_A,
    "call-a",
    "check-a",
    "slot-a",
    45,
  );
  assert.ok(await operations.readToken(token, keys.RETELL_A, A));
  const priorPayload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  delete priorPayload.m;
  const priorBody = Buffer.from(JSON.stringify(priorPayload)).toString("base64url");
  const priorMac = createHmac("sha256", keys.RETELL_A).update(priorBody).digest("base64url");
  assert.ok(await operations.readToken(`${priorBody}.${priorMac}`, keys.RETELL_A, A));
  assert.equal(await operations.readToken(token, keys.RETELL_A, B), null);
  assert.equal(await operations.readToken(token, keys.RETELL_B, A), null);
  assert.equal(await operations.readToken(token + "x", keys.RETELL_A, A), null);
  const expired = Buffer.from(JSON.stringify({ c: A, e: Date.now() - 1 })).toString("base64url");
  const mac = createHmac("sha256", keys.RETELL_A).update(expired).digest("base64url");
  assert.equal(await operations.readToken(expired + "." + mac, keys.RETELL_A, A), null);
});

test("book and reschedule reject foreign tokens before any mutation RPC", async () => {
  const { operations, send, db } = environment();
  const start = { toUTC: () => ({ toISO: () => "2099-01-01T10:00:00Z" }) };
  const token = await operations.tokenFor(
    A,
    { id: SA },
    "Consultation",
    start,
    keys.RETELL_A,
    "local-agent-a",
    "check-a",
    "slot-a",
    45,
  );
  for (const action of ["book", "reschedule"]) {
    const r = await send(operations.handler, "agent-b", {
      action,
      slot_id: token,
      clinic_id: A,
      appointment_id: APPA,
    });
    assert.equal((await r.json()).error_type, "stale_or_invalid_slot");
  }
  assert.equal(db.rpcCalls.length, 0);
});

test("unknown integration, foreign signature, shared secret and missing key fail closed", async () => {
  const { operations, send, localKeys } = environment();
  assert.equal((await send(operations.handler, "unknown", {})).status, 401);
  assert.equal((await send(operations.handler, "agent-b", {}, {}, keys.RETELL_A)).status, 401);
  localKeys.RETELL_B = localKeys.RETELL_A;
  assert.equal((await send(operations.handler, "agent-a", {})).status, 401);
  delete localKeys.RETELL_A;
  assert.equal((await send(operations.handler, "agent-a", {})).status, 401);
});

test("webhook scopes patient/appointment links and rejects reassigning another clinic call", async () => {
  const { webhook, send, db } = environment();
  const call = {
    agent_id: "agent-b",
    call_id: "webhook-b",
    from_number: "+12025550101",
    collected_dynamic_variables: { appointment_id: APPA },
    call_analysis: { call_successful: true },
  };
  const r = await send(webhook, "agent-b", {}, { event: "call_analyzed", clinic_id: A, call });
  assert.equal(r.status, 204);
  assert.equal(db.tables.conversations[0].clinic_id, B);
  assert.equal(db.tables.conversations[0].client_id, "patient-b");
  assert.equal(db.tables.conversations[0].appointment_id ?? null, null);
  db.tables.conversations[0].clinic_id = A;
  assert.equal((await send(webhook, "agent-b", {}, { event: "call_analyzed", call })).status, 403);
});

test("actual voice slot adapter queries the same clinic availability RPC and signs its duration", async () => {
  const { operations, db } = environment();
  const ranges = await operations.availableSlots(
    db,
    B,
    [db.tables.staff[1]],
    "Consultation",
    "2099-01-01",
    "UTC",
    keys.RETELL_B,
    "call-b",
    "check-b",
    undefined,
  );
  assert.equal(db.rpcCalls[0].name, "appointment_available_slots");
  assert.deepEqual(db.rpcCalls[0].args, {
    p_clinic_id: B,
    p_staff_id: SB,
    p_service: "Consultation",
    p_date: "2099-01-01",
    p_exclude_id: null,
  });
  assert.equal(ranges[0].duration_minutes, 45);
  assert.equal(ranges[0].end_time, "2099-01-01T10:45:00Z");
  const decoded = await operations.readToken(ranges[0].slot_id, keys.RETELL_B, B);
  assert.equal(decoded.m, 45);
  assert.equal(decoded.c, B);
});

test("AI reschedule availability preserves the existing practitioner even with any preference", async () => {
  const { operations, send, db } = environment();
  db.tables.staff.push({
    ...db.tables.staff[1],
    id: "bbbbbbbb-2222-4222-8222-222222222223",
    full_name: "Another practitioner",
  });
  const response = await send(operations.handler, "agent-b", {
    action: "availability",
    service_name: "Vaccination",
    practitioner_mode: "any",
    appointment_id: APPB,
    client_name: "Alex Test",
    client_phone: "+12025550101",
    requested_date: "2099-01-01",
  });
  const result = await response.json();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.selected_practitioner_id, SB);
  assert.deepEqual(
    result.slots.map((s) => s.practitioner_id),
    [SB],
  );
  assert.equal(db.rpcCalls[0].args.p_exclude_id, APPB);
  assert.equal(db.tables.voice_checked_slots[0].staff_id, SB);
});

for (const [label, rpcResult, expected] of [
  ["missing RPC response", { data: null, error: null }, "booking_invalid_response"],
  ["unconfirmed RPC response", { data: { success: true }, error: null }, "booking_invalid_response"],
  [
    "canonical protected-write conflict",
    { data: { success: false, error_type: "slot_conflict" }, error: null },
    "slot_conflict",
  ],
  [
    "unrelated internal database failure",
    { data: null, error: { code: "XX000", message: "private diagnostic" } },
    "database_error",
  ],
  [
    "deadlock outside protected appointment write",
    { data: null, error: { code: "40P01", message: "private diagnostic" } },
    "database_error",
  ],
]) {
  test(`Edge booking preserves ${label} without raw database leakage`, async () => {
    const { operations, send, db } = environment();
    const response = await send(operations.handler, "agent-b", {
      action: "availability",
      service_name: "Consultation",
      practitioner_id: SB,
      practitioner_mode: "specific",
      requested_date: "2099-01-01",
    });
    const available = await response.json();
    assert.equal(available.success, true, JSON.stringify(available));
    const slot = available.slots[0];
    assert.ok(slot);
    const originalRpc = db.rpc.bind(db);
    db.rpc = (name, args) =>
      name === "voice_apply_appointment" ? abortable(rpcResult) : originalRpc(name, args);
    const booked = await send(operations.handler, "agent-b", {
      action: "book",
      slot_id: slot.slot_id,
      client_name: "Alex Test",
      client_phone: "+12025550101",
      practitioner_id: SB,
      service_name: "Consultation",
      appointment_date: slot.date,
      appointment_time: slot.time,
    });
    const result = await booked.json();
    assert.equal(result.success, false);
    assert.equal(result.appointment_booked, false);
    assert.equal(result.appointment_id, null);
    assert.equal(result.follow_up_saved, true);
    assert.equal(db.tables.voice_requests.at(-1).clinic_id, B);
    assert.equal(result.error_type, expected, JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.ok(!JSON.stringify(result).includes("40P01"));
  });
}


test("real Edge booking accepts confirmed RPC success unchanged and creates no failed request", async () => {
  const { operations, send, db } = environment();
  const available = await (await send(operations.handler, "agent-b", {
    action: "availability", service_name: "Consultation", practitioner_id: SB,
    practitioner_mode: "specific", requested_date: "2099-01-01",
  })).json();
  const slot = available.slots[0];
  const confirmed = { success: true, appointment_booked: true, appointment_id: APPB,
    staff_id: SB, service_name: "Consultation", start_time: "2099-01-01T10:00:00Z" };
  const original = db.rpc.bind(db);
  db.rpc = (name, args) => name === "voice_apply_appointment"
    ? abortable({ data: confirmed, error: null }) : original(name, args);
  const result = await (await send(operations.handler, "agent-b", {
    action: "book", slot_id: slot.slot_id, client_name: "Alex Test",
    client_phone: "+12025550101", practitioner_id: SB, service_name: "Consultation",
    appointment_date: slot.date, appointment_time: slot.time,
  })).json();
  assert.deepEqual(result, confirmed);
  assert.equal(db.tables.voice_requests.length, 0);
});
for (const bad of [{data:null,error:{code:"XX000",message:"secret-token"}}, {data:null,error:null}, {data:[{start_time:"bad",end_time:"bad",duration_minutes:45}],error:null}]) {
 test("calendar error in real handler blocks booking and retries, retains follow-up without slots", async () => {
  const {operations,send,db}=environment();
  const original=db.rpc.bind(db);let mutations=0,checks=0;
  db.rpc=(name,args)=>{if(name==="appointment_available_slots"){checks++;return abortable(bad)}mutations++;return original(name,args)};
  const args={action:"availability",service_name:"Consultation",practitioner_mode:"specific",practitioner_id:SB,requested_date:"2099-01-01",requested_time:"10:00",client_name:"Secret Patient",client_phone:"+12025550101"};
  const result=await (await send(operations.handler,"agent-b",args)).json();
  assert.equal(result.error_type,"calendar_unavailable");assert.deepEqual(result.slots,[]);assert.equal(result.follow_up_saved,true);
  const booking=await (await send(operations.handler,"agent-b",{...args,action:"book",slot_id:"stale-token"})).json();
  assert.equal(booking.error_type,"calendar_unavailable");assert.equal(booking.appointment_confirmed,false);assert.equal(mutations,0);
  await send(operations.handler,"agent-b",{action:"invalidate"});
  const replay=await (await send(operations.handler,"agent-b",args)).json();
  assert.equal(replay.error_type,"calendar_unavailable");assert.equal(checks,1);
  const foreign=await send(operations.handler,"agent-a",{...args,action:"calendar_follow_up"},{call:{agent_id:"agent-a",call_id:"local-agent-b"}});
  assert.equal(foreign.status,403);assert.equal(db.tables.voice_requests.length,1);
 });
}
