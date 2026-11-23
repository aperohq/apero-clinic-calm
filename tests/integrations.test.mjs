import assert from "node:assert/strict";
import { test } from "node:test";
import {
  seal,
  unseal,
  sha256,
  challenge,
  equalSecret,
} from "../supabase/functions/_shared/integrations/crypto.ts";
import {
  GoogleCalendarAdapter,
  GOOGLE_SCOPES,
  exchangeToken,
  oauthUrl,
  dayBoundary,
} from "../supabase/functions/_shared/integrations/google.ts";
import {
  retryDelay,
  externalEventId,
  ProviderError,
} from "../supabase/functions/_shared/integrations/adapter.ts";
import { createIntegrationApi } from "../supabase/functions/integration-api/function.ts";
import {
  createIntegrationWorker,
  createIntegrationDrain,
} from "../supabase/functions/integration-worker/function.ts";
import { createCalendarWebhook } from "../supabase/functions/google-calendar-webhook/function.ts";
import { clients, accessToken } from "../supabase/functions/_shared/integrations/runtime.ts";
const clinic = "00000000-0000-4000-8000-000000000100",
  connection = "00000000-0000-4000-8000-000000000800",
  actor = "00000000-0000-4000-8000-000000000101";
const appointment = {
  id: "00000000-0000-4000-8000-000000000105",
  staff_id: "00000000-0000-4000-8000-000000000104",
  start_time: "2027-01-01T09:00:00Z",
  end_time: "2027-01-01T09:30:00Z",
  status: "Booked",
};
const configuration = {
  clientId: "local-id",
  clientSecret: "local-secret",
  redirectUri: "https://example.supabase.co/functions/v1/integration-api/oauth/callback",
};
const settings = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "fixture-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
  APERO_PORTAL_ORIGIN: "https://portal.example.test",
  INTEGRATIONS_ENABLED: "true",
  INTEGRATION_ENCRYPTION_KEY: "a".repeat(64),
  INTEGRATION_WORKER_SECRET: "w".repeat(64),
  GOOGLE_CLIENT_ID: configuration.clientId,
  GOOGLE_CLIENT_SECRET: configuration.clientSecret,
  GOOGLE_REDIRECT_URI: configuration.redirectUri,
};
const env = (name) => settings[name];
const json = (data, status = 200) => Response.json(data, { status });
const noNetwork = async () => {
  throw new Error("Unexpected network access");
};
const req = (path, body, headers = {}) =>
  new Request("https://example.supabase.co/functions/v1/integration-api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("AES-GCM encrypts tokens, authenticates clinic/connection and rejects corruption", async () => {
  const secret = "b".repeat(64),
    value = { refresh_token: "synthetic-private" };
  const encrypted = await seal(value, secret, clinic + connection);
  assert.equal(encrypted.includes(value.refresh_token), false);
  assert.deepEqual(await unseal(encrypted, secret, clinic + connection), value);
  await assert.rejects(() => unseal(encrypted, secret, "foreign-clinic"));
  await assert.rejects(() => unseal(encrypted.slice(0, -4) + "aaaa", secret, clinic + connection));
  await assert.rejects(() => seal(value, "short", "x"));
  assert.equal(await equalSecret("a", "a"), true);
  assert.equal(await equalSecret("a", "b"), false);
  assert.equal((await sha256("secret")).length, 64);
});
test("OAuth uses exact redirect, offline consent, state and PKCE", async () => {
  const value = await challenge("verifier"),
    url = new URL(oauthUrl(configuration, "random-state", value));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("state"), "random-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), configuration.redirectUri);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("scope"), /calendar.events/);
});
test("token exchange validates scopes and preserves refresh token on refresh", async () => {
  await assert.rejects(
    () =>
      exchangeToken(configuration, { grant_type: "authorization_code" }, async () =>
        json({ access_token: "a", expires_in: 3600, refresh_token: "r", scope: GOOGLE_SCOPES[0] }),
      ),
    /google_missing_permissions/,
  );
  const result = await exchangeToken(
    configuration,
    { grant_type: "refresh_token", refresh_token: "old" },
    async (url, init) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.equal(init.redirect, "error");
      return json({ access_token: "new", expires_in: 3600 });
    },
  );
  assert.equal(result.refresh_token, "old");
  assert.equal(result.access_token, "new");
});
test("all-day date boundaries respect Kuwait and DST transitions", () => {
  assert.equal(dayBoundary("2027-01-01", "Asia/Kuwait"), "2026-12-31T21:00:00.000Z");
  assert.equal(dayBoundary("2027-03-14", "America/New_York"), "2027-03-14T05:00:00.000Z");
  assert.equal(dayBoundary("2027-03-15", "America/New_York"), "2027-03-15T04:00:00.000Z");
});
test("calendar listing paginates and filters for writable calendars", async () => {
  let n = 0;
  const adapter = new GoogleCalendarAdapter("token", async (url, init) => {
    assert.equal(new URL(url).searchParams.get("minAccessRole"), "writer");
    assert.equal(init.redirect, "error");
    n++;
    return json(
      n === 1
        ? { items: [{ id: "first", summary: "First" }], nextPageToken: "next" }
        : { items: [{ id: "second" }] },
    );
  });
  assert.equal((await adapter.calendars()).length, 2);
  assert.equal(n, 2);
});
test("busy snapshots expand recurrence, paginate, exclude transparent/cancelled events and preserve all-day zones", async () => {
  let n = 0;
  const adapter = new GoogleCalendarAdapter("token", async (url) => {
    assert.equal(new URL(url).searchParams.get("singleEvents"), "true");
    n++;
    return json(
      n === 1
        ? {
            timeZone: "Asia/Kuwait",
            items: [
              { id: "all-day", start: { date: "2027-01-01" }, end: { date: "2027-01-02" } },
              { id: "free", transparency: "transparent" },
            ],
            nextPageToken: "next",
          }
        : {
            items: [
              { id: "cancelled", status: "cancelled" },
              {
                id: "meeting",
                start: { dateTime: appointment.start_time },
                end: { dateTime: appointment.end_time },
              },
            ],
          },
    );
  });
  const result = await adapter.busy("calendar", appointment.start_time, appointment.end_time);
  assert.equal(result.length, 2);
  assert.equal(result[0].start, "2026-12-31T21:00:00.000Z");
  assert.equal(n, 2);
});
test("outbound booking/reschedule uses stable IDs, handles create race and omits patient data", async () => {
  const calls = [];
  const adapter = new GoogleCalendarAdapter("token", async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? json({}, 404)
      : calls.length === 2
        ? json({}, 409)
        : json({ id: "created" });
  });
  await adapter.upsert("calendar@example.test", appointment);
  assert.deepEqual(
    calls.map((c) => c.init.method),
    ["PUT", "POST", "PUT"],
  );
  const payload = JSON.parse(calls[1].init.body);
  assert.equal(payload.id, externalEventId(appointment.id));
  assert.match(payload.id, /^[0-9a-v]+$/);
  assert.deepEqual(Object.keys(payload).sort(), ["end", "id", "start", "summary", "transparency"]);
  assert.ok(calls[0].url.includes("sendUpdates=none"));
});
test("cancellation is retry safe after missing/deleted event; retry policy bounded", async () => {
  for (const status of [204, 404, 410])
    await new GoogleCalendarAdapter("token", async () => new Response(null, { status })).cancel(
      "c",
      appointment.id,
    );
  await assert.rejects(
    () =>
      new GoogleCalendarAdapter("token", async () => new Response(null, { status: 503 })).cancel(
        "c",
        appointment.id,
      ),
    (e) => e instanceof ProviderError && e.retryable,
  );
  assert.equal(retryDelay(100, 99999), 3600);
  assert.ok(retryDelay(1, 0, () => 0) >= 1);
});
test("feature gates, CORS, missing API authentication and worker authorization fail closed", async () => {
  const handler = createIntegrationApi(env, noNetwork);
  assert.equal(
    (await handler(req("/v1/appointments", undefined, { origin: "https://evil.test" }))).status,
    403,
  );
  assert.equal((await handler(req("/v1/appointments"))).status, 401);
  assert.equal(
    (await createIntegrationApi(() => undefined, noNetwork)(req("/v1/appointments"))).status,
    503,
  );
  assert.equal(
    (
      await createIntegrationWorker(
        env,
        noNetwork,
      )(new Request("https://example.test", { method: "POST" }))
    ).status,
    401,
  );
  assert.equal(
    (
      await createCalendarWebhook(
        env,
        noNetwork,
      )(new Request("https://example.test", { method: "POST" }))
    ).status,
    403,
  );
});
test("API fixes clinic from key authentication, bounds reads and rejects extra clinic injection", async () => {
  const calls = [];
  const transport = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url.href);
    if (url.pathname.endsWith("/rpc/integration_authorize"))
      return json({ id: "key", clinic_id: clinic });
    if (url.pathname.endsWith("/appointments")) {
      assert.equal(url.searchParams.get("clinic_id"), "eq." + clinic);
      return json([appointment]);
    }
    throw new Error("Unexpected request " + url.pathname);
  };
  const handler = createIntegrationApi(env, transport),
    headers = { authorization: "Bearer apero_" + "a".repeat(64) };
  const result = await handler(
    req("/v1/appointments?from=2027-01-01&until=2027-01-02", undefined, headers),
  );
  assert.equal(result.status, 200);
  assert.equal((await result.json()).appointments[0].id, appointment.id);
  assert.equal(
    (
      await handler(
        req(
          "/v1/appointments",
          { action: "cancel", appointment_id: appointment.id, clinic_id: "foreign" },
          headers,
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (await handler(req("/v1/appointments?from=2027-01-01&until=2028-01-01", undefined, headers)))
      .status,
    400,
  );
});
test("API idempotency conflict and rate limits have stable safe errors", async () => {
  const headers = {
    authorization: "Bearer apero_" + "a".repeat(64),
    "idempotency-key": "safe-request-key",
  };
  const transport = async (input) => {
    const url = String(input);
    if (url.endsWith("integration_authorize")) return json({ id: "key", clinic_id: clinic });
    if (url.endsWith("integration_mutate"))
      return json({ code: "23505", message: "sensitive database message" }, 409);
    throw new Error("Unexpected request");
  };
  const result = await createIntegrationApi(
    env,
    transport,
  )(req("/v1/appointments", { action: "cancel", appointment_id: appointment.id }, headers));
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { code: "idempotency_conflict" });
  const limited = await createIntegrationApi(env, async () => json({ limited: true }))(
    req("/v1/appointments", undefined, headers),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
});
test("OAuth callback relays code; completion requires the initiating authenticated owner and single-use state", async () => {
  let consumed = false,
    saved = false;
  const state = "a".repeat(64);
  const transport = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/user") return json({ id: actor, email: "owner@example.test" });
    if (url.pathname.endsWith("/profiles"))
      return json({ clinic_id: clinic, role: "owner", revoked_at: null });
    if (url.pathname.endsWith("/integration_oauth_states")) {
      assert.equal(url.searchParams.get("actor_id"), "eq." + actor);
      assert.equal(url.searchParams.get("clinic_id"), "eq." + clinic);
      assert.equal(init.method, "DELETE");
      if (consumed) return json(null);
      consumed = true;
      return json({ clinic_id: clinic, actor_id: actor, verifier: "secret-verifier" });
    }
    if (url.hostname === "oauth2.googleapis.com")
      return json({
        access_token: "private-access",
        refresh_token: "private-refresh",
        expires_in: 3600,
        scope: GOOGLE_SCOPES.join(" "),
      });
    if (url.pathname === "/calendar/v3/users/me/calendarList")
      return json({ items: [{ id: "owner@example.test", summary: "Primary", primary: true }] });
    if (url.pathname.endsWith("/rpc/integration_prepare_connection")) return json(connection);
    if (url.pathname.endsWith("/rpc/integration_save_connection")) {
      const data = JSON.parse(init.body);
      assert.equal(data.p_clinic, clinic);
      assert.equal(data.p_credentials.includes("private"), false);
      saved = true;
      return json(null);
    }
    throw new Error("Unexpected request " + url);
  };
  const handler = createIntegrationApi(env, transport);
  const result = await handler(req("/oauth/callback?state=" + state + "&code=auth-code"));
  assert.equal(result.status, 303);
  assert.equal(saved, false);
  assert.equal(consumed, false);
  const redirect = new URL(result.headers.get("location"));
  assert.equal(redirect.origin, "https://portal.example.test");
  assert.equal(redirect.searchParams.get("integration_code"), "auth-code");
  assert.equal(
    (await handler(req("/manage/oauth/complete", { state, code: "auth-code" }))).status,
    401,
  );
  const headers = { authorization: "Bearer fixture-owner-token" };
  assert.equal(
    (await handler(req("/manage/oauth/complete", { state, code: "auth-code" }, headers))).status,
    200,
  );
  assert.equal(saved, true);
  assert.equal(
    (await handler(req("/manage/oauth/complete", { state, code: "auth-code" }, headers))).status,
    400,
  );
});
test("webhook validates channel headers then acknowledges only a persisted notification", async () => {
  const handler = createCalendarWebhook(env, async (input, init) => {
    assert.ok(String(input).endsWith("integration_notify"));
    const data = JSON.parse(init.body);
    assert.equal(data.p_channel, connection);
    assert.equal(data.p_hash, await sha256("a".repeat(64)));
    return json(true);
  });
  const response = await handler(
    new Request("https://example.test", {
      method: "POST",
      headers: {
        "x-goog-channel-id": connection,
        "x-goog-channel-token": "a".repeat(64),
        "x-goog-resource-id": "resource",
        "x-goog-message-number": "10",
        "x-goog-resource-state": "exists",
      },
    }),
  );
  assert.equal(response.status, 204);
});
test("worker uses tenant-scoped appointment and queues pull after successful outbound sync", async () => {
  const ciphertext = await seal(
    {
      access_token: "fixture-access",
      refresh_token: "fixture-refresh",
      expires_at: Date.now() + 3600000,
    },
    settings.INTEGRATION_ENCRYPTION_KEY,
    clinic + ":" + connection,
  );
  const calls = [];
  const transport = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/rpc/integration_cleanup")) return json(null);
    if (url.pathname.endsWith("/rpc/integration_claim"))
      return json({
        connection: {
          id: connection,
          clinic_id: clinic,
          calendar_id: "calendar",
          staff_id: appointment.staff_id,
          credentials: ciphertext,
        },
        job: { id: "job", object_id: appointment.id, kind: "push", generation: 1, attempts: 1 },
        lease: connection,
      });
    if (url.pathname.endsWith("/calendar_connections")) return json({ id: connection });
    if (url.pathname.endsWith("/rpc/integration_event_link"))
      return json(externalEventId(appointment.id));
    if (url.pathname.endsWith("/appointments")) {
      assert.equal(url.searchParams.get("clinic_id"), "eq." + clinic);
      return json(appointment);
    }
    if (url.pathname.includes("/calendar/v3/"))
      return json(init.method === "PUT" ? { id: "updated" } : { items: [] });
    if (url.pathname.endsWith("/rpc/integration_enqueue")) return json(null);
    if (url.pathname.endsWith("/rpc/integration_finish")) {
      assert.equal(JSON.parse(init.body).p_error, null);
      return json(null);
    }
    throw new Error("Unexpected request " + url);
  };
  const response = await createIntegrationWorker(
    env,
    transport,
  )(
    new Request("https://example.test", {
      method: "POST",
      headers: { authorization: "Bearer " + settings.INTEGRATION_WORKER_SECRET },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { processed: 1, failed: false });
  assert.ok(calls.some((p) => p.endsWith("integration_enqueue")));
});

test("expired token refresh is leased, context-encrypted and conditionally persisted", async () => {
  const ciphertext = await seal(
    { access_token: "old", refresh_token: "refresh", expires_at: 0 },
    settings.INTEGRATION_ENCRYPTION_KEY,
    clinic + ":" + connection,
  );
  let released = false;
  const transport = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("integration_refresh_claim")) {
      assert.equal(JSON.parse(init.body).p_credentials, ciphertext);
      return json(connection);
    }
    if (url.hostname === "oauth2.googleapis.com")
      return json({ access_token: "new-access", expires_in: 3600 });
    if (url.pathname.endsWith("calendar_connections")) {
      assert.equal(url.searchParams.get("lease_id"), "eq." + connection);
      assert.equal(JSON.parse(init.body).credentials.includes("new-access"), false);
      return json([{ id: connection }]);
    }
    if (url.pathname.endsWith("integration_refresh_release")) {
      released = true;
      return json(null);
    }
    throw new Error("unexpected transport");
  };
  assert.equal(
    await accessToken(
      clients(env, transport).admin,
      env,
      { id: connection, clinic_id: clinic, credentials: ciphertext },
      transport,
    ),
    "new-access",
  );
  assert.equal(released, true);
});
test("provider quota and invalid-grant classification is safe and retry-aware", async () => {
  await assert.rejects(
    () =>
      exchangeToken(
        configuration,
        { grant_type: "refresh_token", refresh_token: "old" },
        async () => json({ error: "invalid_grant", error_description: "PRIVATE" }, 400),
      ),
    (e) => e.code === "google_reauthorization_required" && !e.message.includes("PRIVATE"),
  );
  await assert.rejects(
    () =>
      new GoogleCalendarAdapter("token", async () =>
        json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 403),
      ).calendars(),
    (e) => e.retryable === true,
  );
  await assert.rejects(
    () =>
      new GoogleCalendarAdapter("token", async () => json({}, 410)).upsert("calendar", appointment),
    (e) => e.code === "google_event_deleted",
  );
});
test("scheduled drain authenticates and stops on an idle queue", async () => {
  let cleanup = 0;
  const transport = async (input) => {
    if (String(input).endsWith("integration_cleanup")) {
      cleanup++;
      return json(null);
    }
    if (String(input).endsWith("integration_claim")) return json(null);
    throw new Error("Unexpected request");
  };
  const response = await createIntegrationDrain(
    env,
    transport,
  )(
    new Request("https://example.test", {
      method: "POST",
      headers: { authorization: "Bearer " + settings.INTEGRATION_WORKER_SECRET },
    }),
  );
  assert.deepEqual(await response.json(), { processed: 0, failed: 0 });
  assert.equal(cleanup, 1);
});

test("selection immediately starts only the owner's connection worker and preserves calendar identity", async () => {
  const ciphertext = await seal(
    {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_at: Date.now() + 3600000,
    },
    settings.INTEGRATION_ENCRYPTION_KEY,
    clinic + ":" + connection,
  );
  let kicks = 0,
    selections = 0;
  const transport = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/user") return json({ id: actor });
    if (url.pathname.endsWith("/profiles"))
      return json({ clinic_id: clinic, role: "owner", revoked_at: null });
    if (url.pathname.endsWith("/calendar_connections")) {
      assert.equal(url.searchParams.get("clinic_id"), "eq." + clinic);
      return json(
        init.method === "PATCH"
          ? null
          : {
              id: connection,
              clinic_id: clinic,
              credentials: ciphertext,
              google_account_id: "owner@example.test",
            },
      );
    }
    if (url.pathname === "/calendar/v3/users/me/calendarList")
      return json({
        items: [
          { id: "owner@example.test", summary: "Primary", primary: true },
          {
            id: "synthetic@group.calendar.google.com",
            summary: "Private synthetic",
            primary: false,
          },
        ],
      });
    if (url.pathname.endsWith("integration_select_calendar")) {
      selections++;
      return json(null);
    }
    if (url.pathname.endsWith("/functions/v1/integration-worker")) {
      assert.deepEqual(JSON.parse(init.body), { connection_id: connection });
      assert.equal(init.headers.authorization, "Bearer " + settings.INTEGRATION_WORKER_SECRET);
      kicks++;
      return json({ processed: 1, failed: 0 });
    }
    throw Error("Unexpected selection request " + url.pathname);
  };
  const handler = createIntegrationApi(env, transport);
  for (let i = 0; i < 2; i++) {
    const response = await handler(
      req(
        "/manage/select",
        {
          connection_id: connection,
          calendar_id: "synthetic@group.calendar.google.com",
          staff_id: appointment.staff_id,
        },
        { authorization: "Bearer owner" },
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { selected: true, synchronization: "processed" });
  }
  assert.equal(selections, 2);
  assert.equal(kicks, 2);
});

test("scoped initial pull succeeds when an optional Google watch fails; provider errors remain retryable", async () => {
  const ciphertext = await seal(
    {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      expires_at: Date.now() + 3600000,
    },
    settings.INTEGRATION_ENCRYPTION_KEY,
    clinic + ":" + connection,
  );
  for (const providerStatus of [200, 503]) {
    let snapshot = false,
      warning = false,
      finished = false;
    const transport = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("integration_cleanup")) return json(null);
      if (url.pathname.endsWith("integration_claim_connection")) {
        assert.deepEqual(JSON.parse(init.body), { p_connection: connection });
        return json({
          connection: {
            id: connection,
            clinic_id: clinic,
            calendar_id: "synthetic",
            credentials: ciphertext,
          },
          job: { id: "job", kind: "pull", generation: 1, attempts: 1 },
          lease: connection,
        });
      }
      if (url.pathname.endsWith("integration_claim"))
        throw Error("Unscoped worker claim forbidden");
      if (url.pathname.endsWith("/calendar_connections")) {
        if (init.method === "PATCH" && JSON.parse(init.body).watch_error) {
          warning = true;
          assert.equal(JSON.parse(init.body).watch_error, "google_http_403");
        }
        return json({ id: connection });
      }
      if (url.pathname.endsWith("/events"))
        return json(
          providerStatus === 200
            ? { items: [] }
            : { error: { errors: [{ reason: "backendError" }] } },
          providerStatus,
        );
      if (url.pathname.endsWith("integration_replace_busy")) {
        snapshot = true;
        return json(null);
      }
      if (url.pathname.endsWith("/events/watch"))
        return json({ error: { errors: [{ reason: "forbidden" }] } }, 403);
      if (url.pathname.endsWith("integration_finish")) {
        const data = JSON.parse(init.body);
        assert.equal(data.p_error, providerStatus === 200 ? null : "google_http_503");
        if (providerStatus === 503) assert.ok(data.p_delay > 0);
        finished = true;
        return json(null);
      }
      throw Error("Unexpected worker request " + url.pathname);
    };
    const response = await createIntegrationWorker(
      (name) =>
        name === "GOOGLE_WEBHOOK_URI"
          ? settings.SUPABASE_URL + "/functions/v1/google-calendar-webhook"
          : env(name),
      transport,
    )(
      new Request("https://example.test", {
        method: "POST",
        headers: {
          authorization: "Bearer " + settings.INTEGRATION_WORKER_SECRET,
          "content-type": "application/json",
        },
        body: JSON.stringify({ connection_id: connection }),
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { processed: 1, failed: providerStatus !== 200 });
    assert.equal(snapshot, providerStatus === 200);
    assert.equal(warning, providerStatus === 200);
    assert.equal(finished, true);
  }
});
