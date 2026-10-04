import assert from "node:assert/strict";
import { mkdtemp, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

const temp = await mkdtemp(join(tmpdir(), "apero-recording-player-"));
const window = new Window({ url: "https://portal.example/conversations/example" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Node"])
  Object.defineProperty(globalThis, name, {
    value: name === "window" ? window : window[name],
    configurable: true,
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [];
globalThis.recordingFixture = {
  auth: { session: { user: { id: "user-a" } }, clinicId: "clinic-a", role: "owner" },
  requests,
  mode: "success",
};
try {
  await build({
    entryPoints: ["src/components/recording-player.tsx"],
    outfile: join(temp, "player.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    jsx: "automatic",
    plugins: [
      {
        name: "recording-fixture",
        setup(b) {
          b.onResolve({ filter: /^@\/lib\/(auth|db)$/ }, (a) => ({
            path: a.path,
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
            loader: "js",
            contents: a.path.endsWith("/auth")
              ? `export const useAuth=()=>globalThis.recordingFixture.auth;`
              : `export const db={functions:{async invoke(name,options){const f=globalThis.recordingFixture;f.requests.push({name,...options});if(f.mode==='pending')return await new Promise(resolve=>f.resolve=resolve);return f.mode==='error'?{data:null,error:new Error('PRIVATE_DIAGNOSTIC')}:{data:{url:'https://media.example/fresh.wav?signature=local'},error:null};}}};`,
          }));
        },
      },
    ],
  });
  await symlink(join(process.cwd(), "node_modules"), join(temp, "node_modules"));
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RecordingPlayer } = await import(pathToFileURL(join(temp, "player.mjs")));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (id) =>
    React.act(async () =>
      root.render(React.createElement(RecordingPlayer, { conversationId: id })),
    );
  const click = async () => React.act(async () => container.querySelector("button").click());
  await render("conversation-a");
  assert.equal(requests.length, 0, "no provider URL is loaded automatically or from cached rows");
  assert.equal(container.querySelector("audio"), null);
  await click();
  assert.equal(requests[0].name, "recording-access");
  assert.deepEqual(requests[0].body, { conversationId: "conversation-a" });
  assert.equal(
    container.querySelector("audio").getAttribute("src"),
    "https://media.example/fresh.wav?signature=local",
  );
  await render("conversation-b");
  assert.equal(
    container.querySelector("audio"),
    null,
    "changing conversation discards the previous credential",
  );
  globalThis.recordingFixture.mode = "pending";
  await click();
  assert.equal(container.querySelector("button").disabled, true);
  globalThis.recordingFixture.auth = {
    session: { user: { id: "user-b" } },
    clinicId: "clinic-b",
    role: "staff",
  };
  await render("conversation-b");
  assert.equal(requests[1].signal.aborted, true);
  await React.act(async () =>
    globalThis.recordingFixture.resolve({
      data: { url: "https://media.example/stale.wav?signature=old" },
      error: null,
    }),
  );
  assert.equal(container.querySelector("audio"), null, "a stale response cannot cross accounts");
  globalThis.recordingFixture.mode = "error";
  await click();
  assert.match(container.textContent, /Recording unavailable/);
  assert.ok(!container.textContent.includes("PRIVATE_DIAGNOSTIC"));
  globalThis.recordingFixture.mode = "success";
  await click();
  assert.ok(container.querySelector("audio"));
  globalThis.recordingFixture.auth = { session: null, clinicId: null, role: null };
  await render("conversation-b");
  assert.equal(container.querySelector("audio"), null);
  assert.equal(container.querySelector("button").disabled, true);
  await React.act(async () => root.unmount());
  const page = await readFile("src/components/clinic-pages.tsx", "utf8");
  assert.ok(page.includes("<RecordingPlayer conversationId={c.id} />"));
  assert.ok(!page.includes("c.recording_url"));
  console.log(
    "PASS recording player: authorized requests, playback, errors, account/conversation changes, stale responses, logout, no legacy URL fallback",
  );
} finally {
  await window.happyDOM.abort();
  await rm(temp, { recursive: true, force: true });
}
