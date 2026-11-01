import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { PGlite } from "@electric-sql/pglite";

const load = async (path) => {
  const { code } = await transform(await readFile(new URL(path, import.meta.url), "utf8"), {
    loader: "ts",
    format: "esm",
  });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
};
const { createDemoCallFunction } = await load("../supabase/functions/demo-call/function.ts");
const { DemoCallController } = await load("../src/lib/demo-call.ts");
const clinic = "11111111-1111-4111-8111-111111111111",
  user = "00000000-0000-4000-8000-000000000001",
  otherUser = "00000000-0000-4000-8000-000000000002";
const agent = "agent_b84b2766efeb85afc809147d7a",
  flow = "conversation_flow_43f53e5e8531";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const migration = await readFile(
  new URL("../supabase/migrations/20261031120000_demo_call_sessions.sql", import.meta.url),
  "utf8",
);

// Minimal disposable PostgreSQL fixtures use the existing schema's real column names/types.
// No environment credentials, remote database, provider or microphone is accessed.
async function fixture() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create table public.clinics(id uuid primary key);
    create type profile_role as enum ('owner','manager','staff');
    create table public.profiles(auth_user_id uuid, clinic_id uuid,role profile_role, revoked_at timestamptz);
    insert into auth.users values('${user}'),('${otherUser}'); insert into clinics values('${clinic}');
    insert into profiles values('${user}','${clinic}','owner',null),('${otherUser}','${clinic}','owner',null);`);
  await db.exec(migration);
  await db.exec(
    await readFile(
      new URL("../supabase/migrations/20261101120000_demo_call_recovery.sql", import.meta.url),
      "utf8",
    ),
  );
  const config = {
    APERO_PORTAL_ORIGIN: "https://portal.example",
    APERO_DEMO_ENABLED: "true",
    APERO_DEMO_CLINIC_ID: clinic,
    APERO_DEMO_AGENT_VERSION: "16",
    SUPABASE_URL: "https://database.example",
    SUPABASE_ANON_KEY: "public-fixture",
    SUPABASE_SERVICE_ROLE_KEY: "private-fixture",
    RETELL_API_KEY: "retell-fixture-secret",
  };
  const state = {
    auth: true,
    profile: { auth_user_id: user, clinic_id: clinic, role: "owner", revoked_at: null },
    database: true,
    published: true,
    version: 16,
    active: true,
    terminal: false,
    createMode: "ok",
    providerCreates: 0,
    providerStops: 0,
    callCounter: 0,
    actor: user,
    calls: new Map(),
    getStatus: 200,
    stopMode: "ok",
    callOverrides: {},
    providerReads: 0,
    auditAvailable: true,
  };
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init.redirect, "error");
    if (url.host === "database.example") {
      if (url.pathname === "/auth/v1/user")
        return Response.json({ id: state.actor }, { status: state.auth ? 200 : 401 });
      if (!state.database) return Response.json({}, { status: 503 });
      if (url.pathname === "/rest/v1/profiles")
        return Response.json(state.profile ? [state.profile] : []);
      if (url.pathname === "/rest/v1/voice_integrations")
        return Response.json([
          {
            agent_id: agent,
            conversation_flow_id: flow,
            secret_env_name: "RETELL_API_KEY",
            active: state.active,
          },
        ]);
      if (url.pathname === "/rest/v1/rpc/demo_call_session") {
        const p = JSON.parse(init.body);
        assert.equal(p.p_user_id, state.actor, "identity comes from verified Auth response");
        const result = await db.query("select public.demo_call_session($1,$2,$3,$4,$5) as result", [
          p.p_command,
          p.p_user_id,
          p.p_clinic_id,
          p.p_request_id,
          p.p_call_id,
        ]);
        return Response.json(result.rows[0].result);
      }
      if (url.pathname === "/rest/v1/rpc/demo_recover_session") {
        if (!state.auditAvailable) return Response.json({}, { status: 503 });
        const p = JSON.parse(init.body);
        assert.equal(p.p_user_id, state.actor);
        const result = await db.query(
          "select public.demo_recover_session($1,$2,$3,$4,$5,$6,$7) as result",
          [
            p.p_command,
            p.p_user_id,
            p.p_clinic_id,
            p.p_request_id,
            p.p_call_id,
            p.p_outcome,
            p.p_provider_status,
          ],
        );
        return Response.json(result.rows[0].result);
      }
      throw new Error("Unexpected database operation");
    }
    assert.equal(url.origin, "https://api.retellai.com");
    assert.equal(init.headers.Authorization, "Bearer retell-fixture-secret");
    if (url.pathname.startsWith("/get-agent/"))
      return Response.json({
        agent_id: agent,
        version: state.version,
        is_published: state.published,
        response_engine: { conversation_flow_id: flow, version: 16 },
      });
    if (url.pathname === "/v3/create-web-call") {
      state.providerCreates++;
      const body = JSON.parse(init.body);
      assert.equal(body.agent_id, agent);
      assert.equal(body.agent_version, 16);
      assert.equal(body.agent_override, undefined);
      if (state.createMode === "timeout") throw new Error("PRIVATE provider timeout");
      if (state.createMode === "rejected")
        return Response.json({ private: "diagnostic" }, { status: 400 });
      const callId = `call_fixture_${++state.callCounter}`;
      state.calls.set(callId, {
        agent_id: agent,
        agent_version: 16,
        call_type: "web_call",
        call_id: callId,
        metadata: body.metadata,
      });
      if (state.createMode === "timeout_created")
        throw new Error("PRIVATE timeout after provider creation");
      if (state.onCreate) await state.onCreate(body.metadata.demo_session_id);
      if (state.createMode === "cancel")
        await db.query("select demo_call_session('cancel',$1,$2,$3,null)", [
          user,
          clinic,
          body.metadata.demo_session_id,
        ]);
      return Response.json({
        call_id: callId,
        access_token: "short-lived-fixture-token",
        transport: "gateway",
        ice_servers: [],
        expires_at: Date.now() + 60000,
        private_key: "NEVER_RETURN_THIS",
      });
    }
    if (url.pathname.startsWith("/v2/stop-call/")) {
      state.providerStops++;
      if (state.stopMode === "failed") return Response.json({}, { status: 503 });
      if (state.stopMode !== "pending") state.terminal = true;
      return Response.json({});
    }
    if (url.pathname.startsWith("/v2/get-call/")) {
      state.providerReads++;
      if (state.getStatus !== 200) return Response.json({}, { status: state.getStatus });
      const call = state.calls.get(url.pathname.split("/").at(-1));
      if (!call) return Response.json({}, { status: 404 });
      return Response.json({
        call_status: state.terminal ? "ended" : "ongoing",
        ...call,
        ...state.callOverrides,
      });
    }
    throw new Error("Unexpected provider operation");
  };
  const handler = createDemoCallFunction((name) => config[name], fetcher);
  const request = (
    operation = "create",
    requestId = id(10),
    patch = {},
    token = "user-token",
    origin = config.APERO_PORTAL_ORIGIN,
  ) =>
    handler(
      new Request("https://database.example/functions/v1/demo-call", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          operation,
          ...(operation === "access" ? {} : { requestId }),
          ...patch,
        }),
      }),
    );
  return { db, state, config, request };
}

test("demo proxy enforces auth and membership, returns only scoped credentials, owns cleanup", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await t.test("missing/invalid authentication never reaches provider", async () => {
    assert.equal((await f.request("create", id(10), {}, "")).status, 401);
    f.state.auth = false;
    assert.equal((await f.request()).status, 401);
    f.state.auth = true;
    assert.equal(f.state.providerCreates, 0);
  });
  for (const [name, patch] of [
    ["non Owner", { role: "manager" }],
    ["staff", { role: "staff" }],
    ["revoked", { revoked_at: new Date().toISOString() }],
    ["foreign clinic", { clinic_id: id(999) }],
    ["spoofed user", { auth_user_id: otherUser }],
  ]) {
    await t.test(name, async () => {
      const old = { ...f.state.profile };
      Object.assign(f.state.profile, patch);
      assert.equal((await f.request()).status, 403);
      f.state.profile = old;
    });
  }
  await t.test("missing membership and unavailable checks fail closed", async () => {
    const old = f.state.profile;
    f.state.profile = null;
    assert.equal((await f.request()).status, 403);
    f.state.profile = old;
    f.state.database = false;
    assert.equal((await f.request()).status, 503);
    f.state.database = true;
    f.config.APERO_DEMO_ENABLED = "false";
    assert.equal((await f.request()).status, 503);
    f.config.APERO_DEMO_ENABLED = "true";
  });
  await t.test("origin and arbitrary agent/user overrides rejected", async () => {
    assert.equal(
      (await f.request("create", id(10), {}, "token", "https://evil.example")).status,
      403,
    );
    for (const patch of [
      { agent_id: "other" },
      { agent_override: {} },
      { userId: otherUser },
      { callId: "other" },
    ])
      assert.equal((await f.request("create", id(10), patch)).status, 400);
    assert.equal(f.state.providerCreates, 0);
  });
  await t.test("unpublished, changed version or inactive mapping rejected", async () => {
    f.state.published = false;
    assert.equal((await f.request()).status, 503);
    f.state.published = true;
    f.state.version = 17;
    assert.equal((await f.request()).status, 503);
    f.state.version = 16;
    f.state.active = false;
    assert.equal((await f.request()).status, 503);
    f.state.active = true;
  });
  await t.test("access verifies server membership without creating a call", async () => {
    assert.deepEqual(await (await f.request("access")).json(), { allowed: true });
    assert.equal(f.state.providerCreates, 0);
  });
  await t.test("create connection allowlist, duplicate session and ownership", async () => {
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.deepEqual(Object.keys(data).sort(), [
      "access_token",
      "call_id",
      "expires_at",
      "ice_servers",
      "transport",
    ]);
    assert.ok(!JSON.stringify(data).includes("retell-fixture-secret"));
    assert.equal((await f.request("create", id(11))).status, 409);
    assert.equal(f.state.providerCreates, 1);
    f.state.actor = otherUser;
    f.state.profile.auth_user_id = otherUser;
    assert.equal((await f.request("stop")).status, 403);
    assert.equal(f.state.providerStops, 0);
    f.state.actor = user;
    f.state.profile.auth_user_id = user;
    assert.equal((await f.request("stop")).status, 200);
    assert.equal(f.state.providerStops, 1);
    assert.equal((await f.request("stop")).status, 200);
  });
  await t.test("database RPC rechecks revoked membership", async () => {
    await f.db.query("update profiles set revoked_at=now() where auth_user_id=$1", [user]);
    assert.equal((await f.request("access")).status, 403);
    await f.db.query("update profiles set revoked_at=null where auth_user_id=$1", [user]);
  });
  await t.test("cancellation before reservation cannot create a call", async () => {
    assert.equal((await f.request("stop", id(12))).status, 200);
    assert.equal((await f.request("create", id(12))).status, 409);
    assert.equal(f.state.providerCreates, 1);
  });
  await t.test("browser roles cannot read sessions or execute privileged RPC", async () => {
    const { rows } = await f.db.query(
      "select has_table_privilege('authenticated','demo_call_sessions','select') as table_access, has_function_privilege('authenticated','demo_call_session(text,uuid,uuid,uuid,text)','execute') as rpc_access",
    );
    assert.deepEqual(rows[0], { table_access: false, rpc_access: false });
  });
});

test("competing creations share the database reservation", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const responses = await Promise.all([f.request("create", id(40)), f.request("create", id(41))]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.state.providerCreates, 1);
});

test("already ended provider calls release locks without another stop", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  assert.equal((await f.request()).status, 200);
  f.state.terminal = true;
  assert.equal((await f.request("stop")).status, 200);
  assert.equal(f.state.providerStops, 0);
});

test("uncertain provider outcome holds lock; definitive rejection releases it", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.state.createMode = "rejected";
  assert.equal((await f.request()).status, 502);
  f.state.createMode = "timeout";
  const result = await f.request("create", id(11));
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { code: "unavailable" });
  assert.equal((await f.request("create", id(12))).status, 409);
  assert.equal((await f.request("stop", id(11))).status, 409);
});

test("cancellation during creation stops newly attached call", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.state.createMode = "cancel";
  assert.equal((await f.request()).status, 409);
  assert.equal(f.state.providerStops, 1);
  assert.equal((await f.db.query("select ended from demo_call_sessions")).rows[0].ended, true);
});

test("shared database reservations enforce six attempts per clinic/hour", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  for (let n = 10; n < 16; n++) {
    f.state.terminal = false;
    assert.equal((await f.request("create", id(n))).status, 200);
    assert.equal((await f.request("stop", id(n))).status, 200);
  }
  assert.equal((await f.request("create", id(16))).status, 429);
  assert.equal(f.state.providerCreates, 6);
});

function controllerFixture({ deferredClient = false, deferredCreate = false } = {}) {
  let hooks,
    releaseClient,
    releaseCreate,
    created = 0,
    ended = 0,
    muted = 0,
    unmuted = 0,
    stopped = 0,
    failCleanup = false;
  const snapshots = [],
    remembered = [],
    samples = [];
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const sdk = {
    createWebCall(options) {
      created++;
      hooks = options.hooks;
      const ready = Promise.resolve().then(async () => {
        await config.fetch("https://api.retellai.com/v3/create-web-call", { method: "POST" });
        if (deferredCreate) await createGate;
        hooks.onStatus("live");
      });
      return {
        ready,
        end: async () => {
          ended++;
          hooks.onEnd({});
        },
        startAudioPlayback: async () => undefined,
        mute: () => muted++,
        unmute: () => unmuted++,
      };
    },
  };
  let config;
  const clientGate = new Promise((resolve) => {
    releaseClient = () => resolve(sdk);
  });
  const c = new DemoCallController(
    async (operation) => {
      if (operation === "stop") {
        stopped++;
        return Response.json({}, { status: failCleanup ? 409 : 200 });
      }
      return Response.json({});
    },
    async (c) => {
      config = c;
      return deferredClient ? clientGate : sdk;
    },
    (s) => snapshots.push(s),
    (a) => samples.push(a),
    (id) => remembered.push(id),
  );
  return {
    c,
    snapshots,
    remembered,
    samples,
    releaseClient: () => releaseClient(),
    releaseCreate: () => releaseCreate(),
    setFail: (v) => {
      failCleanup = v;
    },
    hooks: () => hooks,
    counts: () => ({ created, ended, muted, unmuted, stopped }),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("controller duplicate starts, mute, audio, end and reentrant cleanup", async () => {
  const f = controllerFixture();
  await Promise.all([f.c.start(), f.c.start()]);
  assert.equal(f.counts().created, 1);
  assert.equal(f.snapshots.at(-1).state, "active");
  f.c.mute();
  assert.equal(f.snapshots.at(-1).state, "muted");
  f.c.mute();
  f.hooks().onAudio(new Float32Array([0.3]));
  assert.equal(f.samples.at(-1)[0], Math.fround(0.3));
  await f.c.stop();
  assert.deepEqual(f.counts(), { created: 1, ended: 1, muted: 1, unmuted: 1, stopped: 1 });
  assert.equal(f.remembered.at(-1), undefined);
  f.hooks().onStatus("live");
  assert.equal(f.snapshots.at(-1).state, "ended");
});
test("controller cancellation during import never creates a call", async () => {
  const f = controllerFixture({ deferredClient: true });
  const start = f.c.start();
  await f.c.stop();
  f.releaseClient();
  await start;
  assert.equal(f.counts().created, 0);
});
test("controller permission errors end session and preserve sanitized error", async () => {
  const f = controllerFixture();
  await f.c.start();
  const e = new Error("PRIVATE");
  e.name = "NotAllowedError";
  f.hooks().onError(e);
  await tick();
  assert.equal(f.snapshots.at(-1).state, "error");
  assert.match(f.snapshots.at(-1).message, /Microphone access was denied/);
  assert.equal(f.counts().stopped, 1);
});
test("controller pending cleanup blocks new calls and supports recovery", async () => {
  const f = controllerFixture();
  await f.c.start();
  f.setFail(true);
  await f.c.stop();
  await f.c.start();
  assert.equal(f.counts().created, 1);
  assert.equal(f.snapshots.at(-1).cleanupPending, true);
  f.setFail(false);
  await f.c.stop();
  assert.equal(f.snapshots.at(-1).cleanupPending, false);
  assert.equal(f.snapshots.at(-1).message, "");
  assert.equal(f.snapshots.at(-1).state, "ready");
  await f.c.recover(id(30));
  assert.equal(f.counts().stopped, 3);
  assert.deepEqual(f.snapshots.at(-1), { state: "ready", cleanupPending: false, message: "" });
});
test("controller ignores stale live status after cancellation during creation", async () => {
  const f = controllerFixture({ deferredCreate: true });
  const start = f.c.start();
  await tick();
  await f.c.stop();
  f.releaseCreate();
  await start;
  assert.equal(f.snapshots.at(-1).state, "ended");
  assert.equal(f.counts().stopped, 1);
});
test("both routes are guarded and fake timer/speaking states are absent", async () => {
  for (const route of ["voice-demo", "demo"])
    assert.match(
      await readFile(new URL(`../src/routes/${route}.tsx`, import.meta.url), "utf8"),
      /<DemoAccess>/,
    );
  const page = await readFile(new URL("../src/routes/voice-demo.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /setTimeout|simulated|Apero is speaking|Listening…/);
});

// Recovery uses mocked Retell responses and the real new PostgreSQL RPC/audit tables.
async function enroll(f, operator = user) {
  await f.db.query("insert into demo_recovery_operators(auth_user_id,clinic_id) values($1,$2)", [
    operator,
    clinic,
  ]);
}
async function locked(f, requestId = id(10)) {
  return (
    await f.db.query("select not ended as locked from demo_call_sessions where request_id=$1", [
      requestId,
    ])
  ).rows[0].locked;
}
async function audit(f) {
  return (
    await f.db.query(
      "select actor_user_id, request_id, outcome, provider_status from demo_call_recovery_audit order by id",
    )
  ).rows;
}

test("disabled switch blocks creation but preserves authorized access, owned stop and recovery", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  assert.equal((await f.request()).status, 200);
  f.config.APERO_DEMO_ENABLED = "false";
  const creates = f.state.providerCreates;
  assert.equal((await f.request("create", id(11))).status, 503);
  for (const operation of [["create"], { toString: "create" }, null, 1]) {
    assert.equal((await f.request("create", id(11), { operation })).status, 400);
  }
  assert.deepEqual(await (await f.request("access")).json(), { allowed: true });
  assert.equal((await f.request("stop")).status, 200);
  assert.equal(f.state.providerCreates, creates);
  assert.equal(await locked(f), false);
  f.state.actor = otherUser;
  f.state.profile.auth_user_id = otherUser;
  assert.equal((await f.request("stop")).status, 403);
  assert.equal((await f.request("recover")).status, 403);
  assert.equal((await f.request("recover", id(10), {}, "")).status, 401);
});

test("failed termination and pending provider acknowledgement retain lock until verified retry", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.request();
  f.state.stopMode = "failed";
  assert.equal((await f.request("stop")).status, 409);
  assert.equal(await locked(f), true);
  f.state.stopMode = "pending";
  assert.equal((await f.request("stop")).status, 409);
  assert.equal(await locked(f), true);
  assert.equal((await f.request("create", id(11))).status, 409);
  f.state.stopMode = "ok";
  assert.equal((await f.request("stop")).status, 200);
  assert.equal(await locked(f), false);
});

test("provider errors or identity mismatch never trigger stop or release", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.request();
  for (const status of [401, 404, 500]) {
    f.state.getStatus = status;
    assert.equal((await f.request("stop")).status, 503);
    assert.equal(await locked(f), true);
  }
  f.state.getStatus = 200;
  for (const patch of [
    { agent_id: "unrelated" },
    { agent_version: 17 },
    { call_type: "phone_call" },
    { metadata: { source: "apero_private_demo", demo_session_id: id(999) } },
    { metadata: {} },
    { call_id: "unrelated" },
  ]) {
    f.state.callOverrides = patch;
    assert.equal((await f.request("stop")).status, 409);
    assert.equal(await locked(f), true);
  }
  assert.equal(f.state.providerStops, 0);
});

test("unknown creation retains lock until enrolled operator verifies exact terminal call", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.state.createMode = "timeout_created";
  assert.equal((await f.request()).status, 503);
  assert.equal(await locked(f), true);
  f.config.APERO_DEMO_ENABLED = "false";
  const reads = f.state.providerReads;
  assert.equal(
    (await f.request("recover", id(10), { candidateCallId: "call_fixture_1" })).status,
    403,
  );
  assert.equal(f.state.providerReads, reads, "non-operator cannot inspect provider calls");
  await enroll(f);
  assert.equal((await f.request("recover")).status, 409);
  assert.equal(await locked(f), true);
  assert.equal(
    (await f.request("recover", id(10), { candidateCallId: "call_fixture_1" })).status,
    409,
  );
  assert.equal(await locked(f), true);
  assert.equal(f.state.providerStops, 0, "operator recovery never stops active calls");
  // Neither very old reservations nor guessed missing IDs provide proof of termination.
  await f.db.query(
    "update demo_call_sessions set created_at=now()-interval '10 days' where request_id=$1",
    [id(10)],
  );
  assert.equal(
    (await f.request("recover", id(10), { candidateCallId: "missing_call" })).status,
    503,
  );
  assert.equal(await locked(f), true);
  f.state.terminal = true;
  assert.deepEqual(
    await (await f.request("recover", id(10), { candidateCallId: "call_fixture_1" })).json(),
    { recovered: true },
  );
  assert.equal(await locked(f), false);
  const row = (await f.db.query("select call_id from demo_call_sessions")).rows[0];
  assert.equal(row.call_id, "call_fixture_1");
  const entries = await audit(f);
  assert.ok(entries.some((a) => a.outcome === "not_authorized"));
  assert.ok(entries.some((a) => a.outcome === "candidate_required"));
  assert.ok(entries.some((a) => a.outcome === "provider_active"));
  assert.ok(entries.some((a) => a.outcome === "provider_unavailable"));
  assert.equal(entries.at(-1).outcome, "recovered");
  assert.equal(entries.at(-1).provider_status, "ended");
  assert.equal(entries.at(-1).actor_user_id, user);
});

test("unknown outcome with no discoverable provider call requires manual intervention", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  f.state.createMode = "timeout";
  await f.request();
  await enroll(f);
  const response = await f.request("recover");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: "operator_intervention_required" });
  assert.equal(await locked(f), true);
  assert.equal(f.state.providerStops, 0);
});

test("operators can reconcile another Owner's session, but cannot substitute or terminate calls", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.request();
  await enroll(f, otherUser);
  f.state.actor = otherUser;
  f.state.profile.auth_user_id = otherUser;
  assert.equal((await f.request("stop")).status, 403);
  assert.equal(
    (await f.request("recover", id(10), { candidateCallId: "different_call" })).status,
    409,
  );
  assert.equal((await f.request("recover")).status, 409);
  assert.equal(await locked(f), true);
  assert.equal(f.state.providerStops, 0);
  f.state.terminal = true;
  assert.equal((await f.request("recover")).status, 200);
  assert.equal((await audit(f)).at(-1).actor_user_id, otherUser);
});

test("operator enrollment alone cannot bypass active Owner membership", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.request();
  await enroll(f);
  for (const patch of [
    { role: "staff" },
    { role: "manager" },
    { revoked_at: new Date().toISOString() },
    { clinic_id: id(999) },
  ]) {
    const old = { ...f.state.profile };
    Object.assign(f.state.profile, patch);
    assert.equal((await f.request("recover")).status, 403);
    f.state.profile = old;
  }
  await f.db.query("update demo_recovery_operators set active=false");
  assert.equal((await f.request("recover")).status, 403);
  assert.equal(await locked(f), true);
  await f.db.query("update demo_recovery_operators set active=true");
  await f.db.query("update profiles set revoked_at=now() where auth_user_id=$1", [user]);
  assert.equal((await f.request("recover")).status, 403);
  assert.equal(await locked(f), true);
});

test("audit failure and unrecognized or mismatched provider states fail closed", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.request();
  await enroll(f);
  f.state.terminal = true;
  f.state.auditAvailable = false;
  const before = f.state.providerReads;
  assert.equal((await f.request("recover")).status, 503);
  assert.equal(f.state.providerReads, before);
  assert.equal(await locked(f), true);
  f.state.auditAvailable = true;
  for (const patch of [
    { call_status: "unknown" },
    { call_type: "phone_call" },
    { agent_id: "other" },
    { metadata: {} },
    { agent_version: 17 },
  ]) {
    f.state.callOverrides = patch;
    assert.equal((await f.request("recover")).status, 409);
    assert.equal(await locked(f), true);
  }
  f.state.callOverrides = {};
  assert.equal((await f.request("recover")).status, 200);
});

test("recovery RPC cannot release active calls, and browser cannot access enrollment or audit", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.request();
  await enroll(f);
  const result = await f.db.query(
    "select demo_recover_session('finish',$1,$2,$3,$4,null,'ongoing') as result",
    [user, clinic, id(10), "call_fixture_1"],
  );
  assert.equal(result.rows[0].result.code, "invalid_recovery");
  assert.equal(await locked(f), true);
  for (const role of ["anon", "authenticated"]) {
    const { rows } = await f.db.query(
      "select has_table_privilege($1,'demo_recovery_operators','select,insert,update,delete') as enrollment, has_table_privilege($1,'demo_call_recovery_audit','select,insert,update,delete') as audit, has_function_privilege($1,'demo_recover_session(text,uuid,uuid,uuid,text,text,text)','execute') as rpc",
      [role],
    );
    assert.deepEqual(rows[0], { enrollment: false, audit: false, rpc: false });
  }
  assert.equal(
    (
      await f.db.query(
        "select has_table_privilege('service_role','demo_call_recovery_audit','update,delete') as can_rewrite",
      )
    ).rows[0].can_rewrite,
    false,
  );
});

test("recovery audit and lock release commit atomically", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.request();
  await enroll(f);
  f.state.terminal = true;
  await f.db
    .exec(`create function reject_recovery_audit() returns trigger language plpgsql as $$ begin
    if new.outcome='recovered' then raise exception 'fixture audit storage unavailable'; end if; return new; end $$;
    create trigger reject_recovery_audit before insert on demo_call_recovery_audit for each row execute function reject_recovery_audit();`);
  // Simulate a database response failure without leaking SQL or private diagnostics.
  const response = await f.request("recover");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "unavailable" });
  assert.equal(await locked(f), true);
  assert.ok(!(await audit(f)).some((a) => a.outcome === "recovered"));
  await f.db.exec("drop trigger reject_recovery_audit on demo_call_recovery_audit");
  assert.equal((await f.request("recover")).status, 200);
  assert.equal(await locked(f), false);
});

test("recovery during creation cancels token delivery without permitting duplicates", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await enroll(f);
  f.state.onCreate = async (requestId) => {
    const recovery = await f.request("recover", requestId, { candidateCallId: "call_fixture_1" });
    assert.equal(recovery.status, 409);
    assert.equal((await recovery.json()).code, "provider_active");
    assert.equal((await f.request("create", id(11))).status, 409);
  };
  const response = await f.request();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { code: "call_cancelled" });
  assert.equal(f.state.providerCreates, 1);
  assert.equal(f.state.providerStops, 1);
  assert.equal(await locked(f), false);
});

test("recovery cannot accept caller claims of terminal status or force release", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await f.request();
  await enroll(f);
  const before = f.state.providerReads;
  for (const patch of [
    { provider_status: "ended" },
    { force: true },
    { userId: otherUser },
    { agent_id: "other" },
    { clinic_id: clinic },
  ]) {
    assert.equal((await f.request("recover", id(10), patch)).status, 400);
  }
  assert.equal(f.state.providerReads, before);
  assert.equal(await locked(f), true);
});
