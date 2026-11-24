// Optional real-browser acceptance. All account/database/Auth responses are synthetic.
// Install free Playwright separately under /tmp; no application dependency changes.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { build as viteBuild } from "vite";
import tailwindcss from "@tailwindcss/vite";

const modulePath =
  process.env.APERO_PLAYWRIGHT_MODULE ??
  "/tmp/apero-onboarding-tooling/browser/node_modules/playwright/index.mjs";
const { chromium } = await import(pathToFileURL(modulePath));
const repo = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "apero-responsive-"));
const evidenceDirectory = process.env.APERO_BROWSER_EVIDENCE_DIR;
const artifactDirectory = evidenceDirectory
  ? resolve(evidenceDirectory)
  : join(directory, "evidence");
await mkdir(artifactDirectory, { recursive: true });
let browser;
let server;
try {
  await build({
    stdin: {
      contents: `
import React from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {ClinicReadinessPanel} from "./src/components/clinic-readiness-panel";
import {AccountAccessPanel} from "./src/components/account-access-panel";
const cid="00000000-0000-4000-8000-000000000100";
const member=(id,name,role,revoked_at=null)=>({id,full_name:name,role,revoked_at,email:id+".very-long-synthetic-clinic-account@example.test",invite_status:revoked_at?"revoked":"active",invited_at:null,invite_accepted_at:null});
window.fixture={
 auth:{role:"owner",clinicId:cid,profile:{id:"owner",revoked_at:null}},
 members:[member("owner","Synthetic Owner","owner"),member("staff","موظف العيادة Synthetic Staff","staff"),member("revoked","عضو موقوف Synthetic Revoked Member","staff","2026-11-24")],
 requests:[],restoreError:false,readinessError:false,
 readiness:{clinic_id:cid,state:"onboarding_incomplete",configuration_complete:false,failures:["Configure eligible practitioner hours and review بيانات العيادة before activation.","Confirm pending accounts or revoke unused invitations."],consent_revision:null,activated_at:null,external_dependencies:[{name:"Retell and live telephone readiness",status:"EXTERNAL / UNKNOWN"},{name:"Integration and owner MFA deployment verification",status:"EXTERNAL / UNKNOWN"},{name:"Service-duration compatibility with the existing scheduler",status:"EXTERNAL / UNKNOWN"},{name:"Clinic representative UAT and release approval",status:"EXTERNAL / UNKNOWN"}]},
 async rpc(name,args){this.requests.push({name,args});
 if(name==="clinic_activation_readiness")return this.readinessError?{data:null,error:{message:"PRIVATE_DATABASE_DIAGNOSTIC"}}:{data:this.readiness,error:null};
 if(name==="reactivate_clinic_member"){
 if(this.restoreError)return {data:null,error:{message:"PRIVATE_RESTORE_DIAGNOSTIC"}};
 this.members.find(m=>m.id===args.p_profile_id).revoked_at=null;
 return {data:args.p_profile_id,error:null};}
 if(name==="revoke_clinic_member"){this.members.find(m=>m.id===args.p_profile_id).revoked_at="2026-11-24";return {data:args.p_profile_id,error:null};}
 throw new Error("Unexpected synthetic RPC: "+name);},
 from(table){if(table!=="profiles")throw new Error("Unexpected table");let id;const query={select(){return query},eq(column,value){if(column==="id")id=value;return query},async single(){return {data:window.fixture.members.find(m=>m.id===id),error:null}}};return query;}
};
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
const root=createRoot(document.getElementById("root"));
window.renderFixture=()=>root.render(<QueryClientProvider client={client}><main className="mx-auto grid w-full max-w-5xl min-w-0 gap-6 p-4 sm:p-6"><h1 className="text-2xl font-semibold">Clinic account acceptance</h1><ClinicReadinessPanel/><AccountAccessPanel/></main></QueryClientProvider>);
window.refreshFixture=()=>client.invalidateQueries();
window.renderFixture();`,
      resolveDir: repo,
      loader: "tsx",
    },
    outfile: join(directory, "harness.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "synthetic-account-only",
        setup(builder) {
          builder.onResolve(
            { filter: /^(@\/lib\/(auth|db|team-management)|@\/integrations\/supabase\/client)$/ },
            (args) => ({ path: args.path, namespace: "fixture" }),
          );
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents:
              args.path === "@/lib/auth"
                ? "export const useAuth=()=>window.fixture.auth;"
                : args.path === "@/lib/db"
                  ? "export const db={rpc:(...args)=>window.fixture.rpc(...args),from:(...args)=>window.fixture.from(...args)};"
                  : args.path === "@/lib/team-management"
                    ? "export const loadTeam=async()=>window.fixture.members.map(m=>({...m}));export const sendTeamInvitation=async()=>{throw new Error('Invitations disabled in synthetic acceptance')};"
                    : "export const supabase={auth:{mfa:{listFactors:async()=>({data:{all:[]},error:null}),getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1'},error:null})}}};",
          }));
        },
      },
    ],
  });
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic clinic account acceptance</title></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
  );
  await writeFile(
    join(directory, "entry.js"),
    `import ${JSON.stringify(join(repo, "src/styles.css"))};import "./harness.js";`,
  );
  await viteBuild({
    configFile: false,
    root: directory,
    plugins: [tailwindcss()],
    build: { outDir: join(directory, "dist"), emptyOutDir: true },
    logLevel: "warn",
  });
  const dist = join(directory, "dist");
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const path = resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!path.startsWith(dist + "/")) {
        response.writeHead(403).end();
        return;
      }
      const content = await readFile(path);
      response.setHeader(
        "content-type",
        { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[
          extname(path)
        ] ?? "application/octet-stream",
      );
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const evidence = {
    runtime: "Chromium / Playwright",
    browser_version: browser.version(),
    playwright_version: JSON.parse(
      await readFile(new URL("./package.json", pathToFileURL(modulePath)), "utf8"),
    ).version,
    synthetic_only: true,
    external_requests: [],
    scenarios: [],
  };
  for (const width of [375, 768, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    await context.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      evidence.external_requests.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Restore access for عضو موقوف Synthetic Revoked Member" })
      .waitFor();
    const geometry = async () =>
      page.evaluate(() => ({
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll("main *,[role='dialog'] *")]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
          })
          .map((e) => ({
            tag: e.tagName,
            text: e.textContent.slice(0, 100),
            width: e.getBoundingClientRect().width,
          })),
      }));
    const initial = await geometry();
    assert.ok(
      initial.scrollWidth <= width + 1,
      `Page overflow at ${width}: ${JSON.stringify(initial)}`,
    );
    assert.deepEqual(initial.overflow, [], `Offscreen account content at ${width}`);
    await page.screenshot({
      path: join(artifactDirectory, `account-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Restore access for عضو موقوف Synthetic Revoked Member" })
      .focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page.getByRole("heading", { name: "Restore clinic access?" }).waitFor();
    assert.equal(
      await page.evaluate(
        () => window.fixture.requests.filter((r) => r.name === "reactivate_clinic_member").length,
      ),
      0,
      "Opening confirmation must not restore access",
    );
    const dialogBox = await dialog.boundingBox();
    assert.ok(
      dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= width + 1,
      `Dialog overflow ${width}`,
    );
    assert.ok(
      dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 901,
      `Dialog outside viewport ${width}`,
    );
    for (let count = 0; count < 6; count++) {
      await page.keyboard.press("Tab");
      assert.ok(
        await dialog.evaluate((element) => element.contains(document.activeElement)),
        "Keyboard focus escaped confirmation dialog",
      );
    }
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Restore access for عضو موقوف Synthetic Revoked Member" })
      .click();
    await page.evaluate(() => {
      window.fixture.restoreError = true;
    });
    await page.getByRole("button", { name: "Confirm restoration" }).click();
    await dialog.getByRole("alert").waitFor();
    assert.match(await dialog.textContent(), /Could not restore clinic access/);
    assert.ok(!(await dialog.textContent()).includes("PRIVATE_RESTORE_DIAGNOSTIC"));
    const failed = await geometry();
    assert.ok(failed.scrollWidth <= width + 1, `Error dialog overflow ${width}`);
    await page.screenshot({
      path: join(artifactDirectory, `restore-error-${width}.png`),
      fullPage: true,
    });
    await page.evaluate(() => {
      window.fixture.restoreError = false;
    });
    await page.getByRole("button", { name: "Confirm restoration" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("button", { name: "Revoke access for عضو موقوف Synthetic Revoked Member" })
      .waitFor();
    await page.evaluate(async () => {
      window.fixture.readinessError = true;
      await window.refreshFixture();
    });
    await page
      .getByRole("alert")
      .filter({ hasText: "Clinic readiness could not be verified" })
      .waitFor();
    assert.ok(!(await page.textContent("body")).includes("PRIVATE_DATABASE_DIAGNOSTIC"));
    await page.evaluate(async () => {
      window.fixture.readinessError = false;
      await window.refreshFixture();
    });
    await page.getByText("Onboarding incomplete", { exact: true }).waitFor();
    for (const role of ["manager", "staff"]) {
      await page.evaluate((role) => {
        window.fixture.auth.role = role;
        window.renderFixture();
      }, role);
      await page
        .getByRole("heading", { name: "Clinic activation readiness" })
        .waitFor({ state: "hidden" });
      assert.equal(await page.getByRole("button", { name: "Invite user", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: /Restore access for/ }).count(), 0);
      assert.equal(await page.getByRole("button", { name: /Revoke access for/ }).count(), 0);
    }
    assert.deepEqual(browserErrors, []);
    evidence.scenarios.push({
      width,
      height: 900,
      page_scroll_width: initial.scrollWidth,
      dialog: dialogBox,
      status: "VERIFIED",
      checks: [
        "real CSS page overflow",
        "restore confirmation",
        "keyboard Enter/Tab/Escape",
        "error sanitization",
        "restoration success",
        "readiness error/recovery",
        "manager/staff UI boundaries",
      ],
    });
    await context.close();
  }
  assert.deepEqual(evidence.external_requests, []);
  await writeFile(
    join(artifactDirectory, "responsive-browser-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    `PASS real Chromium synthetic readiness/account acceptance at 375/768/1440. Evidence: ${artifactDirectory}`,
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  await rm(directory, { recursive: true, force: true });
}
