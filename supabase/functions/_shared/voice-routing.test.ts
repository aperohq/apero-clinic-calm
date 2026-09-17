import assert from "node:assert/strict";
import test from "node:test";
import {
  hasDuplicateWorkspaceSecret,
  resolveTrustedIdentity,
  type VoiceIntegration,
} from "./voice-routing.ts";

const a: VoiceIntegration = {
  clinic_id: "clinic-a",
  agent_id: "agent-a",
  workspace_id: "workspace-a",
  secret_env_name: "RETELL_A",
  active: true,
};
const b: VoiceIntegration = {
  clinic_id: "clinic-b",
  agent_id: "agent-b",
  workspace_id: "workspace-b",
  secret_env_name: "RETELL_B",
  active: true,
};
const integrations = new Map([
  [a.agent_id, a],
  [b.agent_id, b],
]);
const lookup = async (id: string) => integrations.get(id) ?? null;
const secrets: Record<string, string> = { RETELL_A: "key-a", RETELL_B: "key-b" };
const verify = async (_raw: string, key: string, signature: string) => key === signature;
const resolve = (agentId: string, signature: string) =>
  resolveTrustedIdentity(
    JSON.stringify({ call: { agent_id: agentId }, clinic_id: "clinic-a" }),
    signature,
    lookup,
    (name) => secrets[name],
    verify,
  );

test("verified agent routes to its own clinic and ignores claimed clinic_id", async () => {
  assert.equal((await resolve("agent-b", "key-b"))?.integration.clinic_id, "clinic-b");
  assert.equal((await resolve("agent-a", "key-a"))?.integration.clinic_id, "clinic-a");
});
test("unknown, unsigned and cross-workspace requests are rejected", async () => {
  assert.equal(await resolve("unknown", "key-a"), null);
  assert.equal(await resolve("agent-b", "key-a"), null);
  assert.equal(await resolve("agent-b", ""), null);
});
test("inactive or missing secret fails closed", async () => {
  integrations.set("agent-b", { ...b, active: false });
  assert.equal(await resolve("agent-b", "key-b"), null);
  integrations.set("agent-b", b);
  delete secrets.RETELL_B;
  assert.equal(await resolve("agent-b", "key-b"), null);
});
test("duplicate actual workspace keys fail even under different environment names", () => {
  assert.equal(
    hasDuplicateWorkspaceSecret(a, [a, b], (name) => secrets[name]),
    false,
  );
  const reused = { ...secrets, RETELL_B: "key-a" };
  assert.equal(
    hasDuplicateWorkspaceSecret(a, [a, b], (name) => reused[name]),
    true,
  );
  assert.equal(
    hasDuplicateWorkspaceSecret(
      a,
      [a, { ...b, workspace_id: a.workspace_id }],
      (name) => secrets[name],
    ),
    true,
  );
});
