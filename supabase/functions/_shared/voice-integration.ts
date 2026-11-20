import { Retell } from "npm:retell-sdk";
import {
  hasDuplicateWorkspaceSecret,
  resolveTrustedIdentity,
  type VoiceIntegration,
} from "./voice-routing.ts";

export type { VoiceIntegration };

// The claimed agent is only a lookup hint. It becomes trusted after its workspace
// key verifies the exact raw body. No caller-provided clinic_id is used.
export async function resolveVoiceIntegration(
  // The Supabase Admin client is supplied by the Edge runtime and is untyped here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  raw: string,
  signature: string | null,
  timing?: (
    phase: "integration_lookup" | "signature_verification" | "duplicate_secret_check",
    elapsedMs: number,
    category: "success" | "failure",
  ) => void,
): Promise<{ integration: VoiceIntegration; secret: string } | null> {
  const identity = await resolveTrustedIdentity(
    raw,
    signature,
    async (agentId) => {
      const { data, error } = await db
        .from("voice_integrations")
        .select(
          "clinic_id,agent_id,workspace_id,secret_env_name,active,dialing_prefix,local_number_length,slot_minutes",
        )
        .eq("agent_id", agentId)
        .eq("active", true)
        .maybeSingle();
      return error ? null : data;
    },
    (name) => Deno.env.get(name),
    (body, key, sig) => Retell.verify(body, key, sig),
    timing,
  );
  if (!identity) return null;
  const began = performance.now();
  let active;
  let error;
  try {
    ({ data: active, error } = await db
      .from("voice_integrations")
      .select("clinic_id,agent_id,workspace_id,secret_env_name,active")
      .eq("active", true));
  } catch (caught) {
    timing?.("duplicate_secret_check", performance.now() - began, "failure");
    throw caught;
  }
  const valid =
    !error &&
    !!active &&
    !hasDuplicateWorkspaceSecret(identity.integration, active, (name) => Deno.env.get(name));
  timing?.("duplicate_secret_check", performance.now() - began, valid ? "success" : "failure");
  return valid ? identity : null;
}
