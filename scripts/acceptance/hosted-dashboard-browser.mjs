// Read-only hosted acceptance. Admission must independently confirm synthetic-only clinic data.
// Credentials and issued session material remain in memory and are never serialized to evidence.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  pathToFileURL(
    process.env.APERO_PLAYWRIGHT_MODULE ??
      "/tmp/apero-onboarding-tooling/browser/node_modules/playwright/index.mjs",
  )
);
const OUT = resolve("docs/release/2026-11-24/evidence");
const logoutOnly = process.env.APERO_HOSTED_FOCUS === "logout";
const BASE = "https://aperodashboard.lovable.app",
  SUP = "https://svoybvzvmygszklcmudh.supabase.co";
const manifest = JSON.parse(
  await readFile("/tmp/apero-integration-release/private/synthetic-fixtures.json", "utf8"),
);
const admission = JSON.parse(
  await readFile(resolve(OUT, "browser-hosted-fixture-admission.json"), "utf8"),
);
if (
  !manifest.fixtures_ready ||
  admission.admitted !== true ||
  !Object.values(admission.checks).every((value) => value === true)
)
  throw Error("Synthetic-only clinic admission incomplete");
const accounts = manifest.accounts.filter((a) => ["owner-a", "staff-a"].includes(a.label));
if (
  accounts.length !== 2 ||
  accounts.some((a) => a.clinic_id !== manifest.clinic_a) ||
  accounts.some((a) => !["owner", "staff"].includes(a.role))
)
  throw Error("Account fixture admission failed");
const env = Object.fromEntries(
  (await readFile("/home/nour/apero-onboarding-release-20261124/review/.env.production", "utf8"))
    .split("\n")
    .map((line) => {
      const n = line.indexOf("=");
      return n > 0
        ? [
            line.slice(0, n).trim(),
            line
              .slice(n + 1)
              .trim()
              .replace(/^['"]|['"]$/g, ""),
          ]
        : [];
    })
    .filter((x) => x.length),
);
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
if (env.VITE_SUPABASE_URL !== SUP || !key || key.startsWith("sb_secret_"))
  throw Error("Public config admission failed");
const state = {
  checked_at: new Date().toISOString(),
  scope: "Actual published dashboard and hosted Auth; admitted synthetic Owner/Staff only",
  logout_only: logoutOnly,
  tests: [],
  page_errors: [],
  http_errors: [],
  blocked_requests: [],
  auth_sessions_issued: 0,
  auth_refreshes_issued: 0,
  session_cleanup: [],
  business_writes: 0,
  provider_operations: 0,
  retell_operations: 0,
};
const sessions = new Map(),
  safeRpc = new Set([
    "clinic_team_members",
    "clinic_activation_readiness",
    "clinic_analytics",
    "integration_dashboard",
  ]);
const safeTables = new Set([
  "clients",
  "staff",
  "appointments",
  "conversations",
  "voice_requests",
  "staff_availability",
  "staff_time_off",
  "client_notes",
]);
const persist = () =>
  writeFile(
    resolve(OUT, logoutOnly ? "browser-hosted-logout-focus.json" : "browser-hosted-results.json"),
    JSON.stringify(state, null, 2) + "\n",
  );
const check = async (id, ok, detail = {}) => {
  state.tests.push({ id, status: ok ? "PASS" : "FAIL", ...detail });
  await persist();
  console.log(id, ok ? "PASS" : "FAIL");
};
let browser;
try {
  browser = await chromium.launch({ headless: true });
  state.browser_version = browser.version();
  for (const account of accounts) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    await ctx.route("**/*", async (route) => {
      const req = route.request(),
        u = new URL(req.url()),
        method = req.method();
      let allow = false;
      if (u.origin === BASE) allow = ["GET", "HEAD"].includes(method);
      else if (["fonts.googleapis.com", "fonts.gstatic.com"].includes(u.hostname))
        allow = ["GET", "HEAD"].includes(method);
      else if (u.origin === SUP) {
        if (["GET", "HEAD", "OPTIONS"].includes(method) && u.pathname.startsWith("/auth/v1/"))
          allow = true;
        else if (["GET", "HEAD"].includes(method) && u.pathname.startsWith("/rest/v1/")) {
          const table = u.pathname.slice("/rest/v1/".length);
          allow =
            safeTables.has(table) && u.searchParams.get("clinic_id") === "eq." + account.clinic_id;
          if (table === "profiles")
            allow = u.searchParams.get("auth_user_id") === "eq." + account.auth_user_id;
          if (table === "clinics") allow = u.searchParams.get("id") === "eq." + account.clinic_id;
        } else if (method === "POST" && u.pathname === "/auth/v1/token") {
          try {
            const body = req.postDataJSON();
            if (u.searchParams.get("grant_type") === "password")
              allow = body.email === account.email && body.password === account.password;
            if (u.searchParams.get("grant_type") === "refresh_token")
              allow = body.refresh_token === sessions.get(account.label)?.refresh_token;
          } catch {}
        } else if (method === "POST" && u.pathname.startsWith("/rest/v1/rpc/")) {
          const rpc = u.pathname.split("/").pop();
          allow = safeRpc.has(rpc);
          if (["clinic_analytics", "clinic_activation_readiness"].includes(rpc)) {
            try {
              allow = allow && req.postDataJSON().p_clinic_id === account.clinic_id;
            } catch {
              allow = false;
            }
          }
        } else if (method === "POST" && u.pathname === "/auth/v1/logout")
          allow = u.searchParams.get("scope") === "local";
      }
      if (!allow) {
        state.blocked_requests.push({
          label: account.label,
          method,
          host: u.hostname,
          path: u.pathname,
        });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(25000);
    page.on("pageerror", (e) => state.page_errors.push({ label: account.label, name: e.name }));
    page.on("response", async (response) => {
      try {
        const u = new URL(response.url());
        if (u.origin === SUP && u.pathname === "/auth/v1/token" && response.ok()) {
          const body = await response.json();
          const claims = JSON.parse(Buffer.from(body.access_token.split(".")[1], "base64url"));
          if (claims.sub !== account.auth_user_id) throw Error("Unexpected auth identity");
          sessions.set(account.label, {
            access_token: body.access_token,
            refresh_token: body.refresh_token,
          });
          if (u.searchParams.get("grant_type") === "password") state.auth_sessions_issued++;
          else state.auth_refreshes_issued++;
        }
        if (response.status() >= 400)
          state.http_errors.push({
            label: account.label,
            status: response.status(),
            host: u.hostname,
            path: u.pathname,
          });
      } catch {
        state.page_errors.push({ label: account.label, name: "AuthResponseAdmissionError" });
      }
    });
    try {
      await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
      await page.locator("input[type=email]").fill(account.email);
      await page.locator("input[type=password]").fill(account.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL("**/home");
      await page.getByRole("heading", { name: /Welcome,/ }).waitFor();
      await check("HOSTED-LOGIN:" + account.label, sessions.has(account.label), {
        role: account.role,
      });
      const current = await page.evaluate(
        async ({ sup, key, authUser, clinic, role, token }) => {
          const response = await fetch(
            sup + "/rest/v1/profiles?select=clinic_id,role&auth_user_id=eq." + authUser,
            {
              headers: {
                apikey: key,
                Authorization: "Bearer " + token,
              },
            },
          );
          const rows = await response.json();
          return {
            status: response.status,
            matches: rows.length === 1 && rows[0].clinic_id === clinic && rows[0].role === role,
          };
        },
        {
          sup: SUP,
          key,
          authUser: account.auth_user_id,
          token: sessions.get(account.label).access_token,
          clinic: account.clinic_id,
          role: account.role,
        },
      );
      await check("HOSTED-PROFILE:" + account.label, current.status === 200 && current.matches, {
        role: account.role,
      });
      for (const width of logoutOnly ? [] : [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [path, heading] of [
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
          await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
          const expectedDenied =
            account.role === "staff" &&
            ["/staff", "/requests", "/analytics", "/account/team", "/account/settings"].includes(
              path,
            );
          if (expectedDenied)
            await page
              .getByText("This section isn’t available for your role.", { exact: true })
              .waitFor();
          else await page.getByRole("heading", { level: 1, name: new RegExp(heading) }).waitFor();
          await page
            .getByText("Loading clinic information…", { exact: true })
            .waitFor({ state: "hidden" });
          await page.waitForTimeout(250);
          const outcome = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            width: innerWidth,
            dataFailure: document.body.innerText.includes("We couldn’t load this page."),
            rootFailure: document.body.innerText.includes("This page didn't load"),
          }));
          const denied =
            (await page
              .getByText("This section isn’t available for your role.", { exact: true })
              .count()) > 0;
          await check(
            "HOSTED-ROUTE:" + account.label + ":" + width + ":" + path,
            denied === expectedDenied &&
              outcome.scroll <= width + 1 &&
              !outcome.dataFailure &&
              !outcome.rootFailure,
            {
              role: account.role,
              width,
              path,
              expectedDenied,
              denied,
              scrollWidth: outcome.scroll,
              dataFailure: outcome.dataFailure,
              rootFailure: outcome.rootFailure,
            },
          );
        }
      }
      const session = sessions.get(account.label);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(BASE + "/home");
      await page
        .getByRole("navigation", { name: "Dashboard" })
        .getByRole("button", { name: "Log out", exact: true })
        .click();
      await page.waitForURL("**/login");
      await page.locator("input[type=password]").waitFor({ state: "visible" });
      await check(
        "HOSTED-LOGOUT:" + account.label,
        (await page.locator("input[type=password]").count()) === 1,
      );
      await page.goto(BASE + "/home", { waitUntil: "domcontentloaded" });
      await page.waitForURL("**/login");
      await check("HOSTED-AFTER-LOGOUT:" + account.label, true);
      const rejected = await page.evaluate(
        async ({ sup, key, refresh }) => {
          const response = await fetch(sup + "/auth/v1/token?grant_type=refresh_token", {
            method: "POST",
            headers: { apikey: key, "content-type": "application/json" },
            body: JSON.stringify({ refresh_token: refresh }),
          });
          return { status: response.status };
        },
        { sup: SUP, key, refresh: session.refresh_token },
      );
      await check(
        "HOSTED-REVOKED-REFRESH:" + account.label,
        rejected.status === 400 || rejected.status === 401,
        { http: rejected.status },
      );
      state.session_cleanup.push({
        label: account.label,
        scope: "local",
        ui_logout_completed: true,
        refresh_rejected: [400, 401].includes(rejected.status),
      });
      sessions.delete(account.label);
    } catch (error) {
      state.tests.push({
        id: "HOSTED-EXECUTION:" + account.label,
        status: "FAIL",
        error_class: error.name,
      });
      console.log("HOSTED-EXECUTION", account.label, error.name);
    } finally {
      await ctx.close();
      await persist();
    }
  }
} finally {
  for (const [label, session] of sessions) {
    try {
      const response = await fetch(SUP + "/auth/v1/logout?scope=local", {
        method: "POST",
        headers: { apikey: key, Authorization: "Bearer " + session.access_token },
      });
      state.session_cleanup.push({ label, scope: "local", fallback_http: response.status });
    } catch (error) {
      state.session_cleanup.push({
        label,
        scope: "local",
        status: "UNVERIFIED",
        error_class: error.name,
      });
    }
  }
  if (browser) await browser.close();
  state.finished_at = new Date().toISOString();
  await persist();
}
console.log(
  JSON.stringify({
    pass: state.tests.filter((x) => x.status === "PASS").length,
    fail: state.tests.filter((x) => x.status === "FAIL").length,
    page_errors: state.page_errors,
    auth_sessions_issued: state.auth_sessions_issued,
    auth_refreshes_issued: state.auth_refreshes_issued,
    business_writes: 0,
    provider_operations: 0,
  }),
);
if (state.tests.some((x) => x.status === "FAIL")) process.exitCode = 1;
