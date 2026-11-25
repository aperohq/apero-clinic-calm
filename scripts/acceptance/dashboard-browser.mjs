// Actual page/route-shell/layout browser acceptance with synthetic Auth and database boundaries.
// No hosted accounts, service-role keys, provider writes, or remote traffic.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import tailwindcss from "@tailwindcss/vite";
const { chromium } = await import(
  pathToFileURL(
    process.env.APERO_PLAYWRIGHT_MODULE ??
      "/tmp/apero-onboarding-tooling/browser/node_modules/playwright/index.mjs",
  )
);
const repo = process.cwd(),
  dir = await mkdtemp(join(tmpdir(), "apero-dashboard-browser-"));
const out = resolve(process.env.APERO_BROWSER_EVIDENCE_DIR ?? "docs/release/2026-11-24/evidence");
await mkdir(out, { recursive: true });
const entries = [
  ["/login", "login"],
  ["/home", "home"],
  ["/calendar", "calendar"],
  ["/clients", "clients.index"],
  ["/staff", "staff.index"],
  ["/conversations", "conversations.index"],
  ["/requests", "requests"],
  ["/analytics", "analytics"],
  ["/account", "account"],
  ["/account/team", "account_.team"],
  ["/account/settings", "account_.settings"],
];
const evidence = {
  checked_at: new Date().toISOString(),
  baseline: "cd858f56cf87269e0bc70e25fceaca0dd8602c98",
  scope:
    "Actual page components, RouteShell, AppLayout and TanStack router; synthetic auth/database responses. File-route generation/SSR/hosted Auth not certified.",
  tests: [],
  errors: [],
  external_requests: [],
};
let browser, server;
try {
  await build({
    stdin: {
      contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRouter,createRoute,createRootRoute,RouterProvider,Outlet} from '@tanstack/react-router';
import {RouteShell} from './src/components/route-shell';
import {ConversationDetailPage} from './src/components/clinic-pages';
${entries.map(([, file], i) => `import {Route as R${i}} from './src/routes/${file}';`).join("\n")}
const clinic={id:'00000000-0000-4000-8000-000000000100',name:'Synthetic Acceptance Clinic عيادة اختبار',localized_name:'عيادة اختبار',timezone:'Asia/Kuwait',clinic_type:'Dental',email:'clinic@example.test',phone:'+96522220000',website:'https://example.test',address:'Synthetic building',city:'Kuwait',country:'Kuwait',directions:'',parking_information:'',receptionist_name:'Apero',receptionist_localized_name:'أبيرو',opening_hours:null,live_transfer_enabled:false};
const profile={id:'owner',full_name:'Synthetic Owner مالك',role:'owner',clinic_id:clinic.id,revoked_at:null};
window.fixture={role:'owner',mode:'normal',requests:[],delay:0,error:false,clinic,profile,conversations:[{id:'synthetic-conversation',clinic_id:clinic.id,title:'Synthetic call only',status:'completed',outcome:'information',caller_phone:'+96522220001',started_at:new Date().toISOString(),duration_seconds:42,summary:'Synthetic summary for display acceptance.',transcript:'Receptionist: Synthetic greeting.\\nCaller: Synthetic question.',client_id:null,appointment_id:null}],
 async signOut(){this.mode='anonymous';window.rerender();return {error:null}},
 async signIn(){if(this.error)return {error:'Invalid email or password'};this.mode='normal';window.rerender();return {error:null}},
 async sendPasswordReset(){return {error:null}},async updatePassword(){return {error:null}},async refreshProfile(){},
 response(name,args,single){this.requests.push({name,args});if(this.error)return {data:null,error:{message:'PRIVATE_SYNTHETIC_DIAGNOSTIC'}};
 if(name==='clinics')return {data:clinic,error:null};
 if(name==='profiles')return {data:single?profile:[profile],error:null};
 if(name==='clinic_team_members')return {data:[{...profile,email:'owner@example.test',invite_status:'active',invited_at:null,invite_accepted_at:null}],error:null};
 if(name==='clinic_activation_readiness')return {data:{clinic_id:clinic.id,state:'onboarding_incomplete',configuration_complete:false,failures:['Synthetic configuration incomplete'],consent_revision:null,activated_at:null,external_dependencies:[]},error:null};
 if(name==='integration_dashboard')return {data:{keys:[],connections:[],failed_jobs:0},error:null};
 if(name==='clinic_analytics')return {data:{timezone:'Asia/Kuwait',startDate:'2026-11-01',endDate:'2026-11-24',totalCalls:0,totalAppointments:0,bookedAppointments:0,cancelledAppointments:0,otherAppointments:0,trend:[],practitioners:[],services:[],otherPractitionerAppointments:0,otherServiceAppointments:0},error:null};
 if(this.populated&&name==='clients')return {data:[{id:'client',clinic_id:clinic.id,full_name:'Synthetic Client عميل',phone:'+96522220001',email:'client@example.test',created_at:new Date().toISOString()}],error:null};
 if(this.populated&&name==='staff')return {data:[{id:'practitioner',clinic_id:clinic.id,full_name:'Dr Synthetic طبيب',specialty:'Dentist',services:['Consultation'],active:true,created_at:new Date().toISOString()}],error:null};
 if(this.populated&&name==='appointments')return {data:[{id:'appointment',clinic_id:clinic.id,client_id:'client',staff_id:'practitioner',service:'Consultation',status:'Booked',start_time:new Date().toISOString(),end_time:new Date(Date.now()+1800000).toISOString(),created_at:new Date().toISOString()}],error:null};
 if(name==='conversations')return {data:this.conversations,error:null};return {data:[],error:null};},
 query(name,args){let single=false;const q=new Proxy({}, {get:(_,key)=>key==='then'?(yes,no)=>new Promise(r=>setTimeout(()=>r(this.response(name,args,single)),this.delay)).then(yes,no):(...values)=>{if(key==='single'||key==='maybeSingle')single=true;return q}});return q;}};
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
const rootRoute=createRootRoute({component:()=> <QueryClientProvider client={client}><Outlet/></QueryClientProvider>});
const routes=[${entries.map(([path], i) => `createRoute({getParentRoute:()=>rootRoute,path:${JSON.stringify(path)},component:${["clients.index", "staff.index", "conversations.index"].includes(entries[i][1]) ? `()=><RouteShell><R${i}.options.component/></RouteShell>` : `R${i}.options.component`}})`).join(",")},createRoute({getParentRoute:()=>rootRoute,path:'/conversations/synthetic-conversation',component:()=> <RouteShell><ConversationDetailPage id="synthetic-conversation"/></RouteShell>})];
const router=createRouter({routeTree:rootRoute.addChildren(routes),defaultPreload:false});window.router=router;
const root=createRoot(document.getElementById('root'));window.rerender=()=>root.render(<RouterProvider router={router} key={window.fixture.role+window.fixture.mode}/>);window.resetQueries=()=>client.resetQueries();window.rerender();
`,
      resolveDir: repo,
      loader: "tsx",
    },
    outfile: join(dir, "harness.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.VITE_APERO_INTEGRATIONS_ENABLED": '"true"',
    },
    plugins: [
      {
        name: "synthetic-boundaries",
        setup(b) {
          b.onResolve(
            {
              filter:
                /(?:^@\/lib\/auth$|^@\/lib\/db$|^\.\/db$|^@\/integrations\/supabase\/client$)/,
            },
            (args) => ({ path: args.path, namespace: "fixture" }),
          );
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.endsWith("/auth")
              ? `export const useAuth=()=>({...window.fixture,loading:window.fixture.mode==='loading',authError:window.fixture.mode==='auth-error',session:window.fixture.mode==='anonymous'?null:{user:{id:'owner',email:'owner@example.test'}},profile:window.fixture.profile,clinicId:window.fixture.mode==='unlinked'?null:window.fixture.clinic.id,role:window.fixture.role,signIn:(...a)=>window.fixture.signIn(...a),signOut:()=>window.fixture.signOut(),sendPasswordReset:(...a)=>window.fixture.sendPasswordReset(...a),updatePassword:(...a)=>window.fixture.updatePassword(...a)});`
              : `const client={from:(name)=>window.fixture.query(name),rpc:(name,args)=>window.fixture.query(name,args),functions:{invoke:async()=>({data:null,error:{message:'Synthetic external operations disabled'}})},auth:{mfa:{listFactors:async()=>({data:{all:[]},error:null}),getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1'},error:null})}}};export const db=client;export const supabase=client;`,
          }));
        },
      },
    ],
  });
  await writeFile(
    join(dir, "index.html"),
    '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>',
  );
  await writeFile(
    join(dir, "entry.js"),
    `import ${JSON.stringify(join(repo, "src/styles.css"))};import './harness.js';`,
  );
  await viteBuild({
    configFile: false,
    root: dir,
    plugins: [tailwindcss()],
    build: { outDir: join(dir, "dist"), emptyOutDir: true },
    logLevel: "warn",
  });
  server = createServer(async (req, res) => {
    try {
      let name = new URL(req.url, "http://localhost").pathname;
      if (!extname(name)) name = "/index.html";
      const file = resolve(dir, "dist", "." + name);
      if (!file.startsWith(join(dir, "dist") + "/")) throw Error();
      res.setHeader(
        "content-type",
        {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        }[extname(file)] ?? "application/octet-stream",
      );
      let content;
      try {
        content = await readFile(file);
      } catch {
        content = await readFile(resolve(repo, "public", "." + name));
      }
      res.end(content);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true });
  evidence.browser_version = browser.version();
  const check = (id, ok, detail = {}) => {
    evidence.tests.push({ id, status: ok ? "PASS" : "FAIL", ...detail });
    console.log(id, ok ? "PASS" : "FAIL");
  };
  for (const width of process.env.APERO_BROWSER_FOCUS ? [] : [1440, 768, 390, 320]) {
    const ctx = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    await ctx.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      evidence.external_requests.push(new URL(route.request().url()).origin);
      return route.abort();
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => evidence.errors.push({ width, message: e.message }));
    for (const role of ["owner", "manager", "staff"]) {
      for (const [path] of entries.filter(([p]) => p !== "/login")) {
        await page.goto(origin + path);
        await page.waitForFunction(() => !!window.fixture);
        await page.evaluate((role) => {
          window.fixture.role = role;
          window.rerender();
        }, role);
        await page.waitForTimeout(180);
        const denied =
          (await page
            .getByText("This section isn’t available for your role.", { exact: true })
            .count()) > 0;
        const expectedDenied =
          (role === "staff" &&
            ["/staff", "/requests", "/analytics", "/account/team", "/account/settings"].includes(
              path,
            )) ||
          (role === "manager" && path === "/account/settings");
        const geometry = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          text: document.body.innerText.slice(0, 80),
        }));
        const hasNav =
          width >= 1024
            ? (await page.getByRole("navigation", { name: "Dashboard" }).count()) > 0
            : (await page.getByRole("button", { name: "Open menu", exact: true }).count()) > 0;
        check(
          "route:" + role + ":" + width + ":" + path,
          hasNav && denied === expectedDenied && geometry.scroll <= width + 1,
          { role, path, width, expectedDenied, denied, scrollWidth: geometry.scroll },
        );
        if (role === "owner" && width !== 320)
          await page.screenshot({
            path: join(out, "browser-" + path.replaceAll("/", "_") + "-" + width + ".png"),
            fullPage: true,
          });
      }
    }
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await ctx.route("**/*", (r) =>
    new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
  );
  const page = await ctx.newPage();
  await page.goto(origin + "/home");
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  check(
    "mobile-menu-open",
    await page.getByRole("complementary", { name: "Clinic navigation" }).isVisible(),
  );
  await page
    .getByRole("complementary", { name: "Clinic navigation" })
    .getByRole("link", { name: "Calendar", exact: true })
    .click();
  await page.waitForURL("**/calendar");
  check(
    "mobile-menu-navigation",
    !(await page.getByRole("complementary", { name: "Clinic navigation" }).isVisible()),
  );
  for (const [mode, expected] of [
    ["loading", "Loading your clinic workspace"],
    ["auth-error", "We couldn’t load your account"],
    ["unlinked", "No clinic is linked"],
  ]) {
    await page.goto(origin + "/home");
    await page.evaluate((mode) => {
      window.fixture.mode = mode;
      window.rerender();
    }, mode);
    await page.waitForTimeout(100);
    check("auth-state:" + mode, (await page.locator("body").innerText()).includes(expected));
  }
  await page.goto(origin + "/home");
  await page.evaluate(() => {
    window.fixture.mode = "anonymous";
    window.rerender();
  });
  await page.waitForURL("**/login");
  check("anonymous-route-redirect", (await page.locator("input[type=password]").count()) === 1);
  await page.locator("input[type=email]").fill("owner@example.test");
  await page.locator("input[type=password]").fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/home");
  check("login-form-navigation", true);
  await page.goto(origin + "/calendar");
  await page.getByRole("button", { name: "New appointment", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  const box = await page.getByRole("dialog").boundingBox();
  check("appointment-dialog-mobile", box.x >= 0 && box.x + box.width <= 391);
  await page.keyboard.press("Escape");
  check("appointment-dialog-close", (await page.getByRole("dialog").count()) === 0);
  await page.goto(origin + "/analytics");
  await page.getByRole("combobox").selectOption("7");
  await page.waitForTimeout(150);
  check("analytics-range-control", (await page.getByRole("combobox").inputValue()) === "7");
  await page.goto(origin + "/account/settings");
  await page.getByLabel("Clinic name", { exact: true }).fill("Changed synthetic name");
  await page.getByRole("button", { name: "Reload saved values", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  check(
    "settings-discard-confirmation",
    (await page.getByRole("heading", { name: "Discard unsaved changes?" }).count()) === 1,
  );
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await page.waitForTimeout(100);
  check(
    "settings-discard-reverts",
    (await page.getByLabel("Clinic name", { exact: true }).inputValue()) ===
      "Synthetic Acceptance Clinic عيادة اختبار",
  );
  for (const path of ["/clients", "/staff", "/calendar"]) {
    await page.goto(origin + path);
    await page.evaluate(() => {
      window.fixture.populated = true;
      window.resetQueries();
      window.rerender();
    });
    await page.waitForTimeout(200);
    const text = await page.locator("body").innerText();
    check(
      "populated:" + path,
      path === "/staff" ? text.includes("Dr Synthetic") : text.includes("Synthetic Client"),
    );
  }
  await page.goto(origin + "/analytics");
  await page.evaluate(() => {
    window.fixture.error = true;
    window.resetQueries();
    window.rerender();
  });
  await page.getByRole("alert").waitFor();
  check(
    "analytics-error-sanitized",
    !(await page.locator("body").innerText()).includes("PRIVATE_SYNTHETIC_DIAGNOSTIC"),
  );
  await page.evaluate(() => {
    window.fixture.error = false;
  });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.waitForTimeout(200);
  check("analytics-retry", (await page.getByRole("alert").count()) === 0);
  await page.goto(origin + "/account");
  await page.getByText("Onboarding incomplete", { exact: true }).waitFor();
  check("readiness-incomplete-rendered", true);
  await page.getByRole("button", { name: "Refresh status", exact: true }).waitFor();
  await page.evaluate(() => {
    window.fixture.error = true;
  });
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.waitForTimeout(150);
  check(
    "integrations-refresh-error",
    (await page.locator("body").innerText()).includes("Integrations are unavailable"),
  );
  await page.goto(origin + "/conversations/synthetic-conversation");
  await page.getByRole("button", { name: /Load recording/ }).click();
  await page.waitForTimeout(150);
  check("recording-denied-error", (await page.locator("body").innerText()).includes("unavailable"));
  for (const path of ["/home", "/calendar", "/clients", "/staff", "/conversations"]) {
    await page.goto(origin + path);
    await page.evaluate(() => {
      window.fixture.delay = 800;
      window.resetQueries();
    });
    await page.getByText("Loading clinic information…", { exact: true }).waitFor();
    check("data-loading:" + path, true);
    await page
      .getByText("Loading clinic information…", { exact: true })
      .waitFor({ state: "hidden" });
    await page.evaluate(() => {
      window.fixture.delay = 0;
      window.fixture.error = true;
      window.resetQueries();
    });
    await page.getByText("We couldn’t load this page.", { exact: false }).waitFor();
    check(
      "data-error-sanitized:" + path,
      !(await page.locator("body").innerText()).includes("PRIVATE_SYNTHETIC_DIAGNOSTIC"),
    );
    await page.evaluate(() => {
      window.fixture.error = false;
    });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page
      .getByText("We couldn’t load this page.", { exact: false })
      .waitFor({ state: "hidden" });
    check("data-retry:" + path, true);
  }
  await ctx.close();
} catch (error) {
  evidence.fatal = { name: error.name, message: error.message };
  console.error(error);
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  await writeFile(join(out, "browser-results.json"), JSON.stringify(evidence, null, 2));
  await rm(dir, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    pass: evidence.tests.filter((t) => t.status === "PASS").length,
    fail: evidence.tests.filter((t) => t.status === "FAIL").length,
    errors: evidence.errors,
    fatal: evidence.fatal,
  }),
);
if (evidence.fatal || evidence.errors.length || evidence.tests.some((t) => t.status === "FAIL"))
  process.exitCode = 1;
