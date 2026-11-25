// One existing synthetic session; unchanged hosted JWT expiry; no business/provider writes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const origin = "https://svoybvzvmygszklcmudh.supabase.co";
const output = "docs/release/2026-11-24/evidence/hosted-session-expiry.json";
const fixture = JSON.parse(
  await readFile("/tmp/apero-integration-release/private/synthetic-fixtures.json", "utf8"),
);
const admission = JSON.parse(
  await readFile("docs/release/2026-11-24/evidence/browser-hosted-fixture-admission.json", "utf8"),
);
assert(
  fixture.fixtures_ready && admission.admitted && Object.values(admission.checks).every(Boolean),
);
const account = fixture.accounts.find((a) => a.label === "owner-a");
assert(account && account.role === "owner" && account.clinic_id === fixture.clinic_a);
const config = Object.fromEntries(
  (await readFile("/home/nour/apero-onboarding-release-20261124/review/.env.production", "utf8"))
    .split("\n")
    .filter((x) => x.includes("="))
    .map((x) => {
      const n = x.indexOf("=");
      return [
        x.slice(0, n).trim(),
        x
          .slice(n + 1)
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      ];
    }),
);
const key = config.VITE_SUPABASE_PUBLISHABLE_KEY || config.VITE_SUPABASE_ANON_KEY;
assert(config.VITE_SUPABASE_URL === origin && key && !key.startsWith("sb_secret_"));
const state = {
  started_at: new Date().toISOString(),
  phase: "starting",
  checks: [],
  auth_sessions_issued: 0,
  auth_refreshes_issued: 0,
  production_business_writes: 0,
  provider_operations: 0,
};
let session, heartbeat;
const save = () => writeFile(output, JSON.stringify(state, null, 2) + "\n");
async function check(id, ok, extra = {}) {
  state.checks.push({ id, status: ok ? "PASS" : "FAIL", ...extra });
  await save();
  assert(ok, id);
}
async function call(path, body, token) {
  assert(path.startsWith("/auth/v1/") || path.startsWith("/rest/v1/clinics?"));
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: {
      apikey: key,
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data };
}
try {
  const login = await call("/auth/v1/token?grant_type=password", {
    email: account.email,
    password: account.password,
  });
  assert(
    login.status === 200 && login.data?.access_token && login.data?.refresh_token,
    "synthetic_login_failed",
  );
  session = login.data;
  state.auth_sessions_issued++;
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url"));
  await check(
    "EXP-IDENTITY",
    claims.sub === account.auth_user_id && claims.exp - claims.iat === 3600,
    { jwt_lifetime_seconds: claims.exp - claims.iat },
  );
  const before = await call(
    "/rest/v1/clinics?select=id&id=eq." + account.clinic_id,
    null,
    session.access_token,
  );
  await check(
    "EXP-BEFORE",
    before.status === 200 && before.data?.length === 1 && before.data[0].id === account.clinic_id,
    { http: before.status },
  );
  const remaining = claims.exp * 1000 + 65000 - Date.now();
  assert(remaining > 0 && remaining <= 3900000, "unexpected_expiry_window");
  state.phase = "waiting_for_actual_expiry";
  state.expected_probe_at = new Date(claims.exp * 1000 + 65000).toISOString();
  await save();
  console.log(JSON.stringify({ phase: state.phase, expected_probe_at: state.expected_probe_at }));
  heartbeat = setInterval(() => {
    state.heartbeat_at = new Date().toISOString();
    save().catch(() => {});
  }, 60000);
  await new Promise((resolve) => setTimeout(resolve, remaining));
  clearInterval(heartbeat);
  state.phase = "checking_expired_token";
  await save();
  const expired = await call(
    "/rest/v1/clinics?select=id&id=eq." + account.clinic_id,
    null,
    session.access_token,
  );
  await check("EXP-ELAPSED-DENIAL", expired.status === 401, {
    http: expired.status,
    elapsed_seconds_since_issue: Math.floor(Date.now() / 1000) - claims.iat,
  });
  const refreshed = await call("/auth/v1/token?grant_type=refresh_token", {
    refresh_token: session.refresh_token,
  });
  await check("EXP-REFRESH", refreshed.status === 200 && Boolean(refreshed.data?.access_token), {
    http: refreshed.status,
  });
  session = refreshed.data;
  state.auth_refreshes_issued++;
  const recovered = await call(
    "/rest/v1/clinics?select=id&id=eq." + account.clinic_id,
    null,
    session.access_token,
  );
  await check(
    "EXP-RECOVERY",
    recovered.status === 200 &&
      recovered.data?.length === 1 &&
      recovered.data[0].id === account.clinic_id,
    { http: recovered.status },
  );
  state.phase = "passed";
} catch (error) {
  state.phase = "failed";
  state.error_class = error.name;
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  if (session) {
    try {
      const logout = await call("/auth/v1/logout?scope=local", {}, session.access_token);
      state.cleanup = { scope: "local", http: logout.status };
      if (logout.status !== 204) {
        state.phase = "failed";
        process.exitCode = 1;
      }
      const refresh = await call("/auth/v1/token?grant_type=refresh_token", {
        refresh_token: session.refresh_token,
      });
      state.cleanup.refresh_rejected = [400, 401].includes(refresh.status);
      if (!state.cleanup.refresh_rejected) {
        state.phase = "failed";
        process.exitCode = 1;
      }
    } catch (error) {
      state.cleanup = { status: "UNVERIFIED", error_class: error.name };
      state.phase = "failed";
      process.exitCode = 1;
    }
  }
  state.finished_at = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ phase: state.phase, checks: state.checks, cleanup: state.cleanup }));
}
