import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";
const temp = await mkdtemp(join(tmpdir(), "apero-integrations-ui-"));
const window = new Window({ url: "https://portal.example.test/account" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "ResizeObserver"])
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? window : window[name],
    configurable: true,
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fixture = {
  role: "owner",
  clinicId: "clinic-a",
  fail: false,
  delayKey: null,
  calls: [],
  data: { keys: [], connections: [], failed_jobs: 0 },
};
globalThis.integrationFixture = fixture;
const db = {
  async rpc(name, args) {
    fixture.calls.push({ name, args });
    if (fixture.fail) return { data: null, error: new Error("INTERNAL_SECRET_SENTINEL") };
    if (name === "integration_create_key") {
      if (fixture.delayKey) await fixture.delayKey;
      return { data: { key: "apero_SYNTHETIC_SINGLE_USE" }, error: null };
    }
    return { data: structuredClone(fixture.data), error: null };
  },
  from(name) {
    assert.equal(name, "staff");
    const query = {
      select() {
        return query;
      },
      eq() {
        return query;
      },
      then(resolve) {
        return Promise.resolve({
          data: [{ id: "staff-a", full_name: "Dr Synthetic" }],
          error: null,
        }).then(resolve);
      },
    };
    return query;
  },
  functions: {
    async invoke(path, { body }) {
      fixture.calls.push({ name: path, args: body });
      if (path.endsWith("/oauth/start")) {
        if (fixture.oauthGate) await fixture.oauthGate;
        return {
          data: {
            url: "https://accounts.google.com/o/oauth2/v2/auth?state=" + "a".repeat(64),
            state: "a".repeat(64),
          },
          error: null,
        };
      }
      return fixture.fail
        ? { error: new Error("INTERNAL_SECRET_SENTINEL") }
        : {
            data: path.endsWith("/calendars")
              ? {
                  calendars: [
                    { id: "calendar-a", name: "Clinic Calendar", primary: false },
                    { id: "primary", name: "Primary account", primary: true },
                  ],
                }
              : { success: true },
            error: null,
          };
    },
  },
};
globalThis.integrationDb = db;
try {
  await build({
    entryPoints: ["src/components/integrations-panel.tsx"],
    outfile: join(temp, "panel.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    jsx: "automatic",
    define: { "import.meta.env": '{"VITE_APERO_INTEGRATIONS_ENABLED":"true"}' },
    plugins: [
      {
        name: "fixture",
        setup(b) {
          b.onResolve(
            { filter: /^@\/lib\/(auth|db)$|^@\/integrations\/supabase\/client$/ },
            (args) => ({ path: args.path, namespace: "fixture" }),
          );
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.endsWith("/auth")
              ? "export const useAuth=()=>globalThis.integrationFixture;"
              : args.path.endsWith("/db")
                ? "export const db=globalThis.integrationDb;"
                : "export const supabase=globalThis.integrationDb;",
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
  await writeFile(join(temp, "package.json"), ' {"type":"module"}');
  await symlink(
    join(process.cwd(), "node_modules"),
    join(temp, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const React = await import("react"),
    { createRoot } = await import("react-dom/client");
  const { IntegrationsPanel } = await import(pathToFileURL(join(temp, "panel.mjs")));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(IntegrationsPanel));
      await new Promise((r) => setTimeout(r, 15));
    });
  };
  const text = () => host.textContent;
  const click = async (label) => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
    assert.ok(button, label);
    await React.act(async () => {
      button.click();
      await new Promise((r) => setTimeout(r, 15));
    });
  };
  const fill = async (value) => {
    const input = host.querySelector("input:not([type=checkbox])");
    assert.ok(input);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        input,
        value,
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  fixture.role = "staff";
  await render();
  assert.equal(text(), "");
  assert.equal(fixture.calls.length, 0);
  fixture.role = "manager";
  await render();
  assert.equal(text(), "");
  fixture.role = "owner";
  await render();
  assert.match(text(), /Integrations/);
  assert.match(text(), /Clinic API keys/);
  // React detects input events through its own property tracker. Native setter above simulates real typing.
  await fill("Automation");
  assert.equal(
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Create API key").disabled,
    false,
  );
  const createdBefore = fixture.calls.filter((c) => c.name === "integration_create_key").length;
  await React.act(async () => {
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Create API key",
    );
    button.click();
    button.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  assert.equal(
    fixture.calls.filter((c) => c.name === "integration_create_key").length - createdBefore,
    1,
  );

  assert.match(text(), /apero_SYNTHETIC_SINGLE_USE/);
  await click("Hide key");
  assert.equal(text().includes("apero_SYNTHETIC_SINGLE_USE"), false);
  fixture.data = {
    keys: [
      {
        id: "k",
        name: "Automation",
        prefix: "apero_prefix",
        scopes: ["availability:read"],
        expires_at: "2027-01-01T00:00:00Z",
        revoked_at: null,
      },
    ],
    connections: [
      {
        id: "c",
        calendar_id: null,
        status: "pending",
        staff_id: null,
        last_synced_at: null,
        last_error: null,
      },
    ],
    failed_jobs: 1,
  };
  await click("Refresh status");
  assert.match(text(), /need attention/);
  await click("Load writable calendars");
  assert.match(text(), /Clinic Calendar/);
  assert.match(text(), /Dr Synthetic/);
  const change = async (label, value) => {
    await React.act(async () => {
      const select = host.querySelector(`select[aria-label="${label}"]`);
      select.value = value;
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  await change("Calendar", "primary");
  assert.match(text(), /primary calendar/);
  await change("Calendar", "calendar-a");
  await change("Practitioner", "staff-a");
  await click("Use calendar");
  assert.ok(
    fixture.calls.some(
      (c) =>
        c.name.endsWith("/select") &&
        c.args.calendar_id === "calendar-a" &&
        c.args.staff_id === "staff-a",
    ),
  );
  fixture.data.connections = [
    {
      id: "active",
      calendar_id: "calendar-a",
      calendar_name: "Clinic Calendar",
      google_account_id: "owner@synthetic.test",
      practitioner_name: "Dr Synthetic",
      staff_id: "staff-a",
      status: "connected",
      last_synced_at: new Date().toISOString(),
      sync_state: "current",
    },
    {
      id: "historical",
      calendar_id: "old",
      status: "disconnected",
      staff_id: null,
      last_synced_at: null,
    },
  ];
  await click("Refresh status");
  assert.match(text(), /Google account: owner@synthetic.test/);
  assert.match(text(), /Practitioner: Dr Synthetic/);
  assert.match(text(), /Historical connection/);
  await click("Rotate key");
  assert.match(text(), /previous key is revoked/);
  await click("Revoke key");
  assert.equal(text().includes("apero_SYNTHETIC_SINGLE_USE"), false);
  fixture.fail = true;
  await click("Refresh status");
  assert.ok(host.querySelector("[role=alert]"));
  assert.equal(text().includes("INTERNAL_SECRET_SENTINEL"), false);
  fixture.fail = false;
  let release;
  fixture.delayKey = new Promise((r) => {
    release = r;
  });
  await React.act(async () => {
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Rotate key").click();
    await new Promise((r) => setTimeout(r, 5));
  });
  fixture.clinicId = "clinic-b";
  fixture.data = { keys: [], connections: [], failed_jobs: 0 };
  await render();
  await React.act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 15));
  });
  assert.equal(text().includes("apero_SYNTHETIC_SINGLE_USE"), false);
  let releaseOauth;
  fixture.oauthGate = new Promise((r) => {
    releaseOauth = r;
  });
  const assigned = [];
  const originalAssign = window.location.assign;
  window.location.assign = (url) => assigned.push(url);
  const startsBefore = fixture.calls.filter((c) => c.name.endsWith("/oauth/start")).length;
  await React.act(async () => {
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Connect Google Calendar",
    );
    button.click();
    button.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  assert.equal(
    fixture.calls.filter((c) => c.name.endsWith("/oauth/start")).length - startsBefore,
    1,
  );
  await React.act(async () => {
    releaseOauth();
    await new Promise((r) => setTimeout(r, 5));
  });
  assert.equal(assigned.length, 1);
  assert.equal(
    window.sessionStorage.getItem("apero-google-state:" + fixture.clinicId),
    "a".repeat(64),
  );
  window.location.assign = originalAssign;
  fixture.clinicId = "clinic-denied";
  window.history.replaceState(null, "", "/account?integration_error=oauth_denied");
  await render();
  assert.match(text(), /authorization was not completed/);
  assert.equal(
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Connect Google Calendar")
      .disabled,
    false,
  );
  fixture.role = "staff";
  await render();
  assert.equal(text(), "");
  await React.act(async () => root.unmount());
  console.log(
    "PASS integrations UI: role isolation, keys, selection, errors, clinic-switch race and responsive controls",
  );
} finally {
  await window.happyDOM.close();
  await rm(temp, { recursive: true, force: true });
}
