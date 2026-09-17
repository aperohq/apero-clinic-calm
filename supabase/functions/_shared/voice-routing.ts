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
): Promise<{ integration: VoiceIntegration; secret: string } | null> {
  let agentId: unknown;
  try {
    agentId = JSON.parse(raw)?.call?.agent_id;
  } catch {
    return null;
  }
  if (typeof agentId !== "string" || !agentId || !signature) return null;
  const integration = await lookup(agentId);
  if (
    !integration?.active ||
    integration.agent_id !== agentId ||
    !/^RETELL_[A-Z0-9_]+$/.test(integration.secret_env_name)
  )
    return null;
  const secret = secretFor(integration.secret_env_name);
  if (!secret || !(await verify(raw, secret, signature))) return null;
  return { integration, secret };
}
