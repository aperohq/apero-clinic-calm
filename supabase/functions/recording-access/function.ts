import { createClient } from "@supabase/supabase-js";
import { invitationRedirect } from "../_shared/clinic-users.ts";
import { readLimitedBody } from "../_shared/request-security.ts";

// User-scoped reads retain RLS. The admin client only reads the private
// integration mapping; it never reads a conversation on behalf of the caller.
export function createRecordingAccessFunction(
  getEnv: (name: string) => string | undefined,
  fetcher: typeof fetch = fetch,
) {
  return async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      vary: "Origin",
    };
    const json = (status: number, code: string) => Response.json({ code }, { status, headers });
    let origin: string;
    try {
      origin = new URL(invitationRedirect(getEnv("APERO_PORTAL_ORIGIN") ?? "")).origin;
    } catch {
      return json(503, "unavailable");
    }
    if (req.headers.get("origin") === origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] =
        "authorization, apikey, content-type, x-client-info";
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    } else if (req.headers.has("origin")) return json(403, "not_authorized");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return json(405, "method_not_allowed");
    const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return json(401, "not_authorized");
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return json(415, "invalid_input");
    const url = getEnv("SUPABASE_URL");
    const publicKey = getEnv("SUPABASE_ANON_KEY");
    const serverKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !publicKey || !serverKey) return json(503, "unavailable");
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(15000)]);
    const transport: typeof fetch = (input, init) =>
      fetcher(input, {
        ...init,
        signal,
        redirect: "error",
        cache: "no-store",
      });
    const options = {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: transport },
    };
    const user = createClient(url, publicKey, {
      ...options,
      global: { ...options.global, headers: { Authorization: `Bearer ${token}` } },
    });
    const admin = createClient(url, serverKey, options);
    try {
      const identity = await user.auth.getUser(token);
      if (identity.error || !identity.data.user) return json(401, "not_authorized");
      let conversationId: string;
      try {
        const input = JSON.parse(await readLimitedBody(req, 1024, signal));
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length !== 1 ||
          typeof input.conversationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            input.conversationId,
          )
        )
          return json(400, "invalid_input");
        conversationId = input.conversationId;
      } catch {
        return json(400, "invalid_input");
      }
      const membership = await user
        .from("profiles")
        .select("clinic_id,role,revoked_at")
        .eq("auth_user_id", identity.data.user.id)
        .maybeSingle();
      if (membership.error) return json(503, "unavailable");
      const actor = membership.data;
      // Matches today's conversation SELECT policy; RLS also enforces any
      // narrower conversation policy introduced later.
      if (
        !actor?.clinic_id ||
        actor.revoked_at ||
        !["owner", "manager", "staff"].includes(actor.role)
      )
        return json(403, "not_authorized");
      const result = await user
        .from("conversations")
        .select("id,clinic_id,retell_call_id,retell_agent_id")
        .eq("id", conversationId)
        .eq("clinic_id", actor.clinic_id)
        .maybeSingle();
      if (result.error) return json(503, "unavailable");
      const conversation = result.data;
      // Missing and foreign conversations have the same response.
      if (
        !conversation ||
        conversation.clinic_id !== actor.clinic_id ||
        !conversation.retell_agent_id ||
        typeof conversation.retell_call_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(conversation.retell_call_id)
      )
        return json(404, "recording_unavailable");
      const mapping = await admin
        .from("voice_integrations")
        .select("agent_id,secret_env_name")
        .eq("clinic_id", actor.clinic_id)
        .eq("agent_id", conversation.retell_agent_id)
        .eq("active", true)
        .maybeSingle();
      if (mapping.error) return json(503, "unavailable");
      if (!mapping.data || !/^RETELL_[A-Z0-9_]+$/.test(mapping.data.secret_env_name))
        return json(404, "recording_unavailable");
      const key = getEnv(mapping.data.secret_env_name);
      if (!key) return json(503, "unavailable");
      const response = await transport(
        `https://api.retellai.com/v2/get-call/${encodeURIComponent(conversation.retell_call_id)}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      if (response.status === 404) return json(404, "recording_unavailable");
      if (!response.ok) return json(502, "unavailable");
      const call = await response.json();
      if (call.call_id !== conversation.retell_call_id || call.agent_id !== mapping.data.agent_id)
        return json(404, "recording_unavailable");
      // Retell regenerates signed links on Get Call. Never fall back to an old
      // DB URL or return an unsigned legacy recording, even to a valid user.
      if (call.opt_in_signed_url !== true || typeof call.recording_url !== "string")
        return json(404, "recording_unavailable");
      let playback: URL;
      try {
        playback = new URL(call.recording_url);
      } catch {
        return json(404, "recording_unavailable");
      }
      if (
        playback.protocol !== "https:" ||
        playback.username ||
        playback.password ||
        !playback.search
      )
        return json(404, "recording_unavailable");
      // Recheck the RLS-protected record after the provider request so a
      // revocation/demotion during that request cannot issue playback access.
      const stillAllowed = await user
        .from("conversations")
        .select("id")
        .eq("id", conversation.id)
        .eq("clinic_id", actor.clinic_id)
        .maybeSingle();
      if (stillAllowed.error) return json(503, "unavailable");
      if (!stillAllowed.data) return json(404, "recording_unavailable");
      return Response.json({ url: playback.href }, { headers });
    } catch {
      return json(503, "unavailable");
    } finally {
      await user.auth.dispose();
      await admin.auth.dispose();
    }
  };
}
