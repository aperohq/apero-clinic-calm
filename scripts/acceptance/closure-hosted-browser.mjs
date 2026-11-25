// Targeted closure only: real hosted Managers and existing published components.
// Provider recording retrieval is transferred; generated WAV transport is browser-only.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const OUT = resolve("docs/release/2026-11-25-closure");
const BASE = "https://aperodashboard.lovable.app";
const SUP = "https://svoybvzvmygszklcmudh.supabase.co";
const AUDIO = "https://apero-synthetic-audio.invalid";
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const mode = arg("--mode", "manager");
const phase = arg("--phase", "booked");
assert(["manager", "recording", "appointment"].includes(mode), "Invalid targeted mode");
assert(["booked", "rescheduled", "cancelled"].includes(phase), "Invalid appointment phase");
const path = resolve(
  process.env.APERO_CLOSURE_MANIFEST ?? "/tmp/apero-technical-closure/private/fixtures.json",
);
assert(!path.startsWith(ROOT + "/"), "Private fixture manifest must remain outside repository");
assert(((await stat(path)).mode & 0o077) === 0, "Private fixture permissions required");
const fixture = JSON.parse(await readFile(path, "utf8"));
assert(
  fixture.production_approved === true && fixture.synthetic === true && fixture.admitted === true,
  "Explicit approval and exact synthetic admission required",
);
assert(fixture.target_project === "svoybvzvmygszklcmudh", "Unexpected project");
const clinics = fixture.clinics ?? { a: fixture.clinic_a, b: fixture.clinic_b };
const clients = fixture.clients ?? { a: fixture.client_a, b: fixture.client_b };
const practitioners = fixture.practitioners ?? { a: fixture.staff_a, b: fixture.staff_b };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
for (const id of [
  ...Object.values(clinics),
  ...Object.values(clients),
  ...Object.values(practitioners),
])
  assert(uuid.test(id), "Exact synthetic UUID required");
assert(clinics.a !== clinics.b, "Two distinct synthetic tenants required");
const accounts = fixture.accounts.filter((account) => account.role === "manager");
assert(
  accounts.length === 2 &&
    accounts.every(
      (account) =>
        uuid.test(account.auth_user_id) &&
        uuid.test(account.profile_id) &&
        Object.values(clinics).includes(account.clinic_id) &&
        typeof account.password === "string",
    ),
  "Exactly two admitted dedicated Managers required",
);
const managers =
  mode === "manager" ? accounts : accounts.filter((account) => account.clinic_id === clinics.a);
const publicConfig = Object.fromEntries(
  (await readFile("/home/nour/apero-onboarding-release-20261124/review/.env.production", "utf8"))
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [
        line.slice(0, at).trim(),
        line
          .slice(at + 1)
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      ];
    }),
);
const key = publicConfig.VITE_SUPABASE_PUBLISHABLE_KEY || publicConfig.VITE_SUPABASE_ANON_KEY;
assert(publicConfig.VITE_SUPABASE_URL === SUP && key && !key.startsWith("sb_secret_"));
const { chromium } = await import(
  pathToFileURL(
    process.env.APERO_PLAYWRIGHT_MODULE ??
      "/tmp/apero-onboarding-tooling/browser/node_modules/playwright/index.mjs",
  )
);
await mkdir(OUT, { recursive: true });
const result = {
  run_id: fixture.run_id,
  mode,
  ...(mode === "appointment" ? { phase } : {}),
  started_at: new Date().toISOString(),
  tests: [],
  page_errors: [],
  blocked_requests: [],
  auth_signins: 0,
  auth_refreshes: 0,
  session_cleanup: [],
  recording_transport_interceptions: 0,
  audio_transport_interceptions: 0,
  provider_requests_forwarded: 0,
  recording_scope:
    "Actual published UI/HTMLAudioElement with generated WAV supplied by browser-only transport; upstream provider/recording retrieval TRANSFERRED",
};
const output = resolve(
  OUT,
  mode === "manager"
    ? "browser-result.json"
    : mode === "recording"
      ? "recording-result.json"
      : `appointment-${phase}-browser-result.json`,
);
const persist = () => writeFile(output, JSON.stringify(result, null, 2) + "\n");
async function check(id, ok, fields = {}) {
  result.tests.push({ id, status: ok ? "PASS" : "FAIL", ...fields });
  await persist();
  assert(ok, id);
}
const sessions = new Map();
let browser;
let recordingFailure = false;
let recordingAttempt = 0;
function wav() {
  const rate = 16000,
    samples = rate * 2,
    bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(Math.round(1800 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return bytes;
}
const audioBytes = wav();
const tables = new Set([
  "clients",
  "staff",
  "appointments",
  "conversations",
  "voice_requests",
  "staff_availability",
  "staff_time_off",
  "client_notes",
  "notifications",
]);
const readonlyRpcs = new Set([
  "clinic_team_members",
  "clinic_activation_readiness",
  "clinic_analytics",
  "integration_dashboard",
  "appointment_available_slots",
]);
const deniedRpcs = new Set([
  "set_clinic_member_role",
  "revoke_clinic_member",
  "reactivate_clinic_member",
]);
function isEq(value, values) {
  return values.some((item) => value === "eq." + item);
}

async function api(page, account, tablePath, { method = "GET", body } = {}) {
  return page.evaluate(
    async ({ origin, publicKey, token, relative, method: verb, payload }) => {
      const response = await fetch(origin + relative, {
        method: verb,
        headers: {
          apikey: publicKey,
          Authorization: "Bearer " + token,
          ...(payload
            ? { "Content-Type": "application/json", Prefer: "return=representation" }
            : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      let data;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { status: response.status, data };
    },
    {
      origin: SUP,
      publicKey: key,
      token: sessions.get(account.label).access_token,
      relative: tablePath,
      method,
      payload: body,
    },
  );
}

async function routes(page, account) {
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, heading] of [
      ["/home", "Welcome"],
      ["/calendar", "Calendar"],
      ["/clients", "Clients"],
      ["/staff", "Staff"],
      ["/conversations", "Conversations"],
      ["/requests", "Requests"],
      ["/analytics", "Analytics"],
      ["/account", "Account"],
      ["/account/team", "Team"],
      ["/account/settings", "Settings"],
    ]) {
      await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
      const denied = route === "/account/settings";
      if (denied)
        await page
          .getByText("This section isn’t available for your role.", { exact: true })
          .waitFor();
      else await page.getByRole("heading", { level: 1, name: new RegExp(heading) }).waitFor();
      await page
        .getByText("Loading clinic information…", { exact: true })
        .waitFor({ state: "hidden" });
      const view = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        failed: /We couldn’t load this page\.|This page didn't load/.test(document.body.innerText),
      }));
      await check(
        `MANAGER-ROUTE:${account.label}:${width}:${route}`,
        !view.failed && view.scroll <= width + 1,
        { route, width, expected_denied: denied, scroll: view.scroll },
      );
      if (route === "/account/team")
        await check(
          `MANAGER-READONLY-TEAM:${account.label}:${width}`,
          (await page
            .getByRole("button", { name: /Invite user|Revoke access|Restore access/i })
            .count()) === 0,
        );
    }
  }
  const other = account.clinic_id === clinics.a ? "b" : "a";
  for (const [route, message] of [
    [`/clients/${clients[other]}`, "This client could not be found."],
    [`/staff/${practitioners[other]}`, "This team member could not be found."],
  ]) {
    await page.goto(BASE + route);
    await page.getByText(message, { exact: true }).waitFor();
    await check(`MANAGER-HORIZONTAL-UI:${account.label}:${route.split("/")[1]}`, true);
  }
  for (const table of ["clients", "staff", "appointments", "profiles", "conversations"]) {
    const response = await api(
      page,
      account,
      `/rest/v1/${table}?select=id&clinic_id=eq.${clinics[other]}`,
    );
    await check(
      `MANAGER-HORIZONTAL-READ:${account.label}:${table}`,
      response.status === 200 && Array.isArray(response.data) && response.data.length === 0,
      { http: response.status },
    );
  }
  const own = await api(
    page,
    account,
    `/rest/v1/clients?select=id&clinic_id=eq.${account.clinic_id}`,
  );
  await check(`MANAGER-OWN-CLIENT:${account.label}`, own.status === 200 && own.data.length === 1);
  const foreignPatch = await api(page, account, `/rest/v1/clients?id=eq.${clients[other]}`, {
    method: "PATCH",
    body: { full_name: "SYNTHETIC FORBIDDEN UPDATE" },
  });
  await check(
    `MANAGER-HORIZONTAL-UPDATE:${account.label}`,
    foreignPatch.status === 403 || (foreignPatch.status === 200 && foreignPatch.data?.length === 0),
    { http: foreignPatch.status },
  );
  const clinicBefore = await api(
    page,
    account,
    `/rest/v1/clinics?select=id,phone&id=eq.${account.clinic_id}`,
  );
  const forbidden = await api(page, account, `/rest/v1/clinics?id=eq.${account.clinic_id}`, {
    method: "PATCH",
    body: { phone: "+96555559009" },
  });
  const clinicAfter = await api(
    page,
    account,
    `/rest/v1/clinics?select=id,phone&id=eq.${account.clinic_id}`,
  );
  await check(
    `MANAGER-OWNER-CONFIG-DENIED:${account.label}`,
    (forbidden.status === 403 || (forbidden.status === 200 && forbidden.data?.length === 0)) &&
      clinicBefore.data?.length === 1 &&
      clinicBefore.data[0].phone === clinicAfter.data?.[0]?.phone,
    { http: forbidden.status },
  );
  const targets = fixture.accounts.filter(
    (a) => a.role !== "owner" && a.profile_id !== account.profile_id,
  );
  for (const target of targets) {
    for (const rpc of deniedRpcs) {
      const response = await api(page, account, "/rest/v1/rpc/" + rpc, {
        method: "POST",
        body: {
          p_profile_id: target.profile_id,
          ...(rpc === "set_clinic_member_role" ? { p_role: "staff" } : {}),
        },
      });
      await check(
        `MANAGER-PRIVILEGED-RPC:${account.label}:${target.label}:${rpc}`,
        response.status === 403 && response.data?.code === "42501",
        { http: response.status },
      );
    }
  }
  const foreignAvailability = await api(page, account, "/rest/v1/rpc/appointment_available_slots", {
    method: "POST",
    body: {
      p_clinic_id: clinics[other],
      p_staff_id: practitioners[other],
      p_service: "Consultation",
      p_date: "2040-01-02",
      p_exclude_id: null,
    },
  });
  await check(
    `MANAGER-HORIZONTAL-RPC:${account.label}`,
    foreignAvailability.status === 403 && foreignAvailability.data?.code === "42501",
    { http: foreignAvailability.status },
  );
}

async function recording(page, account) {
  assert(uuid.test(fixture.conversation_id), "Exact synthetic conversation required");
  const route = BASE + "/conversations/" + fixture.conversation_id;
  await page.goto(route);
  await page.getByRole("button", { name: "Load recording", exact: true }).waitFor();
  const load = async () => {
    await page.getByRole("button", { name: /^(Load recording|Try again)$/ }).click();
    const element = page.locator('audio[aria-label="Call recording"]');
    await element.waitFor();
    await page.waitForFunction(() => {
      const a = document.querySelector("audio");
      return a && a.readyState >= 1 && a.duration > 1;
    });
    return element;
  };
  let element = await load();
  await check(
    "RECORDING-GENERATED-METADATA",
    await element.evaluate((a) => a.controls && Number.isFinite(a.duration) && a.duration > 1),
  );
  await element.evaluate((a) => {
    a.muted = true;
  });
  const box = await element.boundingBox();
  await page.mouse.click(box.x + 18, box.y + box.height / 2);
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > 0.15;
  });
  await check("RECORDING-NATIVE-PLAY-PROGRESS", true);
  await element.evaluate((a) => a.pause());
  await check("RECORDING-NATIVE-PAUSE", await element.evaluate((a) => a.paused));
  await element.evaluate((a) => {
    a.currentTime = 0.8;
  });
  await page.waitForFunction(
    () => Math.abs(document.querySelector("audio").currentTime - 0.8) < 0.15,
  );
  await check("RECORDING-NATIVE-SEEK", true);
  await element.evaluate((a) => {
    a.currentTime = a.duration - 0.2;
    return a.play();
  });
  await page.waitForFunction(() => document.querySelector("audio")?.ended === true);
  await check("RECORDING-NATIVE-ENDED", true);
  recordingFailure = true;
  await page.goto(route);
  await page.getByRole("button", { name: "Load recording", exact: true }).click();
  await page.getByText("Recording unavailable.", { exact: true }).waitFor();
  await check(
    "RECORDING-SAFE-MEDIA-ERROR",
    await page.getByRole("button", { name: "Try again", exact: true }).isVisible(),
  );
  recordingFailure = false;
  element = await load();
  await check("RECORDING-RETRY-RECOVERS", await element.evaluate((a) => a.readyState >= 1));
  await check(
    "RECORDING-TRANSPORT-BOUNDARY",
    result.recording_transport_interceptions >= 3 &&
      result.audio_transport_interceptions >= 3 &&
      result.provider_requests_forwarded === 0,
  );
  await check("RECORDING-OWN-CLINIC", account.clinic_id === clinics.a);
}

async function appointment(page, account) {
  assert(uuid.test(fixture.appointment_id), "Exact synthetic appointment required");
  const response = await api(
    page,
    account,
    `/rest/v1/appointments?select=id,status,start_time,end_time,client_id,staff_id,clinic_id&id=eq.${fixture.appointment_id}`,
  );
  assert(
    response.status === 200 && response.data?.length === 1,
    "Expected persisted synthetic appointment",
  );
  const row = response.data[0];
  const expected = fixture.appointment;
  const start = phase === "booked" ? expected.start_time : expected.rescheduled_start_time;
  const end = phase === "booked" ? expected.end_time : expected.rescheduled_end_time;
  const status = phase === "cancelled" ? "Cancelled" : "Booked";
  await check(
    `APPOINTMENT-${phase}-PERSISTED`,
    row.status === status &&
      Date.parse(row.start_time) === Date.parse(start) &&
      Date.parse(row.end_time) === Date.parse(end) &&
      row.clinic_id === clinics.a &&
      row.client_id === clients.a &&
      row.staff_id === practitioners.a,
  );
  await page.goto(BASE + "/calendar");
  await page.getByRole("heading", { name: "Calendar", exact: true }).waitFor();
  const client = await api(page, account, `/rest/v1/clients?select=full_name&id=eq.${clients.a}`);
  const clientName = client.data?.[0]?.full_name;
  assert(typeof clientName === "string");
  const event = page
    .locator("button[aria-label]")
    .filter({ hasText: clientName })
    .filter({ hasText: "Consultation" });
  await event.waitFor();
  await event.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByText(status, { exact: true }).waitFor();
  const text = await dialog.innerText();
  const format = (iso) =>
    new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: "Asia/Kuwait" }).format(
      new Date(iso),
    );
  await check(
    `APPOINTMENT-${phase}-DASHBOARD-STATE`,
    text.includes(status) && text.replace(/\s+/g, " ").includes(format(start).replace(/\s+/g, " ")),
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await check(`APPOINTMENT-${phase}-DIALOG-CLOSE`, (await dialog.count()) === 0);
}

try {
  browser = await chromium.launch({ headless: true });
  result.browser_version = browser.version();
  for (const account of managers) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      locale: "en-US",
    });
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        method = request.method();
      let allow = false;
      if (url.origin === AUDIO) {
        assert(url.pathname === "/" + fixture.run_id + "/fixture.wav");
        result.audio_transport_interceptions++;
        if (recordingFailure) return route.fulfill({ status: 403, body: "Synthetic media denial" });
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "");
        const from = range ? Number(range[1]) : 0,
          to = range?.[2]
            ? Math.min(Number(range[2]), audioBytes.length - 1)
            : audioBytes.length - 1;
        return route.fulfill({
          status: range ? 206 : 200,
          contentType: "audio/wav",
          body: audioBytes.subarray(from, to + 1),
          headers: {
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
            ...(range ? { "Content-Range": `bytes ${from}-${to}/${audioBytes.length}` } : {}),
          },
        });
      }
      if (
        url.origin === SUP &&
        url.pathname === "/functions/v1/recording-access" &&
        mode === "recording"
      ) {
        const cors = {
          "Access-Control-Allow-Origin": BASE,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        };
        if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        let data;
        try {
          data = request.postDataJSON();
        } catch {
          data = null;
        }
        assert(method === "POST" && data?.conversationId === fixture.conversation_id);
        result.recording_transport_interceptions++;
        recordingAttempt++;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: cors,
          body: JSON.stringify({
            url: AUDIO + "/" + fixture.run_id + "/fixture.wav?attempt=" + recordingAttempt,
          }),
        });
      }
      if (
        url.origin === BASE ||
        ["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)
      )
        allow = ["GET", "HEAD"].includes(method);
      if (url.origin === SUP) {
        if (["GET", "HEAD", "OPTIONS"].includes(method) && url.pathname.startsWith("/auth/v1/"))
          allow = true;
        else if (
          ["GET", "HEAD", "PATCH", "OPTIONS"].includes(method) &&
          url.pathname.startsWith("/rest/v1/") &&
          !url.pathname.includes("/rpc/")
        ) {
          const table = url.pathname.slice("/rest/v1/".length);
          const clinicFilter = isEq(url.searchParams.get("clinic_id"), Object.values(clinics));
          const exact = isEq(url.searchParams.get("id"), [
            ...Object.values(clients),
            ...Object.values(practitioners),
            fixture.appointment_id,
            fixture.conversation_id,
          ]);
          allow = tables.has(table) && (clinicFilter || exact);
          if (table === "profiles")
            allow =
              clinicFilter ||
              isEq(
                url.searchParams.get("auth_user_id"),
                fixture.accounts.map((a) => a.auth_user_id),
              );
          if (table === "clinics") allow = isEq(url.searchParams.get("id"), Object.values(clinics));
          if (method === "PATCH")
            allow =
              mode === "manager" &&
              ((table === "clients" && isEq(url.searchParams.get("id"), Object.values(clients))) ||
                (table === "clinics" && isEq(url.searchParams.get("id"), Object.values(clinics))));
        } else if (method === "POST" && url.pathname === "/auth/v1/token") {
          try {
            const body = request.postDataJSON();
            allow =
              url.searchParams.get("grant_type") === "password"
                ? body.email === account.email && body.password === account.password
                : body.refresh_token === sessions.get(account.label)?.refresh_token;
          } catch {
            allow = false;
          }
        } else if (method === "POST" && url.pathname === "/auth/v1/logout")
          allow = url.searchParams.get("scope") === "local";
        else if (method === "POST" && url.pathname.startsWith("/rest/v1/rpc/")) {
          const rpc = url.pathname.split("/").at(-1);
          let body;
          try {
            body = request.postDataJSON();
          } catch {
            body = {};
          }
          allow =
            readonlyRpcs.has(rpc) &&
            (!body.p_clinic_id || Object.values(clinics).includes(body.p_clinic_id));
          if (deniedRpcs.has(rpc))
            allow =
              mode === "manager" &&
              fixture.accounts.some((a) => a.profile_id === body.p_profile_id);
        }
      }
      if (!allow) {
        result.blocked_requests.push({ host: url.hostname, path: url.pathname, method });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    page.on("pageerror", (error) =>
      result.page_errors.push({ label: account.label, name: error.name }),
    );
    page.on("response", async (response) => {
      try {
        const url = new URL(response.url());
        if (url.origin === SUP && url.pathname === "/auth/v1/token" && response.ok()) {
          const data = await response.json();
          const claims = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url"));
          assert(claims.sub === account.auth_user_id);
          sessions.set(account.label, {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
          });
          if (url.searchParams.get("grant_type") === "password") result.auth_signins++;
          else result.auth_refreshes++;
        }
      } catch {
        result.page_errors.push({ label: account.label, name: "AuthResponseAdmissionFailure" });
      }
    });
    try {
      await page.goto(BASE + "/login");
      await page.locator("input[type=email]").fill(account.email);
      await page.locator("input[type=password]").fill(account.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL("**/home");
      await page.getByRole("heading", { name: /Welcome,/ }).waitFor();
      await check(`MANAGER-LOGIN:${account.label}`, sessions.has(account.label));
      const own = await api(
        page,
        account,
        `/rest/v1/profiles?select=clinic_id,role&auth_user_id=eq.${account.auth_user_id}`,
      );
      await check(
        `MANAGER-IDENTITY:${account.label}`,
        own.status === 200 &&
          own.data?.length === 1 &&
          own.data[0].role === "manager" &&
          own.data[0].clinic_id === account.clinic_id,
      );
      if (mode === "manager") await routes(page, account);
      else if (mode === "recording") await recording(page, account);
      else await appointment(page, account);
    } catch (error) {
      result.tests.push({
        id: `BROWSER-EXECUTION:${account.label}`,
        status: "FAIL",
        error_class: error.name,
      });
      process.exitCode = 1;
    } finally {
      const session = sessions.get(account.label);
      if (session) {
        try {
          const response = await fetch(SUP + "/auth/v1/logout?scope=local", {
            method: "POST",
            headers: { apikey: key, Authorization: "Bearer " + session.access_token },
          });
          result.session_cleanup.push({
            label: account.label,
            scope: "local",
            http: response.status,
          });
          if (response.status !== 204) {
            result.tests.push({ id: `SESSION-CLEANUP:${account.label}`, status: "FAIL" });
            process.exitCode = 1;
          }
        } catch (error) {
          result.session_cleanup.push({
            label: account.label,
            scope: "local",
            status: "UNVERIFIED",
            error_class: error.name,
          });
          result.tests.push({ id: `SESSION-CLEANUP:${account.label}`, status: "FAIL" });
          process.exitCode = 1;
        }
      }
      await context.close();
      await persist();
    }
  }
} finally {
  if (browser) await browser.close();
  result.finished_at = new Date().toISOString();
  result.pass = result.tests.filter((test) => test.status === "PASS").length;
  result.fail = result.tests.filter((test) => test.status === "FAIL").length;
  if (result.fail || result.page_errors.length) process.exitCode = 1;
  await persist();
  console.log(
    JSON.stringify({
      mode,
      phase,
      pass: result.pass,
      fail: result.fail,
      page_errors: result.page_errors.length,
    }),
  );
}
