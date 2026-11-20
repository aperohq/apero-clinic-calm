import assert from "node:assert/strict";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";
const temp = await mkdtemp(join(tmpdir(), "apero-lifecycle-"));
const window = new Window({ url: "https://portal.example/account" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node"])
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? window : window[name],
    configurable: true,
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const profile = {
  id: "profile",
  auth_user_id: "user",
  clinic_id: "clinic",
  role: "owner",
  revoked_at: null,
  full_name: "Owner",
  phone: null,
  email: "owner@example.test",
};
let calls = 0;
const refresh = [];
globalThis.lifecycleFixture = {
  auth: {
    profile,
    session: { user: { id: "user" }, access_token: "one" },
    clinicId: "clinic",
    clinic: { name: "Clinic" },
    loading: false,
    authError: false,
    refreshProfile: async (background) => refresh.push(background),
  },
  demoRequest: async () => {
    calls++;
    return Response.json({ allowed: true });
  },
};
try {
  await build({
    stdin: {
      contents:
        'export {DemoAccess} from "./src/components/demo-access"; export {AccountPage} from "./src/components/clinic-pages";',
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    outfile: join(temp, "lifecycle.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    jsx: "automatic",
    plugins: [
      {
        name: "fixtures",
        setup(b) {
          b.onResolve(
            {
              filter:
                /^(@\/lib\/(auth|db)|@\/hooks\/use-retell-demo|@tanstack\/react-router|@\/components\/account-access-panel)$/,
            },
            (a) => ({ path: a.path, namespace: "fixture" }),
          );
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              a.path === "@/lib/auth"
                ? "export const useAuth=()=>globalThis.lifecycleFixture.auth;"
                : a.path === "@/hooks/use-retell-demo"
                  ? "export const demoRequest=(...args)=>globalThis.lifecycleFixture.demoRequest(...args);"
                  : a.path === "@/components/account-access-panel"
                    ? "export const AccountAccessPanel=()=>null;"
                    : a.path === "@tanstack/react-router"
                      ? 'import React from "react";export const useNavigate=()=>()=>{};export const Link=({children,...props})=>React.createElement("a",props,children);'
                      : "export const db={from(){let v;const q={update(values){v=values;globalThis.lifecycleFixture.saved=values;return q},select(){return q},eq(){return q},async single(){return {data:v??globalThis.lifecycleFixture.saved,error:null}}};return q}};",
          }));
        },
      },
    ],
  });
  await symlink(
    join(process.cwd(), "node_modules"),
    join(temp, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DemoAccess, AccountPage } = await import(pathToFileURL(join(temp, "lifecycle.mjs")));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounts = 0,
    unmounts = 0;
  function Call() {
    React.useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    return React.createElement("p", null, "Active demo call");
  }
  const demo = () =>
    React.act(async () =>
      root.render(React.createElement(DemoAccess, null, React.createElement(Call))),
    );
  await demo();
  assert.equal(mounts, 1);
  assert.equal(calls, 1);
  globalThis.lifecycleFixture.auth.session = { user: { id: "user" }, access_token: "refreshed" };
  await demo();
  assert.equal(mounts, 1);
  assert.equal(unmounts, 0);
  assert.equal(calls, 1);
  globalThis.lifecycleFixture.auth.profile = { ...profile, revoked_at: "2026-11-20" };
  await demo();
  assert.equal(unmounts, 1);
  assert.ok(!container.textContent.includes("Active demo call"));
  globalThis.lifecycleFixture.auth.profile = profile;
  await React.act(async () => root.render(React.createElement(AccountPage)));
  const password = container.querySelector("#new-password");
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(password, "UnsavedPassword1");
    password.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(container.querySelector("#new-password").value, "UnsavedPassword1");
  await React.act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "Save changes").click(),
  );
  assert.deepEqual(refresh, [true]);
  assert.equal(container.querySelector("#new-password"), password);
  assert.equal(password.value, "UnsavedPassword1");
  await React.act(async () => root.unmount());
  console.log(
    "PASS demo token refresh preserves active child; revocation unmounts; profile save preserves password form",
  );
} finally {
  await window.happyDOM.abort();
  await rm(temp, { recursive: true, force: true });
}
