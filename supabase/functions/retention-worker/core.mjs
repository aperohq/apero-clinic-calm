// Injectable provider worker. No payload, content, URL, key or target ID is logged.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function fingerprint(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function rpc(db, name, args) {
  const r = await db.rpc(name, args);
  if (r.error) throw new Error("database_error");
  return r.data;
}
export async function processProviderJob(db, env, clinicId, job, transport = fetch) {
  if (job.clinic_id !== clinicId || !UUID.test(job.id) || !UUID.test(job.lease_token))
    return { success: false, failure: "configuration_error" };
  try {
    if (job.provider === "retell") {
      if (
        !/^call_[A-Za-z0-9_-]{1,120}$/.test(job.target_key) ||
        !/^agent_[A-Za-z0-9_-]+$/.test(job.agent_id ?? "")
      )
        throw new Error("configuration_error");
      const mapping = await db
        .from("voice_integrations")
        .select("clinic_id,agent_id,secret_env_name")
        .eq("agent_id", job.agent_id);
      if (mapping.error) throw new Error("database_error");
      if (mapping.data?.length !== 1 || mapping.data[0].clinic_id !== clinicId)
        throw new Error("configuration_error");
      const name = mapping.data[0].secret_env_name;
      if (!/^RETELL_[A-Z0-9_]+$/.test(name ?? "")) throw new Error("configuration_error");
      const key = env(name);
      if (!key) throw new Error("configuration_error");
      const keyHash = await fingerprint(key);
      const request = async (method) =>
        transport(
          "https://api.retellai.com/v2/" +
            (method === "GET" ? "get-call/" : "delete-call/") +
            encodeURIComponent(job.target_key),
          {
            method,
            headers: { Authorization: "Bearer " + key },
            signal: AbortSignal.timeout(15000),
            redirect: "error",
            cache: "no-store",
          },
        );
      const before = await request("GET");
      // First 404 may mean wrong workspace. Never label it a successful deletion.
      if (
        before.status === 404 &&
        job.ownership_verified_at &&
        job.verified_key_fingerprint === keyHash
      )
        return { success: true };
      if (before.status === 404) {
        // Native Retell expiry may run first. Verify workspace access via this
        // tenant's exclusively mapped agent before treating the call as absent.
        const agent = await transport(
          "https://api.retellai.com/get-agent/" + encodeURIComponent(job.agent_id),
          {
            method: "GET",
            headers: { Authorization: "Bearer " + key },
            signal: AbortSignal.timeout(15000),
            redirect: "error",
            cache: "no-store",
          },
        );
        if (agent.status !== 200 || (await agent.json()).agent_id !== job.agent_id)
          throw new Error("configuration_error");
        return { success: true, already_absent: true };
      }
      if (before.status !== 200) throw new Error("provider_error");
      const call = await before.json();
      if (
        call.call_id !== job.target_key ||
        call.agent_id !== job.agent_id ||
        !["ended", "error"].includes(call.call_status)
      )
        throw new Error("configuration_error");
      const verified = await rpc(db, "retention_verify_provider", {
        p_clinic: clinicId,
        p_job: job.id,
        p_lease: job.lease_token,
        p_fingerprint: keyHash,
      });
      if (verified !== true) throw new Error("database_error");
      const deleted = await request("DELETE");
      if (deleted.status !== 204) throw new Error("provider_error");
      const after = await request("GET");
      if (after.status !== 404) throw new Error("provider_error");
      return { success: true };
    }
    if (job.provider === "supabase_auth") {
      if (!UUID.test(job.target_key)) throw new Error("configuration_error");
      const member = await db
        .from("profiles")
        .select("clinic_id,revoked_at")
        .eq("auth_user_id", job.target_key)
        .maybeSingle();
      if (member.error) throw new Error("database_error");
      const keyHash = await fingerprint(env("SUPABASE_SERVICE_ROLE_KEY") ?? "");
      const user = await db.auth.admin.getUserById(job.target_key);
      if (
        user.error?.status === 404 &&
        job.ownership_verified_at &&
        job.verified_key_fingerprint === keyHash
      )
        return { success: true };
      if (
        !member.data ||
        member.data.clinic_id !== clinicId ||
        !member.data.revoked_at ||
        user.error
      )
        throw new Error("configuration_error");
      if (
        (await rpc(db, "retention_verify_provider", {
          p_clinic: clinicId,
          p_job: job.id,
          p_lease: job.lease_token,
          p_fingerprint: keyHash,
        })) !== true
      )
        throw new Error("database_error");
      const deleted = await db.auth.admin.deleteUser(job.target_key, false);
      if (deleted.error) throw new Error("provider_error");
      const after = await db.auth.admin.getUserById(job.target_key);
      if (after.error?.status !== 404) throw new Error("provider_error");
      return { success: true };
    }
    throw new Error("configuration_error");
  } catch (error) {
    const failure = ["database_error", "configuration_error"].includes(error?.message)
      ? error.message
      : "provider_error";
    return { success: false, failure };
  }
}
export async function runProviderBatch(db, env, clinicId, transport = fetch) {
  if (!UUID.test(clinicId)) throw new Error("configuration_error");
  const control = await db
    .from("retention_control")
    .select("mode,approved_at")
    .eq("singleton", true)
    .single();
  if (control.error) throw new Error("database_error");
  if (control.data?.mode !== "enabled" || !control.data.approved_at)
    return { mode: "dry_run", processed: 0, succeeded: 0, failed: 0 };
  const jobs = await rpc(db, "retention_claim", { p_clinic: clinicId, p_batch: 2 });
  const counts = { mode: "enabled", processed: 0, succeeded: 0, failed: 0 };
  for (const job of jobs ?? []) {
    // Recheck gate between requests; pause prevents remaining external operations.
    const gate = await db
      .from("retention_control")
      .select("mode,approved_at")
      .eq("singleton", true)
      .single();
    const clinic = await db
      .from("clinic_retention")
      .select("paused,legal_hold")
      .eq("clinic_id", clinicId)
      .maybeSingle();
    if (
      gate.error ||
      clinic.error ||
      gate.data?.mode !== "enabled" ||
      !gate.data.approved_at ||
      clinic.data?.paused ||
      clinic.data?.legal_hold
    )
      break;
    const result = await processProviderJob(db, env, clinicId, job, transport);
    counts.processed++;
    try {
      const saved = await rpc(db, "retention_finish", {
        p_clinic: clinicId,
        p_job: job.id,
        p_lease: job.lease_token,
        p_success: result.success,
        p_failure: result.failure ?? "provider_error",
      });
      if (saved === true && result.success) counts.succeeded++;
      else counts.failed++;
    } catch {
      counts.failed++;
    } // Lease expiry makes a failed acknowledgement recoverable.
  }
  return counts;
}
