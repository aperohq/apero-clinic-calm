export type VoiceIntegration = {
  clinic_id: string;
  agent_id: string;
  workspace_id: string;
  secret_env_name: string;
  active: boolean;
  dialing_prefix?: string;
  local_number_length?: number;
  slot_minutes?: number;
};

export type IdentityPhase = "integration_lookup" | "signature_verification";
export type IdentityTiming = (
  phase: IdentityPhase,
  elapsedMs: number,
  category: "success" | "failure",
) => void;

export function hasDuplicateWorkspaceSecret(
  integration: VoiceIntegration,
  others: VoiceIntegration[],
  secretFor: (name: string) => string | undefined,
): boolean {
  const secret = secretFor(integration.secret_env_name);
  if (!secret) return false;
  return others.some(
    (other) =>
      other.clinic_id !== integration.clinic_id &&
      other.active &&
      (other.workspace_id === integration.workspace_id ||
        other.secret_env_name === integration.secret_env_name ||
        secretFor(other.secret_env_name) === secret),
  );
}

export async function resolveTrustedIdentity(
  raw: string,
  signature: string | null,
  lookup: (agentId: string) => Promise<VoiceIntegration | null>,
  secretFor: (name: string) => string | undefined,
  verify: (raw: string, secret: string, signature: string) => Promise<boolean>,
  timing?: IdentityTiming,
): Promise<{ integration: VoiceIntegration; secret: string } | null> {
  let agentId: unknown;
  try {
    agentId = JSON.parse(raw)?.call?.agent_id;
  } catch {
    return null;
  }
  if (typeof agentId !== "string" || !agentId || !signature) return null;
  const lookupStart = performance.now();
  let integration: VoiceIntegration | null;
  try {
    integration = await lookup(agentId);
  } catch (error) {
    timing?.("integration_lookup", performance.now() - lookupStart, "failure");
    throw error;
  }
  timing?.(
    "integration_lookup",
    performance.now() - lookupStart,
    integration ? "success" : "failure",
  );
  if (
    !integration?.active ||
    integration.agent_id !== agentId ||
    !/^RETELL_[A-Z0-9_]+$/.test(integration.secret_env_name)
  )
    return null;
  const secret = secretFor(integration.secret_env_name);
  if (!secret) return null;
  const verifyStart = performance.now();
  let verified: boolean;
  try {
    verified = await verify(raw, secret, signature);
  } catch (error) {
    timing?.("signature_verification", performance.now() - verifyStart, "failure");
    throw error;
  }
  timing?.(
    "signature_verification",
    performance.now() - verifyStart,
    verified ? "success" : "failure",
  );
  if (!verified) return null;
  return { integration, secret };
}
