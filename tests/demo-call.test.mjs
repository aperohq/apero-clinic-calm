import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createDemoCallFunction } from "../supabase/functions/demo-call/function.ts";
import { DemoCallController } from "../src/lib/demo-call.ts";

const clinic = "11111111-1111-4111-8111-111111111111",
  user = "22222222-2222-4222-8222-222222222222",
  requestId = "33333333-3333-4333-8333-333333333333";
const agent = "agent_b84b2766efeb85afc809147d7a",
  flow = "conversation_flow_43f53e5e8531";
function fixture(options = {}) {
  const env = {
    APERO_PORTAL_ORIGIN: "https://demo.example",
    SUPABASE_URL: "https://db.example",
    SUPABASE_ANON_KEY: "public-key",
    SUPABASE_SERVICE_ROLE_KEY: "PRIVATE_SERVICE",
    APERO_DEMO_CLINIC_ID: clinic,
    APERO_DEMO_AGENT_ID: agent,
    APERO_DEMO_ENABLED: "true",
    RETELL_API_KEY: "PRIVATE_RETELL",
    ...options.env,
  };
  const requests = [],
    sessions = new Map();
  let status = options.callStatus ?? "registered";
  const fetcher = async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url);
    requests.push({ url, init });
    assert.equal(init.redirect, "error");
    if (url.origin === "https://db.example") {
      if (url.pathname === "/auth/v1/user")
        return Response.json({ id: user }, { status: options.authStatus ?? 200 });
      if (url.pathname === "/rest/v1/profiles")
        return Response.json([
          {
            auth_user_id: user,
            clinic_id: clinic,
            role: options.role ?? "owner",
            revoked_at: null,
          },
        ]);
      assert.equal(req.headers.get("apikey"), "PRIVATE_SERVICE");
      if (url.pathname === "/rest/v1/voice_integrations")
        return Response.json([
          {
            agent_id: agent,
            conversation_flow_id: flow,
            secret_env_name: "RETELL_API_KEY",
            active: true,
            ...options.mapping,
          },
        ]);
      assert.equal(url.pathname, "/rest/v1/rpc/demo_call_session");
      const b = await req.json();
      assert.equal(b.p_user_id, user);
      assert.equal(b.p_clinic_id, clinic);
      if (b.p_command === "authorize") return Response.json({ ok: true });
      if (b.p_command === "outstanding") return Response.json(options.outstanding ?? {});
      if (b.p_command === "reserve") {
        if (options.reservation) return Response.json(options.reservation);
        sessions.set(b.p_request_id, { request_id: b.p_request_id, call_id: null });
        return Response.json({ ok: true });
      }
      if (b.p_command === "attach") {
        const r = {
          request_id: b.p_request_id,
          call_id: b.p_call_id,
          cancel_requested: options.cancelled ?? false,
        };
        sessions.set(b.p_request_id, r);
        return Response.json(r);
      }
      if (b.p_command === "cancel")
        return Response.json(
          sessions.get(b.p_request_id) ?? {
            request_id: b.p_request_id,
            call_id: options.stopCall ?? null,
            ended: !options.stopCall,
          },
        );
      if (b.p_command === "finish") return Response.json({ ended: true });
      assert.fail("Unexpected RPC");
    }
    assert.equal(
      url.origin,
      "https://api.retellai.com",
      "All network replaced by deterministic fixture",
    );
    assert.equal(req.headers.get("authorization"), "Bearer PRIVATE_RETELL");
    if (url.pathname.startsWith("/get-agent/")) {
      assert.equal(url.search, "?version=latest_published");
      return Response.json({
        agent_id: agent,
        is_published: true,
        version: options.version ?? 22,
        response_engine: {
          type: "conversation-flow",
          conversation_flow_id: flow,
          version: options.version ?? 22,
        },
        ...options.published,
      });
    }
    if (url.pathname === "/v3/create-web-call") {
      assert.deepEqual(await req.json(), {
        agent_id: agent,
        agent_version: "latest_published",
        metadata: { source: "apero_private_demo", demo_session_id: requestId },
      });
      if (options.throwCreate) throw new Error("PRIVATE_RETELL network error");
      return Response.json(
        {
          call_id: "call_fixture",
          access_token: "call-scoped-token",
          transport: "gateway",
          expires_at: 1800000000,
          ice_servers: [
            {
              urls: ["turn:turn.example"],
              username: "turn-user",
              credential: "turn-password",
              private_debug: "PRIVATE_PROVIDER",
            },
          ],
          private_debug: "PRIVATE_RETELL",
          ...options.connection,
        },
        { status: options.createStatus ?? 200 },
      );
    }
    if (url.pathname === "/v2/get-call/call_fixture")
      return Response.json({
        call_id: "call_fixture",
        agent_id: options.wrongIdentity ? "agent_foreign" : agent,
        call_type: "web_call",
        call_status: status,
        metadata: { source: "apero_private_demo", demo_session_id: requestId },
      });
    if (url.pathname === "/v2/stop-call/call_fixture") {
      status = "ended";
      return Response.json({});
    }
    assert.fail("Unexpected endpoint " + url.pathname);
  };
  const handler = createDemoCallFunction((n) => env[n], fetcher);
  const call = async (body = { operation: "create", requestId }, override = {}) => {
    const response = await handler(
      new Request("https://db.example/functions/v1/demo-call", {
        method: "POST",
        headers: {
          origin: "https://demo.example",
          authorization: "Bearer fixture-user",
          "content-type": "application/json",
          ...override.headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
        ...Object.fromEntries(Object.entries(override).filter(([k]) => k !== "headers")),
      }),
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    for (const secret of ["PRIVATE_RETELL", "PRIVATE_SERVICE", "PRIVATE_PROVIDER"])
      assert.ok(!text.includes(secret));
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
    };
  };
  return { call, requests, sessions, handler };
}

test("successful creation returns only connection allowlist and configured agent, following published versions", async () => {
  for (const version of [22, 23]) {
    const f = fixture({ version });
    const r = await f.call();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      call_id: "call_fixture",
      access_token: "call-scoped-token",
      transport: "gateway",
      expires_at: 1800000000,
      ice_servers: [
        { urls: ["turn:turn.example"], username: "turn-user", credential: "turn-password" },
      ],
    });
    assert.equal(r.headers.get("access-control-allow-origin"), "https://demo.example");
    assert.ok(!JSON.stringify(r.body).includes(agent));
  }
});
test("missing config, disabled demo, mapping mismatch and unpublished agent fail closed", async () => {
  for (const options of [
    { env: { APERO_PORTAL_ORIGIN: undefined } },
    { env: { SUPABASE_SERVICE_ROLE_KEY: undefined } },
    { env: { APERO_DEMO_CLINIC_ID: undefined } },
    { env: { APERO_DEMO_AGENT_ID: undefined } },
    { env: { RETELL_API_KEY: undefined } },
    { env: { APERO_DEMO_ENABLED: "false" } },
    { env: { APERO_DEMO_AGENT_ID: "agent_other" } },
    { mapping: { active: false } },
    { published: { is_published: false } },
    {
      published: {
        response_engine: {
          type: "conversation-flow",
          conversation_flow_id: "conversation_flow_foreign",
          version: 22,
        },
      },
    },
  ]) {
    const f = fixture(options);
    assert.ok((await f.call()).status >= 400);
    assert.equal(f.requests.filter((r) => r.url.pathname === "/v3/create-web-call").length, 0);
  }
});
test("malformed body, injected overrides, oversized input, foreign origin, wrong method and missing auth", async () => {
  for (const [body, override, status] of [
    ["{", {}, 400],
    [null, {}, 400],
    [{ operation: "create", requestId, agent_id: "agent_foreign" }, {}, 400],
    [{ operation: "create", requestId: "invalid" }, {}, 400],
    ["x".repeat(1025), {}, 413],
    [{}, { headers: { origin: "https://foreign.example" } }, 403],
    [undefined, { method: "GET", body: undefined }, 405],
    [{}, { headers: { authorization: "" } }, 401],
    [{}, { headers: { "content-type": "text/plain" } }, 415],
  ]) {
    const f = fixture();
    assert.equal((await f.call(body, override)).status, status);
    assert.equal(f.requests.filter((r) => r.url.origin === "https://api.retellai.com").length, 0);
  }
});
test("authentication and owner authorization are enforced server side", async () => {
  for (const options of [{ authStatus: 401 }, { role: "staff" }, { role: "manager" }]) {
    const f = fixture(options);
    assert.ok([401, 403].includes((await f.call()).status));
    assert.equal(f.requests.filter((r) => r.url.origin === "https://api.retellai.com").length, 0);
  }
});
test("access check and preflight never create or inspect a Retell call", async () => {
  const f = fixture();
  assert.deepEqual((await f.call({ operation: "access" })).body, { allowed: true });
  assert.equal((await f.call(undefined, { method: "OPTIONS", body: undefined })).status, 204);
  assert.equal(f.requests.filter((r) => r.url.origin === "https://api.retellai.com").length, 0);
});
test("Retell errors are generic; definite rejection releases lock, ambiguous failure retains it", async () => {
  for (const [options, finish] of [
    [{ createStatus: 400 }, true],
    [{ createStatus: 500 }, false],
    [{ throwCreate: true }, false],
  ]) {
    const f = fixture(options),
      r = await f.call();
    assert.ok(r.status >= 500);
    assert.deepEqual(r.body, { code: "unavailable" });
    assert.equal(
      f.requests.some((r) => r.init.body?.includes('"p_command":"finish"')),
      finish,
    );
    assert.equal(f.requests.filter((r) => r.url.pathname === "/v3/create-web-call").length, 1);
  }
});
test("malformed provider connection and reflected credentials never reach frontend", async () => {
  for (const connection of [
    { access_token: "" },
    { access_token: "PRIVATE_RETELL" },
    { transport: "livekit" },
    { ice_servers: [{ urls: 5 }] },
    { ice_servers: [{ urls: "turn:example", credential: "PRIVATE_RETELL" }] },
  ]) {
    const f = fixture({ connection });
    assert.ok((await f.call()).status >= 500);
  }
});
test("rate limits and concurrency locks prevent provider creation", async () => {
  for (const [code, status] of [
    ["rate_limited", 429],
    ["session_exists", 409],
  ]) {
    const f = fixture({ reservation: { code } });
    assert.equal((await f.call()).status, status);
    assert.equal(f.requests.filter((r) => r.url.pathname === "/v3/create-web-call").length, 0);
  }
});
test("cancellation during create stops only the owned session and never returns its token", async () => {
  const f = fixture({ cancelled: true });
  assert.equal((await f.call()).status, 409);
  assert.equal(f.requests.filter((r) => r.url.pathname === "/v2/stop-call/call_fixture").length, 1);
});
test("stop validates session identity before touching provider call; ambiguous session remains locked", async () => {
  const f = fixture({ stopCall: "call_fixture" });
  assert.deepEqual((await f.call({ operation: "stop", requestId })).body, { stopped: true });
  const foreign = fixture({ stopCall: "call_fixture", wrongIdentity: true });
  assert.equal((await foreign.call({ operation: "stop", requestId })).status, 503);
  assert.equal(
    foreign.requests.filter((r) => r.url.pathname.startsWith("/v2/stop-call")).length,
    0,
  );
});
test("actual demo-session SQL serializes reservations, authorizes owners, and enforces hourly budget offline", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create table clinics(id uuid primary key);create table profiles(auth_user_id uuid,clinic_id uuid,role text,revoked_at timestamptz);insert into auth.users values('${user}');insert into clinics values('${clinic}');insert into profiles values('${user}','${clinic}','owner',null);`,
    );
    await db.exec(
      await readFile(
        new URL("../supabase/migrations/20261031120000_demo_call_sessions.sql", import.meta.url),
        "utf8",
      ),
    );
    const rpc = async (command, id = requestId, actor = user) =>
      (
        await db.query("select demo_call_session($1,$2,$3,$4,null) result", [
          command,
          actor,
          clinic,
          id,
        ])
      ).rows[0].result;
    assert.deepEqual(await rpc("reserve"), { ok: true });
    assert.deepEqual(await rpc("reserve"), { code: "session_exists" });
    await rpc("finish");
    for (let i = 0; i < 5; i++) {
      const id = `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`;
      assert.deepEqual(await rpc("reserve", id), { ok: true });
      await rpc("finish", id);
    }
    assert.deepEqual(await rpc("reserve", "55555555-5555-4555-8555-555555555555"), {
      code: "rate_limited",
    });
    assert.deepEqual(await rpc("authorize", null, "66666666-6666-4666-8666-666666666666"), {
      code: "not_authorized",
    });
    const privileges = await db.query(
      "select has_function_privilege('anon','demo_call_session(text,uuid,uuid,uuid,text)','execute') allowed",
    );
    assert.equal(privileges.rows[0].allowed, false);
  } finally {
    await db.close();
  }
});

test("browser lifecycle is mocked: denied mic creates no call, cancel during permission releases tracks", async () => {
  let creates = 0,
    stopped = 0,
    resolveMic;
  const snapshots = [];
  const denied = new DemoCallController(
    async () => {
      creates++;
      throw Error();
    },
    async () => {
      throw Error();
    },
    async () => {
      throw new DOMException("denied", "NotAllowedError");
    },
    (s) => snapshots.push(s),
  );
  await denied.start();
  assert.equal(creates, 0);
  assert.match(snapshots.at(-1).message, /Allow microphone/);
  const cancelled = new DemoCallController(
    async () => {
      creates++;
      throw Error();
    },
    async () => {
      throw Error();
    },
    () =>
      new Promise((r) => {
        resolveMic = r;
      }),
    (s) => snapshots.push(s),
  );
  const pending = cancelled.start();
  await cancelled.stop();
  resolveMic({
    getTracks: () => [
      {
        stop() {
          stopped++;
        },
      },
    ],
  });
  await pending;
  assert.equal(creates, 0);
  assert.equal(stopped, 1);
});
test("browser lifecycle handles SDK states, received audio, cleanup failure and retry without live media", async () => {
  let hooks,
    cleanupFails = true,
    remembered;
  const snapshots = [];
  const request = async (operation) =>
    operation === "create"
      ? Response.json({ access_token: "fixture" })
      : Response.json(cleanupFails ? { code: "cleanup_pending" } : { stopped: true }, {
          status: cleanupFails ? 409 : 200,
        });
  const controller = new DemoCallController(
    request,
    async (config) => ({
      createWebCall(options) {
        hooks = options.hooks;
        return {
          ready: config
            .fetch("https://api.retellai.com/v3/create-web-call", { method: "POST" })
            .then(() => hooks.onStatus("live")),
          end: async () => {},
          startAudioPlayback: async () => {},
        };
      },
    }),
    async () => ({ getTracks: () => [{ stop() {} }] }),
    (s) => snapshots.push(s),
    (id) => {
      remembered = id;
    },
  );
  await controller.start();
  assert.equal(snapshots.at(-1).state, "listening");
  hooks.onAudio(new Float32Array([0.1, 0.2]));
  assert.equal(snapshots.at(-1).state, "speaking");
  await controller.stop();
  assert.equal(snapshots.at(-1).cleanupPending, true);
  assert.ok(remembered);
  const n = snapshots.length;
  await controller.start();
  assert.equal(snapshots.length, n);
  cleanupFails = false;
  await controller.stop();
  assert.equal(snapshots.at(-1).state, "ended");
  assert.equal(snapshots.at(-1).message, "");
  assert.equal(remembered, undefined);
});
