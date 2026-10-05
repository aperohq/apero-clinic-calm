// Execute the real Edge handlers in-process with a local Supabase query adapter.
// SQL/RLS/RPC constraints are covered separately by tenant_isolation.sql.
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transpileModule } from "typescript";
import * as routing from "../../../supabase/functions/_shared/voice-routing.ts";
import * as security from "../../../supabase/functions/_shared/request-security.ts";
import * as downtime from "../../../supabase/functions/_shared/system-downtime.ts";
import * as transfer from "../../../supabase/functions/_shared/call-transfer.ts";
import * as human from "../../../supabase/functions/_shared/human-escalation.ts";
import * as unknown from "../../../supabase/functions/_shared/unknown-answer.ts";
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
    if(name === "voice_claim_transfer") {
      const old=this.tables.voice_call_state.find(r=>r.call_id===args.p_call_id);
      if(old && (old.clinic_id!==args.p_clinic_id || old.transfer_attempt_reserved))return abortable({data:false,error:null});
      const row=old??{clinic_id:args.p_clinic_id,call_id:args.p_call_id};
      Object.assign(row,{transfer_attempt_reserved:true,transfer_result:"ready",transfer_category:args.p_category});
      if(!old)this.tables.voice_call_state.push(row);
      return abortable({data:true,error:null});
    }
    if(name === "voice_record_transfer") {
      let row=this.tables.voice_call_state.find(r=>r.call_id===args.p_call_id);
      if(!row&&!args.p_attempted){row={clinic_id:args.p_clinic_id,call_id:args.p_call_id};this.tables.voice_call_state.push(row);}
      if(row?.clinic_id!==args.p_clinic_id || (args.p_attempted&&!row?.transfer_attempt_reserved))return abortable({data:{accepted:false},error:null});
      if(row.transfer_result==="success"&&args.p_result!=="success")return abortable({data:{accepted:false,result:"success"},error:null});
      row.transfer_result=args.p_result;row.transfer_fallback_saved ||= args.p_fallback_saved;
      return abortable({data:{accepted:true,result:row.transfer_result},error:null});
    }
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
    ...unknown,
    ...human,
    ...transfer,
    ...downtime,
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
  assert.deepEqual(result, {...confirmed, apero_response_received:true, system_unavailable:false});
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


test("unknown-answer follow-up uses signed clinic and explicit opt-in; foreign call ownership is blocked", async()=>{
 const {db,operations,send}=environment();
 const args={action:"unknown_answer_follow_up",question:"Unknown price",patient_name:"Private Patient",caller_phone:"2025550109",clinic_id:B};
 const declined=await (await send(operations.handler,"agent-a",args)).json();
 assert.equal(declined.follow_up_status,"not_requested");assert.equal(db.tables.voice_requests.length,0);
 const saved=await (await send(operations.handler,"agent-a",{...args,follow_up_requested:true})).json();
 assert.equal(saved.follow_up_saved,true);assert.equal(saved.answer,null);assert.equal(db.tables.voice_requests.length,1);
 assert.equal(db.tables.voice_requests[0].clinic_id,A);assert.equal(db.tables.voice_requests[0].status,"Open");
 db.tables.voice_call_state.push({clinic_id:B,call_id:"foreign-unknown"});
 const denied=await send(operations.handler,"agent-a",{...args,follow_up_requested:true},{call:{agent_id:"agent-a",call_id:"foreign-unknown"}});
 assert.equal(denied.status,403);assert.equal(db.tables.voice_requests.length,1);
});

test("unknown follow-up ownership dependency error returns safe wording and safe logs",async()=>{
 const {db,operations,send}=environment(),from=db.from.bind(db);
 db.from=table=>{const q=from(table);if(table==="voice_call_state")q.then=(yes,no)=>Promise.resolve({data:null,error:{message:"private-question-phone-secret-token"}}).then(yes,no);return q;};
 const logs=[],old=console.info;console.info=(...args)=>logs.push(args.join(" "));
 try{
 const response=await send(operations.handler,"agent-a",{action:"unknown_answer_follow_up",follow_up_requested:true,question:"private-question",caller_phone:"2025550109"});
 const body=await response.json();assert.equal(body.follow_up_saved,false);assert.equal(body.follow_up_status,"not_saved");assert.equal(body.message,unknown.UNKNOWN_SAVE_FAILED);
 assert.equal(db.tables.voice_requests.length,0);assert.equal(logs.length,1);assert.equal(logs.join().includes("private-question"),false);assert.equal(logs.join().includes("2025550109"),false);assert.equal(logs.join().includes("secret-token"),false);
 }finally{console.info=old;}
});


test("human escalation is signed, clinic scoped, and rejects foreign call ownership", async()=>{
 const {db,operations,send}=environment();
 const args={action:"human_escalation",escalation_required:true,escalation_category:"explicit_human_request",reason:"Wants receptionist assistance",clinic_id:B};
 const result=await (await send(operations.handler,"agent-a",args)).json();
 assert.equal(result.follow_up_saved,true);assert.equal(db.tables.voice_requests[0].clinic_id,A);
 assert.equal((await send(operations.handler,"agent-a",args,{},keys.RETELL_B)).status,401);
 db.tables.voice_call_state.push({clinic_id:B,call_id:"foreign-human"});
 assert.equal((await send(operations.handler,"agent-a",args,{call:{agent_id:"agent-a",call_id:"foreign-human"}})).status,403);
 assert.equal(db.tables.voice_requests.length,1);
});
test("supported requests and specific fallback categories cannot create general escalation", async()=>{
 const {db,operations,send}=environment();
 for(const category of ["supported_request","booking_failed","calendar_unavailable","unknown_answer"]){
 const result=await (await send(operations.handler,"agent-a",{action:"human_escalation",escalation_required:true,escalation_category:category,reason:"test"})).json();
 assert.equal(result.follow_up_saved,false);
 }assert.equal(db.tables.voice_requests.length,0);
});
test("human ownership dependency failure gives safe unsaved wording and metadata only",async()=>{
 const {db,operations,send}=environment(),from=db.from.bind(db);
 db.from=table=>{const q=from(table);if(table==="voice_call_state")q.then=(yes,no)=>Promise.resolve({data:null,error:{message:"private-secret-token"}}).then(yes,no);return q;};
 const logs=[],old=console.info;console.info=(...args)=>logs.push(args.join(" "));
 try{
 const body=await (await send(operations.handler,"agent-a",{action:"human_escalation",escalation_required:true,escalation_category:"explicit_human_request",reason:"private-reason"})).json();
 assert.equal(body.follow_up_saved,false);assert.equal(body.message,human.HUMAN_SAVE_FAILED);
 assert.equal(db.tables.voice_requests.length,0);assert.equal(logs.length,1);
 assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(),["call_id","category","clinic_id","follow_up_saved"]);
 assert.equal(logs.join().includes("private-"),false);
 }finally{console.info=old;}
});

test("human escalation requires provider call identity rather than tool-supplied call ID",async()=>{
 const {db,operations,send}=environment();
 const response=await send(operations.handler,"agent-a",{action:"human_escalation",escalation_required:true,escalation_category:"explicit_human_request",reason:"Staff please",call_id:"claimed-call"},{call:{agent_id:"agent-a"}});
 assert.equal((await response.json()).error_type,"missing_call_id");assert.equal(db.tables.voice_requests.length,0);
});

test("transfer guard ignores caller destinations and clinic IDs; signed call ownership is required",async()=>{
 const {db,operations,send}=environment();
 const clinic=db.tables.clinics.find(c=>c.id===A);Object.assign(clinic,{live_transfer_enabled:true,fallback_phone:"+12025550123",opening_hours:{days:Array.from({length:7},(_,day)=>({day,periods:[{start:"00:00",end:"23:59"}]}))}});
 const args={action:"transfer_gate",escalation_category:"explicit_human_request",explicit_human_request:true,live_transfer_appropriate:false,clinic_id:B,transfer_destination:"+12025550999"};
 const call={agent_id:"agent-a",call_id:"transfer-signed-call",call_type:"phone_call"};
 const result=await (await send(operations.handler,"agent-a",args,{call})).json();
 assert.equal(result.transfer_allowed,true);assert.equal(result.transfer_destination,clinic.fallback_phone);assert.equal(db.tables.voice_requests.length,0);
 assert.equal((await send(operations.handler,"agent-a",args,{call},keys.RETELL_B)).status,401);
 db.tables.conversations.push({clinic_id:B,retell_call_id:"foreign-record"});
 assert.equal((await send(operations.handler,"agent-a",args,{call:{...call,call_id:"foreign-record"}})).status,403);
 const missing=await send(operations.handler,"agent-a",{...args,call_id:"supplied-call"},{call:{agent_id:"agent-a"}});
 assert.equal((await missing.json()).error_type,"missing_call_id");
});
test("transfer success requires signed provider event; caller success/destination arguments are ignored",async()=>{
 const {db,operations,webhook,send}=environment();
 const call={agent_id:"agent-a",call_id:"provider-transfer-call",call_type:"phone_call"};
 db.tables.voice_call_state.push({clinic_id:A,call_id:call.call_id,transfer_attempt_reserved:true,transfer_result:"ready",transfer_category:"explicit_human_request"});
 assert.equal((await send(webhook,"agent-a",{}, {event:"transfer_bridged",call},keys.RETELL_B)).status,401);
 assert.equal((await send(webhook,"agent-a",{}, {event:"transfer_bridged",call})).status,204);
 assert.equal(db.tables.voice_call_state[0].transfer_result,"success");
 assert.equal((await send(webhook,"agent-a",{}, {event:"transfer_cancelled",call:{...call,disconnection_reason:"dial_busy"}})).status,204);
 assert.equal(db.tables.voice_requests.length,0);
 const result=await (await send(operations.handler,"agent-a",{action:"transfer_fallback",transfer_result:"provider_error",destination:"+12025550999"},{call})).json();
 assert.equal(result.transfer_result,"success");assert.equal(result.follow_up_saved,false);
});
test("signed transfer cancellation retains human escalation and foreign transfer events fail closed",async()=>{
 const {db,webhook,send}=environment();const call={agent_id:"agent-a",call_id:"cancel-transfer-call",disconnection_reason:"dial_no_answer",from_number:"+12025550144",direction:"inbound"};
 db.tables.voice_call_state.push({clinic_id:A,call_id:call.call_id,transfer_attempt_reserved:true,transfer_result:"ready",transfer_category:"explicit_human_request"});
 assert.equal((await send(webhook,"agent-a",{}, {event:"transfer_cancelled",call})).status,204);
 assert.equal(db.tables.voice_requests.length,1);assert.equal(db.tables.voice_requests[0].clinic_id,A);assert.equal(db.tables.voice_requests[0].phone,call.from_number);
 db.tables.voice_call_state.push({clinic_id:B,call_id:"foreign-transfer-event",transfer_attempt_reserved:true});
 assert.equal((await send(webhook,"agent-a",{}, {event:"transfer_bridged",call:{...call,call_id:"foreign-transfer-event"}})).status,403);
});

test('downtime: early database outage clears success, does not repeat failing dependency',async()=>{
 const {operations,send,db}=environment();const original=db.from.bind(db);let failures=0;const logs=[];const old=console.error;console.error=x=>logs.push(x);
 db.from=table=>{if(table==='voice_call_state'){failures++;const q={select(){return q},eq(){return q},maybeSingle(){return Promise.resolve({data:null,error:{code:'08006',message:'SECRET transcript patient'}})}};return q}return original(table)};
 try{const r=await send(operations.handler,'agent-a',{action:'lookup',client_name:'Private',client_phone:'+12025550101',clinic_id:B,phone:'+12025550999'});const b=await r.json();assert.equal(b.error_type,'system_unavailable');assert.equal(b.follow_up_saved,false);assert.equal(b.appointment_id,null);assert.equal(failures,1);assert.equal(db.tables.voice_requests.length,0);assert.deepEqual(JSON.parse(logs[0]),{clinic_id:A,call_id:null,category:'system_unavailable',dependency_category:'database_unavailable',fallback_response_returned:true});assert.ok(!JSON.stringify(logs).includes('SECRET'));}finally{console.error=old}
});
test('downtime: configuration unavailable before booking does not imply appointment',async()=>{
 const {operations,send,db}=environment();const available=await(await send(operations.handler,'agent-a',{action:'availability',service_name:'Consultation',practitioner_id:SA,practitioner_mode:'specific',requested_date:'2099-01-01'})).json();db.tables.clinics=[];
 const result=await(await send(operations.handler,'agent-a',{action:'book',slot_id:available.slots[0].slot_id,client_name:'Alex Test',client_phone:'+12025550101'})).json();assert.equal(result.system_unavailable,true);assert.equal(result.appointment_booked,false);assert.equal(result.follow_up_saved,false);assert.equal(db.tables.voice_requests.length,0);assert.equal(db.rpcCalls.filter(x=>x.name==='voice_apply_appointment').length,0);
});
test('downtime: unexpected internal error uses only signed clinic config, no caller contact',async()=>{
 const {operations,send,db}=environment();db.tables.clinics[0].fallback_phone='+12025550888';db.tables.clinics[1].fallback_phone='+12025550777';const original=db.from.bind(db);
 db.from=table=>{if(table==='clients')throw new Error('SECRET raw provider payload');return original(table)};
 const result=await(await send(operations.handler,'agent-a',{action:'lookup',client_name:'Alex Test',client_phone:'+12025550101',clinic_id:B,fallback_phone:'+12025550999'})).json();assert.equal(result.system_unavailable,true);assert.ok(result.message.includes('+12025550888'));assert.ok(!result.message.includes('+12025550777'));assert.ok(!result.message.includes('+12025550999'));assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('downtime: failed message persistence never confirms follow-up',async()=>{
 const {operations,send,db}=environment();const original=db.from.bind(db);let writes=0;db.from=table=>{const q=original(table);if(table==='voice_requests'){q.insert=()=>{writes++;return q};q.then=(yes,no)=>Promise.resolve({data:null,error:{code:'08006',message:'private'}}).then(yes,no)}return q};
 const result=await(await send(operations.handler,'agent-a',{action:'message',caller_phone:'+12025550101',reason:'Private request'})).json();assert.equal(result.success,false);assert.equal(result.follow_up_saved,false);assert.equal(result.request_id,null);assert.equal(result.system_unavailable,true);assert.equal(writes,1);
});
test('downtime: cancellation dependency failure is uncertain and never confirmed',async()=>{
 const {operations,send,db}=environment();const original=db.rpc.bind(db);db.rpc=(name,args)=>name==='voice_apply_appointment'?abortable({data:null,error:{code:'08006',message:'secret-token'}}):original(name,args);
 const b=await(await send(operations.handler,'agent-a',{action:'cancel',appointment_id:APPA,client_name:'Alex Test',client_phone:'+12025550101',confirmed:true})).json();assert.equal(b.system_unavailable,true);assert.equal(b.success,false);assert.equal(b.appointment_id,null);assert.ok(b.patient_instruction.includes('do not claim it failed or succeeded'));assert.equal(db.tables.voice_requests.length,0);
});
