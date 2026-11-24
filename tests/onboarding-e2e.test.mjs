// Real browser -> real Supabase SDK -> localhost Auth/PostgREST test adapter ->
// native PostgreSQL RPC/RLS. Only Auth issuance/transport are synthetic; business
// decisions, persistence and permissions use the actual complete migration chain.
// No production URL, providers, invitations or external network are accepted.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import tailwindcss from "@tailwindcss/vite";
import postgres from "postgres";
import { disposablePostgres } from "../scripts/helpers/disposable-postgres.mjs";

const modulePath =
  process.env.APERO_PLAYWRIGHT_MODULE ??
  "/tmp/apero-onboarding-tooling/browser/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(modulePath));
const directory = await mkdtemp(join(tmpdir(), "apero-onboarding-e2e-"));
const cluster = await disposablePostgres({ cron: true, database: "apero_onboarding_browser" });
const sql = postgres({ ...cluster, max: 8, onnotice() {} });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let browser,
  server,
  success = false,
  origin;
const users = new Map(
  ["owner", "manager", "staff", "foreign"].map((name, index) => [
    name,
    {
      id: id(100 + index),
      email: `${name}@synthetic.test`,
      role: "authenticated",
      aud: "authenticated",
      created_at: "2026-01-01T00:00:00Z",
      app_metadata: { provider: "email" },
      user_metadata: { role: "owner", clinic_id: id(9999) },
      factors: [],
    },
  ]),
);
const tokens = new Map(),
  signingKey = randomBytes(32);
const evidence = {
  synthetic_only: true,
  auth_issuance: "Local test adapter; hosted GoTrue/JWT policy remains external",
  database: "Native PostgreSQL, Unix socket only",
  external_requests: [],
  checks: [],
};
const service = (fn) =>
  sql.begin(async (tx) => {
    await tx.unsafe("set local role service_role");
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    return fn(tx);
  });
const response = (res, status, value, extra = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify(value));
};
const body = async (req) => {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 262144) throw new Error("Synthetic request too large");
  }
  return data ? JSON.parse(data) : {};
};
try {
  await sql.unsafe(`create role anon nologin nobypassrls;create role authenticated nologin nobypassrls;create role service_role nologin bypassrls;
 create schema auth;create table auth.users(id uuid primary key,email text,invited_at timestamptz,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
 grant usage on schema public,auth to anon,authenticated,service_role;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
 create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
 alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  const migrationConnection = await sql.reserve();
  try {
    for (const filename of (await readdir("supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await migrationConnection.unsafe(await readFile(`supabase/migrations/${filename}`, "utf8"));
  } finally {
    migrationConnection.release();
  }
  for (const user of users.values())
    await sql`insert into auth.users(id,email,email_confirmed_at) values(${user.id},${user.email},now())`;
  const doc = await readFile("docs/onboarding/ADMINISTRATIVE_INTAKE.md", "utf8");
  const intake = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
  intake.owner_auth_id = users.get("owner").id;
  intake.owner_name = "E2E Owner";
  intake.synthetic = false;
  const clinic = await service(
    async (tx) =>
      (await tx`select provision_clinic('e2e-native-intake',${tx.json(intake)}) id`)[0].id,
  );
  const other = structuredClone(intake);
  other.owner_auth_id = users.get("foreign").id;
  other.clinic.phone = "+96555550124";
  other.owner_name = "E2E Foreign Owner";
  const foreignClinic = await service(
    async (tx) =>
      (await tx`select provision_clinic('e2e-foreign-intake',${tx.json(other)}) id`)[0].id,
  );
  for (const name of ["manager", "staff"])
    await service(
      (tx) =>
        tx`insert into profiles(auth_user_id,clinic_id,full_name,email,role) values(${users.get(name).id},${clinic},${"E2E " + name},${users.get(name).email},${name}::profile_role)`,
    );
  const [{ id: staffProfile }] =
    await sql`select id from profiles where auth_user_id=${users.get("staff").id}`;
  const [{ version }] = await sql`select current_setting('server_version') version`;
  evidence.postgres_version = version;
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin ?? "http://127.0.0.1");
      if (url.pathname === "/auth/v1/token") {
        const input = await body(req),
          user = [...users.values()].find((u) => u.email === input.email);
        if (!user || input.password !== "SyntheticTest123!")
          return response(res, 400, { error: "invalid_credentials" });
        const now = Math.floor(Date.now() / 1000),
          payload = Buffer.from(
            JSON.stringify({
              sub: user.id,
              role: "authenticated",
              aal: "aal1",
              amr: [],
              iat: now,
              exp: now + 3600,
              session_id: user.id,
            }),
          ).toString("base64url");
        const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
        const token = `${header}.${payload}.${createHmac("sha256", signingKey).update(`${header}.${payload}`).digest("base64url")}`;
        tokens.set(token, user);
        return response(res, 200, {
          access_token: token,
          refresh_token: "synthetic-only",
          expires_in: 3600,
          expires_at: now + 3600,
          token_type: "bearer",
          user,
        });
      }
      const user = tokens.get(req.headers.authorization?.replace(/^Bearer /, ""));
      if (url.pathname === "/auth/v1/user")
        return response(res, user ? 200 : 401, user ?? { message: "Invalid synthetic identity" });
      if (url.pathname.startsWith("/rest/v1/")) {
        if (!user) return response(res, 401, { code: "invalid_token" });
        const input = req.method === "POST" ? await body(req) : {};
        const data = await sql.begin(async (tx) => {
          await tx.unsafe("set local role authenticated");
          await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: user.id, role: "authenticated", user_metadata: user.user_metadata })},true)`;
          const rpc = url.pathname.split("/rpc/")[1];
          if (rpc) {
            if (rpc === "clinic_team_members")
              return { value: await tx`select * from clinic_team_members()` };
            if (rpc === "clinic_activation_readiness")
              return {
                value: (
                  await tx`select clinic_activation_readiness(${input.p_clinic_id ?? null}) value`
                )[0].value,
              };
            if (rpc === "set_clinic_member_role")
              return {
                value: (
                  await tx`select set_clinic_member_role(${input.p_profile_id},${input.p_role}::profile_role) value`
                )[0].value,
              };
            if (rpc === "revoke_clinic_member")
              return {
                value: (await tx`select revoke_clinic_member(${input.p_profile_id}) value`)[0]
                  .value,
              };
            if (rpc === "reactivate_clinic_member")
              return {
                value: (await tx`select reactivate_clinic_member(${input.p_profile_id}) value`)[0]
                  .value,
              };
            // These reach the actual database privilege boundary, never a trusted role.
            if (rpc === "provision_clinic")
              return {
                value: (
                  await tx`select provision_clinic(${input.p_submission_key},${tx.json(input.p_payload)}) value`
                )[0].value,
              };
            if (rpc === "decide_clinic_lifecycle")
              return {
                value: (
                  await tx`select decide_clinic_lifecycle(${input.p_clinic_id},${input.p_action},${input.p_reason},${input.p_consent_revision ?? null},${input.p_external_approved ?? false}) value`
                )[0].value,
              };
            throw Object.assign(new Error("Unsupported test RPC"), { code: "22023" });
          }
          const table = url.pathname.slice("/rest/v1/".length);
          if (!["profiles", "clinics"].includes(table) || req.method !== "GET")
            throw Object.assign(new Error("Unsupported test relation"), { code: "22023" });
          const allowed = new Set([
            "id",
            "auth_user_id",
            "clinic_id",
            "role",
            "revoked_at",
            "full_name",
            "email",
          ]);
          const selected = url.searchParams.get("select") ?? "*";
          if (selected !== "*" && !selected.split(",").every((c) => allowed.has(c)))
            throw new Error("Unsupported synthetic projection");
          const filters = [],
            params = [];
          for (const [name, value] of url.searchParams) {
            if (["select", "limit", "offset"].includes(name)) continue;
            if (
              !["id", "auth_user_id", "clinic_id"].includes(name) ||
              !/^eq\.[0-9a-f-]{36}$/i.test(value)
            )
              throw new Error("Unsupported synthetic filter");
            params.push(value.slice(3));
            filters.push(`"${name}"=$${params.length}`);
          }
          const rows = await tx.unsafe(
            `select ${
              selected === "*"
                ? "*"
                : selected
                    .split(",")
                    .map((c) => `"${c}"`)
                    .join(",")
            } from public."${table}"${filters.length ? " where " + filters.join(" and ") : ""}`,
            params,
          );
          return {
            value: [...rows],
            single: req.headers.accept?.includes("application/vnd.pgrst.object+json"),
          };
        });
        if (data.single) {
          if (data.value.length !== 1)
            return response(res, 406, { code: "PGRST116", message: "Expected one synthetic row" });
          return response(res, 200, data.value[0]);
        }
        return response(res, 200, data.value, {
          "content-range": Array.isArray(data.value)
            ? `0-${Math.max(0, data.value.length - 1)}/${data.value.length}`
            : "*/*",
        });
      }
      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1),
        path = resolve(directory, "dist", relative);
      if (!path.startsWith(resolve(directory, "dist") + "/")) return response(res, 403, {});
      const file = await readFile(path);
      res.writeHead(200, {
        "content-type":
          { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[
            extname(path)
          ] ?? "application/octet-stream",
      });
      res.end(file);
    } catch (error) {
      response(res, error.code === "42501" ? 403 : 400, {
        code: error.code ?? "test_error",
        message: error.message,
      });
    }
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
 import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
 import {supabase} from '@/integrations/supabase/client';import {AccountAccessPanel} from './src/components/account-access-panel';import {ClinicReadinessPanel} from './src/components/clinic-readiness-panel';
 const users=${JSON.stringify(Object.fromEntries([...users].map(([name, u]) => [name, { email: u.email }])))};
 const actor=new URLSearchParams(location.search).get('actor')??'owner';const client=new QueryClient({defaultOptions:{queries:{retry:false}}});const root=createRoot(document.getElementById('root'));
 window.sdk=supabase;window.identity={profile:null,role:null,clinicId:null};
 const render=()=>root.render(<QueryClientProvider client={client}><main className='mx-auto max-w-5xl space-y-6 p-6'><h1>Integrated synthetic clinic acceptance</h1><p role='status' data-testid='identity'>{window.identity.role??'No clinic access'}</p><button onClick={()=>window.refreshIdentity()}>Refresh identity</button><ClinicReadinessPanel/><AccountAccessPanel/></main></QueryClientProvider>);
 window.refreshIdentity=async()=>{const {data:auth}=await supabase.auth.getUser();const result=await supabase.from('profiles').select('*').eq('auth_user_id',auth.user.id).maybeSingle();window.identity={profile:result.data,role:result.data?.role??null,clinicId:result.data?.clinic_id??null};client.clear();render();};
 window.ready=(async()=>{const result=await supabase.auth.signInWithPassword({email:users[actor].email,password:'SyntheticTest123!'});if(result.error)throw result.error;await window.refreshIdentity();})();
 `,
    },
    outfile: join(directory, "harness.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "local-auth-transport",
        setup(builder) {
          builder.onResolve(
            { filter: /^(@\/lib\/auth|@\/integrations\/supabase\/client)$/ },
            (args) => ({ path: args.path, namespace: "e2e" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "e2e" }, (args) => ({
            loader: "js",
            contents:
              args.path === "@/lib/auth"
                ? "export const useAuth=()=>window.identity;"
                : `import {createClient} from '@supabase/supabase-js';export const supabase=createClient(${JSON.stringify(origin)},'local-publishable-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});`,
            resolveDir: process.cwd(),
          }));
        },
      },
    ],
  });
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>',
  );
  await writeFile(
    join(directory, "entry.js"),
    `import ${JSON.stringify(join(process.cwd(), "src/styles.css"))};import './harness.js';`,
  );
  await viteBuild({
    configFile: false,
    root: directory,
    plugins: [tailwindcss()],
    build: { outDir: join(directory, "dist"), emptyOutDir: true },
    logLevel: "error",
  });
  browser = await chromium.launch({ headless: true });
  evidence.browser_version = browser.version();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    evidence.external_requests.push(route.request().url());
    return route.abort();
  });
  const ownerPage = await context.newPage(),
    staffPage = await context.newPage();
  for (const [page, actor] of [
    [ownerPage, "owner"],
    [staffPage, "staff"],
  ]) {
    await page.goto(`${origin}/?actor=${actor}`);
    await page.evaluate(() => window.ready);
    await page.getByTestId("identity").getByText(actor, { exact: true }).waitFor();
  }
  await ownerPage.getByText("Configuration complete", { exact: true }).waitFor();
  const foreignRead = await ownerPage.evaluate(async (cid) => {
    const result = await window.sdk.from("clinics").select("id").eq("id", cid);
    return { data: result.data, error: result.error };
  }, foreignClinic);
  assert.deepEqual(foreignRead, { data: [], error: null });
  const escalation = await staffPage.evaluate(async (profile) => {
    const result = await window.sdk.rpc("set_clinic_member_role", {
      p_profile_id: profile,
      p_role: "manager",
    });
    return result.error?.code;
  }, staffProfile);
  assert.equal(escalation, "42501");
  const provisionDenied = await ownerPage.evaluate(async () => {
    const result = await window.sdk.rpc("provision_clinic", {
      p_submission_key: "forged-browser-intake",
      p_payload: {},
    });
    return result.error?.code;
  });
  assert.equal(provisionDenied, "42501");
  const activationDenied = await ownerPage.evaluate(async (cid) => {
    const result = await window.sdk.rpc("decide_clinic_lifecycle", {
      p_clinic_id: cid,
      p_action: "activate",
      p_reason: "forged browser decision",
      p_external_approved: true,
    });
    return result.error?.code;
  }, clinic);
  assert.equal(activationDenied, "42501");
  evidence.checks.push(
    "Native cross-clinic reads denied",
    "Staff role escalation denied",
    "Browser provisioning and activation denied",
  );
  await service(
    (tx) =>
      tx`select decide_clinic_lifecycle(${clinic},'review_technical','Synthetic E2E technical review','e2e-consent')`,
  );
  await ownerPage.getByRole("button", { name: "Check again", exact: true }).click();
  await ownerPage.getByText("Technically activation-ready", { exact: true }).waitFor();
  await service(
    (tx) =>
      tx`select decide_clinic_lifecycle(${clinic},'await_external','Synthetic E2E external review','e2e-consent')`,
  );
  await ownerPage.getByRole("button", { name: "Check again", exact: true }).click();
  await ownerPage.getByText("Awaiting external dependencies", { exact: true }).waitFor();
  assert.equal(
    (await sql`select lifecycle from clinic_onboarding where clinic_id=${clinic}`)[0].lifecycle,
    "configuration",
  );
  evidence.checks.push("Database-backed readiness stages do not auto-activate");
  await ownerPage.getByRole("button", { name: "Revoke access for E2E staff" }).click();
  await ownerPage.getByRole("button", { name: "Confirm revocation" }).click();
  await ownerPage.getByRole("button", { name: "Restore access for E2E staff" }).waitFor();
  assert.ok((await sql`select revoked_at from profiles where id=${staffProfile}`)[0].revoked_at);
  await staffPage.getByRole("button", { name: "Refresh identity", exact: true }).click();
  await staffPage.getByTestId("identity").getByText("No clinic access", { exact: true }).waitFor();
  await ownerPage.getByRole("button", { name: "Restore access for E2E staff" }).click();
  await ownerPage.getByRole("button", { name: "Confirm restoration" }).click();
  await ownerPage.getByRole("button", { name: "Revoke access for E2E staff" }).waitFor();
  assert.equal(
    (await sql`select revoked_at from profiles where id=${staffProfile}`)[0].revoked_at,
    null,
  );
  await staffPage.getByRole("button", { name: "Refresh identity", exact: true }).click();
  await staffPage.getByTestId("identity").getByText("staff", { exact: true }).waitFor();
  evidence.checks.push(
    "UI revocation persists and retained JWT loses RLS access",
    "Explicit UI restoration persists and restores authorized access",
  );
  await ownerPage.getByLabel("Access for E2E staff", { exact: true }).selectOption("manager");
  await assertEventually(async () =>
    assert.equal(
      (await sql`select role from profiles where id=${staffProfile}`)[0].role,
      "manager",
    ),
  );
  await staffPage.getByRole("button", { name: "Refresh identity", exact: true }).click();
  await staffPage.getByTestId("identity").getByText("manager", { exact: true }).waitFor();
  await staffPage.getByText("E2E Owner", { exact: false }).first().waitFor();
  assert.equal(
    await staffPage.getByRole("button", { name: "Invite user", exact: true }).count(),
    0,
  );
  evidence.checks.push("UI role change persists; Manager directory remains read-only");
  await service(
    (tx) =>
      tx`select decide_clinic_lifecycle(${clinic},'suspend','Synthetic E2E clinic suspension')`,
  );
  for (const page of [ownerPage, staffPage]) {
    await page.getByRole("button", { name: "Refresh identity", exact: true }).click();
    await page.getByTestId("identity").getByText("No clinic access", { exact: true }).waitFor();
  }
  evidence.checks.push("Clinic suspension denies existing browser identities");
  assert.deepEqual(evidence.external_requests, []);
  const target = process.env.APERO_E2E_EVIDENCE_DIR;
  if (target) {
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "integrated-e2e-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
  console.log(
    "PASS integrated Chromium -> real Supabase SDK -> native PostgreSQL onboarding/account lifecycle; zero external requests",
  );
  success = true;
} finally {
  await browser?.close();
  if (server) await new Promise((ok) => server.close(ok));
  await sql.end({ timeout: 2 });
  await cluster.close(success);
  await rm(directory, { recursive: true, force: true });
}
async function assertEventually(check) {
  for (let i = 0; i < 100; i++) {
    try {
      return await check();
    } catch (error) {
      if (i === 99) throw error;
      await new Promise((ok) => setTimeout(ok, 20));
    }
  }
}
