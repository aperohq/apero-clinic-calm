// Actual built frontend and Edge handler recovery; localhost/synthetic input only.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { build } from "esbuild";

const root = await mkdtemp(join(tmpdir(), "apero-runtime-recovery-"));
const nativeFetch = globalThis.fetch;
let externalAttempts = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") {
    externalAttempts++;
    throw new Error("External transport denied in recovery rehearsal");
  }
  return nativeFetch(input, init);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let serving = async () => new Response("Isolated recovery unavailable", { status: 503 });
const server = createServer(async (request, response) => {
  try {
    const result = await serving(new Request(`http://127.0.0.1${request.url}`));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(503);
    response.end("Isolated recovery unavailable");
  }
});
const results = [];
try {
  await cp(".output", join(root, "release"), { recursive: true });
  const entry = join(root, "release/server/index.mjs");
  const baseline = await readFile(entry);
  await writeFile(entry, "throw new Error('Synthetic damaged frontend entry');\n");
  await assert.rejects(import(pathToFileURL(entry).href + "?damaged"), /Synthetic damaged/);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + "/login")).status, 503);
  await writeFile(entry, baseline);
  assert.equal(sha(await readFile(entry)), sha(baseline));
  const worker = (await import(pathToFileURL(entry).href + "?restored")).default;
  const publicRoot = resolve(root, "release/public");
  const context = { waitUntil() {}, passThroughOnException() {} };
  const environment = {
    ASSETS: {
      async fetch(request) {
        const file = resolve(publicRoot, "." + new URL(request.url).pathname);
        if (!file.startsWith(publicRoot + sep)) return new Response(null, { status: 403 });
        try {
          return new Response(await readFile(file), {
            headers: {
              "content-type": file.endsWith(".css") ? "text/css" : "application/javascript",
            },
          });
        } catch {
          return new Response(null, { status: 404 });
        }
      },
    },
  };
  serving = (request) => worker.fetch(request, environment, context);
  const routes = [];
  for (const path of ["/login", "/home", "/account", "/calendar"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /<!DOCTYPE html>/i);
    assert.match(html, /assets\/styles-/);
    if (path === "/login") assert.match(html, /sign in|log in|welcome back/i);
    routes.push({ path, status: response.status, html: true });
    const stylesheet = html.match(/href="([^\"]+\.css)"/)[1];
    const asset = await fetch(new URL(stylesheet, origin));
    assert.equal(asset.status, 200);
    assert.ok((await asset.text()).length > 1000);
  }
  results.push({
    scenario: "REC-FRONTEND-RUNTIME-01",
    status: "PASS",
    broken_http: 503,
    restored_routes: routes,
    compiled_stylesheet_served: true,
    scope:
      "actual built Cloudflare fetch handler served through localhost HTTP; no hosted deployment",
  });
  for (const [name, factory, requestPath] of [
    ["integration-api", "createIntegrationApi", "/manage/oauth/start"],
    ["integration-worker", "createIntegrationWorker", ""],
  ]) {
    const artifact = join(root, name + ".mjs");
    await build({
      entryPoints: [`supabase/functions/${name}/function.ts`],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: artifact,
      logLevel: "silent",
    });
    const saved = await readFile(artifact);
    await writeFile(artifact, "throw new Error('Synthetic damaged Edge bundle');\n");
    await assert.rejects(import(pathToFileURL(artifact).href + "?damaged"), /Synthetic damaged/);
    await writeFile(artifact, saved);
    assert.equal(sha(await readFile(artifact)), sha(saved));
    const module = await import(pathToFileURL(artifact).href + "?restored");
    const settings = {
      INTEGRATIONS_ENABLED: "true",
      INTEGRATION_WORKER_SECRET: "a".repeat(64),
      APERO_PORTAL_ORIGIN: "https://portal.example.test",
    };
    let network = 0;
    const denyNetwork = async () => {
      network++;
      throw new Error("Network disabled");
    };
    const handler = module[factory]((key) => settings[key], denyNetwork);
    const response = await handler(
      new Request(`https://example.test/functions/v1/${name}${requestPath}`, { method: "POST" }),
    );
    assert.equal(response.status, 401, name);
    assert.equal(network, 0);
    results.push({
      scenario: `REC-EDGE-RUNTIME-${name}`,
      status: "PASS",
      damaged_module_failed: true,
      restored_unauthenticated_status: response.status,
      transport_calls: network,
      scope:
        "actual bundled handler factory with synthetic settings; not hosted Deno control plane",
    });
  }
  assert.equal(externalAttempts, 0);
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  globalThis.fetch = nativeFetch;
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      results,
      external_network_attempts: externalAttempts,
      production_modified: false,
      synthetic_cleanup_completed: true,
    },
    null,
    2,
  ),
);
