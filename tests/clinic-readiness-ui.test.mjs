import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

const directory = await mkdtemp(join(tmpdir(), "apero-readiness-ui-"));
const window = new Window({ url: "http://localhost/account" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node"])
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? window : window[name],
    configurable: true,
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const clinicId = "00000000-0000-4000-8000-000000000100";
const valid = {
  clinic_id: clinicId,
  state: "technically_activation_ready",
  configuration_complete: true,
  failures: [],
  consent_revision: "approved-1",
  activated_at: null,
  external_dependencies: [
    { name: "Retell and live telephone readiness", status: "EXTERNAL / UNKNOWN" },
  ],
};
let requests = 0;
globalThis.readinessFixture = {
  auth: { role: "staff", clinicId, profile: { id: "profile", revoked_at: null } },
  rpc: async (name, args) => {
    requests++;
    assert.equal(name, "clinic_activation_readiness");
    assert.deepEqual(args, { p_clinic_id: clinicId });
    return { data: valid, error: null };
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Network is forbidden in readiness tests");
};
try {
  await build({
    stdin: {
      contents:
        'export { ClinicReadinessPanel } from "./src/components/clinic-readiness-panel"; export {loadClinicReadiness} from "./src/lib/clinic-readiness";',
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    outfile: join(directory, "readiness.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    jsx: "automatic",
    plugins: [
      {
        name: "readiness-fixtures",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/(auth|db)$/ }, (args) => ({
            path: args.path,
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.endsWith("auth")
              ? "export const useAuth=()=>globalThis.readinessFixture.auth;"
              : "export const db={rpc:(...args)=>globalThis.readinessFixture.rpc(...args)};",
          }));
        },
      },
    ],
  });
  await symlink(
    join(process.cwd(), "node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { ClinicReadinessPanel, loadClinicReadiness } = await import(
    pathToFileURL(join(directory, "readiness.mjs"))
  );
  assert.deepEqual(await loadClinicReadiness(clinicId), valid);
  const defaultRpc = globalThis.readinessFixture.rpc;
  for (const data of [
    null,
    { ...valid, clinic_id: "00000000-0000-4000-8000-000000000200" },
    { ...valid, failures: ["Missing hours"] },
    { ...valid, state: "activated" },
    { ...valid, state: "unexpected" },
  ]) {
    globalThis.readinessFixture.rpc = async () => ({ data, error: null });
    await assert.rejects(loadClinicReadiness(clinicId), /could not be verified/);
  }
  globalThis.readinessFixture.rpc = async () => ({
    data: valid,
    error: { message: "PRIVATE_DATABASE_DIAGNOSTIC" },
  });
  await assert.rejects(loadClinicReadiness(clinicId), /could not be verified/);
  globalThis.readinessFixture.rpc = defaultRpc;
  requests = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = () =>
    React.act(async () =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(ClinicReadinessPanel),
        ),
      ),
    );
  for (const role of ["staff", "manager"]) {
    globalThis.readinessFixture.auth.role = role;
    await render();
    assert.equal(container.textContent, "");
    assert.equal(requests, 0);
  }
  globalThis.readinessFixture.auth.role = "owner";
  let resolveRequest;
  globalThis.readinessFixture.rpc = async () => {
    requests++;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  };
  await render();
  assert.match(container.textContent, /Checking clinic configuration/);
  assert.ok(!container.textContent.includes("Technically activation-ready"));
  await React.act(async () => {
    resolveRequest({ data: valid, error: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.textContent, /Technically activation-ready/);
  assert.match(container.textContent, /EXTERNAL \/ UNKNOWN/);
  assert.match(container.textContent, /separate authorized release decision/);
  assert.ok(
    ![...container.querySelectorAll("button")].some((button) =>
      /activate/i.test(button.textContent),
    ),
  );
  for (const width of [375, 768, 1440]) {
    window.innerWidth = width;
    await render();
    assert.match(container.textContent, /Clinic activation readiness/);
    assert.ok(container.querySelector(".flex-wrap"));
  }
  globalThis.readinessFixture.rpc = async () => ({
    data: null,
    error: { message: "PRIVATE_DATABASE_DIAGNOSTIC" },
  });
  await React.act(async () => {
    await client.refetchQueries();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.querySelector('[role="alert"]').textContent, /could not be verified/);
  assert.ok(!container.textContent.includes("Technically activation-ready"));
  assert.ok(!container.textContent.includes("PRIVATE_DATABASE_DIAGNOSTIC"));
  globalThis.readinessFixture.rpc = async () => ({
    data: {
      ...valid,
      state: "onboarding_incomplete",
      configuration_complete: false,
      failures: ["Configure ساعات العمل"],
    },
    error: null,
  });
  await React.act(async () => {
    container.querySelector("button").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.textContent, /Onboarding incomplete/);
  assert.match(container.textContent, /Configure ساعات العمل/);
  globalThis.readinessFixture.rpc = async () => ({
    data: {
      ...valid,
      state: "activated",
      activated_at: "2026-11-24T00:00:00Z",
      configuration_complete: false,
      failures: ["Restore missing practitioner configuration"],
    },
    error: null,
  });
  await React.act(async () => {
    await client.refetchQueries();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.match(container.textContent, /Activated/);
  assert.match(container.textContent, /Restore missing practitioner configuration/);
  assert.equal(container.querySelector('[role="alert"]'), null);
  globalThis.readinessFixture.auth.profile.revoked_at = "2026-11-24";
  await render();
  assert.equal(container.textContent, "");
  await React.act(async () => root.unmount());
  client.clear();
  console.log(
    "PASS readiness RPC contract, error/loading/retry states, owner-only access, revocation, external dependencies, Unicode and responsive DOM structure (375/768/1440)",
  );
} finally {
  globalThis.fetch = originalFetch;
  await window.happyDOM.abort();
  await rm(directory, { recursive: true, force: true });
}
