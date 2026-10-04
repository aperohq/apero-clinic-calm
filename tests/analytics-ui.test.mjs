import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";
const temp = await mkdtemp(join(tmpdir(), "apero-analytics-ui-"));
const window = new Window({ url: "http://localhost/analytics" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "ResizeObserver"])
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? window : window[name],
    configurable: true,
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [];
const data = {
  timezone: "Asia/Kuwait",
  startDate: "2026-10-01",
  endDate: "2026-10-07",
  totalCalls: 3,
  totalAppointments: 4,
  bookedAppointments: 3,
  cancelledAppointments: 1,
  otherAppointments: 0,
  trend: [{ date: "2026-10-01", calls: 3, appointments: 4 }],
  practitioners: [{ id: "s", label: "Dr Example", count: 4 }],
  services: [{ label: "Consultation", count: 4 }],
  otherPractitionerAppointments: 0,
  otherServiceAppointments: 0,
};
globalThis.analyticsFixture = { role: "owner", data, mode: "success", requests };
try {
  await build({
    entryPoints: [
      "src/components/analytics-page.tsx",
      "src/lib/analytics.ts",
      "src/components/app-layout.tsx",
    ],
    outdir: temp,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    jsx: "automatic",
    plugins: [
      {
        name: "fixture",
        setup(b) {
          b.onResolve({ filter: /^react$/, namespace: "router" }, () => ({
            path: "react",
            external: true,
          }));
          b.onResolve({ filter: /^@tanstack\/react-router$/ }, () => ({
            path: "router",
            namespace: "router",
          }));
          b.onLoad({ filter: /.*/, namespace: "router" }, () => ({
            loader: "js",
            contents: `import React from 'react';export const Link=({to,children,...props})=>React.createElement('a',{href:to,...props},children);export const useNavigate=()=>()=>{};export const useRouterState=({select})=>select({location:{pathname:'/analytics'}});`,
          }));
          b.onResolve({ filter: /^@\/lib\/(auth|db)$/ }, (args) => ({
            path: args.path,
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.endsWith("/auth")
              ? `export function useAuth(){const f=globalThis.analyticsFixture;return {clinic:{timezone:Object.hasOwn(f,'timezone')?f.timezone:'Asia/Kuwait'},clinicId:'clinic-a',profile:{id:'user-a'},role:f.role};}`
              : `export const db={rpc(name,args){const f=globalThis.analyticsFixture;f.requests.push({name,args});return {async abortSignal(){if(f.mode==='loading')await new Promise(r=>f.release=r);return f.mode==='error'?{data:null,error:new Error('SQL_INTERNAL_SECRET_SENTINEL')}:{data:f.data,error:null};}}}};`,
          }));
          b.onResolve({ filter: /^@\// }, (args) => ({
            path: join(
              process.cwd(),
              "src",
              args.path.slice(2) + (args.path.startsWith("@/components/") ? ".tsx" : ".ts"),
            ),
          }));
        },
      },
    ],
  });
  // Resolve external packages from the workspace without changing package installs.
  await writeFile(join(temp, "package.json"), JSON.stringify({ type: "module" }));
  await symlink(join(process.cwd(), "node_modules"), join(temp, "node_modules"));
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { AnalyticsPage } = await import(pathToFileURL(join(temp, "components/analytics-page.js")));
  const { analyticsRange } = await import(pathToFileURL(join(temp, "lib/analytics.js")));
  assert.deepEqual(analyticsRange(7, "Asia/Kuwait", new Date("2026-09-30T21:00Z")), {
    start: "2026-09-25",
    end: "2026-10-01",
  });
  assert.deepEqual(analyticsRange(7, "America/New_York", new Date("2026-03-09T03:30Z")), {
    start: "2026-03-02",
    end: "2026-03-08",
  });
  assert.deepEqual(analyticsRange(7, "Asia/Kuwait", new Date("2024-03-01T12:00:00Z")), {
    start: "2024-02-24",
    end: "2024-03-01",
  });
  for (const days of [7, 30, 90]) {
    const r = analyticsRange(days, "UTC", new Date("2026-01-01T12:00Z"));
    assert.equal((Date.parse(r.end) - Date.parse(r.start)) / 86400000 + 1, days);
  }
  const { AppLayout } = await import(pathToFileURL(join(temp, "components/app-layout.js")));
  async function mount(component = AnalyticsPage) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await React.act(async () => {
      root.render(
        React.createElement(QueryClientProvider, { client }, React.createElement(component)),
      );
      await new Promise((r) => setTimeout(r, 30));
    });
    return {
      host,
      async close() {
        await React.act(async () => root.unmount());
        client.clear();
        host.remove();
      },
    };
  }
  for (const role of ["owner", "manager", "staff"]) {
    globalThis.analyticsFixture.role = role;
    const nav = await mount(AppLayout);
    assert.equal(nav.host.querySelector('a[href="/analytics"]') !== null, role !== "staff");
    await nav.close();
  }
  for (const role of ["owner", "manager"]) {
    globalThis.analyticsFixture.role = role;
    const view = await mount();
    await React.act(async () => await new Promise((r) => setTimeout(r, 40)));
    assert.match(view.host.textContent, /Total calls/);
    assert.match(view.host.textContent, /Dr Example/);
    assert.match(view.host.textContent, /Consultation/);
    const select = view.host.querySelector("select");
    await React.act(async () => {
      select.value = "7";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
    });
    assert.equal(
      (Date.parse(requests.at(-1).args.p_end_date) -
        Date.parse(requests.at(-1).args.p_start_date)) /
        86400000,
      6,
    );
    await view.close();
  }
  const count = requests.length;
  globalThis.analyticsFixture.role = "staff";
  let view = await mount();
  assert.match(view.host.textContent, /isn’t available/);
  assert.equal(requests.length, count);
  await view.close();
  globalThis.analyticsFixture.role = "owner";
  globalThis.analyticsFixture.mode = "error";
  view = await mount();
  await React.act(async () => await new Promise((r) => setTimeout(r, 40)));
  assert.match(view.host.textContent, /Could not load analytics/);
  assert.ok(view.host.querySelector('[role="alert"]'));
  assert.doesNotMatch(view.host.textContent, /SQL_INTERNAL_SECRET_SENTINEL/);
  globalThis.analyticsFixture.mode = "success";
  await React.act(async () => {
    view.host.querySelector("button").click();
    await new Promise((r) => setTimeout(r, 40));
  });
  assert.match(view.host.textContent, /Total calls/);
  await view.close();
  globalThis.analyticsFixture.mode = "loading";
  view = await mount();
  assert.match(view.host.textContent, /Loading analytics/);
  globalThis.analyticsFixture.mode = "success";
  await React.act(async () => {
    globalThis.analyticsFixture.release();
    await new Promise((r) => setTimeout(r, 40));
  });
  assert.match(view.host.textContent, /Total calls/);
  await view.close();
  globalThis.analyticsFixture.data = {
    ...data,
    totalCalls: 0,
    totalAppointments: 0,
    bookedAppointments: 0,
    cancelledAppointments: 0,
    practitioners: [],
    services: [],
  };
  view = await mount();
  await React.act(async () => await new Promise((r) => setTimeout(r, 40)));
  assert.match(view.host.textContent, /No calls or appointments/);
  await view.close();
  for (const timezone of [null, "", "Invalid/Zone"]) {
    globalThis.analyticsFixture.timezone = timezone;
    const before = requests.length;
    view = await mount();
    assert.match(view.host.textContent, /needs a valid clinic timezone/);
    assert.equal(requests.length, before);
    await view.close();
  }
  delete globalThis.analyticsFixture.timezone;
  globalThis.analyticsFixture.data = {
    ...data,
    services: [
      { label: "<img src=x onerror=alert(1)>", count: 1 },
      { label: null, count: 1 },
    ],
  };
  view = await mount();
  await React.act(async () => await new Promise((r) => setTimeout(r, 40)));
  assert.match(view.host.textContent, /<img src=x/);
  assert.match(view.host.textContent, /Unspecified/);
  assert.equal(view.host.querySelector("img"), null);
  await view.close();
  assert.ok(
    requests.every((r) => r.name === "clinic_analytics" && r.args.p_clinic_id === "clinic-a"),
  );
  console.log(
    "PASS analytics UI: Owner/Manager load, Staff no requests, date presets, timezone dates, loading/error/retry affordance, empty dashboard, breakdowns, aggregate-only RPC",
  );
} finally {
  await window.happyDOM.close();
  await rm(temp, { recursive: true, force: true });
}
