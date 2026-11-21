// Offline, narrowly scoped transformation of the published flow.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const AGENT_ID = "agent_b84b2766efeb85afc809147d7a";
export function build(baseline) {
  const flow = structuredClone(baseline);
  const tool = flow.tools.find((t) => t.name === "book_appointment");
  if (!tool) throw Error("Missing book_appointment");
  // Suppress Retell's automatic full call/transcript/dynamic-variable envelope.
  // Keep only the signed identity hints required by resolveTrustedIdentity and
  // checkCallOwnership. Clinic identity still comes from voice_integrations.
  tool.args_at_root = true;
  tool.parameters.additionalProperties = false;
  tool.parameters.properties.call = {
    type: "object",
    additionalProperties: false,
    properties: {
      agent_id: { type: "string", const: AGENT_ID },
      call_id: { type: "string", const: "{{call_id}}" },
    },
    required: ["agent_id", "call_id"],
  };
  if (!tool.parameters.required.includes("call")) tool.parameters.required.push("call");
  return flow;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("./", import.meta.url);
  const baseline = JSON.parse(fs.readFileSync(new URL("baseline-v22.json", root)));
  const candidate = build(baseline);
  fs.writeFileSync(new URL("candidate.json", root), JSON.stringify(candidate, null, 2) + "\n");
  // PATCH only tools: no nodes, edges, prompts, defaults or other agent settings.
  fs.writeFileSync(
    new URL("tools.patch.json", root),
    JSON.stringify({ tools: candidate.tools }, null, 2) + "\n",
  );
}
