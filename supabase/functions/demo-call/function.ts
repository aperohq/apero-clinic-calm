// Server boundary. Never import this file into browser code.
const CLINIC_REFERENCE = "11111111-1111-4111-8111-111111111111";
const AGENT = "agent_b84b2766efeb85afc809147d7a";
const FLOW = "conversation_flow_43f53e5e8531";
const APPROVED_VERSION = 16;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
class Failure extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Failure(503, "unavailable");
  return value as Row;
}

export function createDemoCallFunction(
  env: (name: string) => string | undefined,
  fetcher: typeof fetch = fetch,
) {
  return async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      Vary: "Origin",
      "X-Content-Type-Options": "nosniff",
    };
    const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
    try {
      const configuredOrigin = env("APERO_PORTAL_ORIGIN");
      if (!configuredOrigin || new URL(configuredOrigin).origin !== configuredOrigin)
        throw new Failure(503, "unavailable");
      if (req.headers.get("origin") !== configuredOrigin) throw new Failure(403, "not_authorized");
      Object.assign(headers, {
        "Access-Control-Allow-Origin": configuredOrigin,
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (req.method !== "POST") throw new Failure(405, "method_not_allowed");
      const bearer = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
      if (!bearer) throw new Failure(401, "not_authorized");
      const base = env("SUPABASE_URL"),
        anon = env("SUPABASE_ANON_KEY"),
        admin = env("SUPABASE_SERVICE_ROLE_KEY");
      const clinic = env("APERO_DEMO_CLINIC_ID");
      // Required configuration is checked for every operation; only creation uses the enable switch.
      if (
        clinic !== CLINIC_REFERENCE ||
        env("APERO_DEMO_AGENT_VERSION") !== String(APPROVED_VERSION) ||
        !base ||
        !anon ||
        !admin
      )
        throw new Failure(503, "unavailable");
      const transport = (url: string, init: RequestInit = {}) =>
        fetcher(url, {
          ...init,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(12000),
        });
      const userHeaders = { apikey: anon, Authorization: `Bearer ${bearer}` };
      const identity = await transport(`${base}/auth/v1/user`, { headers: userHeaders });
      if (identity.status === 401 || identity.status === 403)
        throw new Failure(401, "not_authorized");
      if (!identity.ok) throw new Failure(503, "unavailable");
      const userId = object(await identity.json())["id"];
      if (typeof userId !== "string" || !uuid.test(userId))
        throw new Failure(401, "not_authorized");
      const membership = await transport(
        `${base}/rest/v1/profiles?select=auth_user_id,clinic_id,role,revoked_at&auth_user_id=eq.${userId}`,
        { headers: userHeaders },
      );
      if (!membership.ok) throw new Failure(503, "unavailable");
      const members: unknown = await membership.json();
      if (!Array.isArray(members) || members.length !== 1) throw new Failure(403, "not_authorized");
      const actor = object(members[0]);
      if (
        actor["auth_user_id"] !== userId ||
        actor["clinic_id"] !== clinic ||
        actor["role"] !== "owner" ||
        actor["revoked_at"] !== null
      )
        throw new Failure(403, "not_authorized");
      if (req.headers.get("content-type")?.split(";")[0] !== "application/json")
        throw new Failure(415, "invalid_input");
      const reader = req.body?.getReader();
      if (!reader) throw new Failure(400, "invalid_input");
      let raw = "",
        size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024) throw new Failure(413, "invalid_input");
          raw += decoder.decode(part.value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        await reader.cancel();
      }
      let input: Row;
      try {
        input = object(JSON.parse(raw));
      } catch {
        throw new Failure(400, "invalid_input");
      }
      if (
        Object.keys(input).some(
          (k) =>
            ![
              "operation",
              "requestId",
              ...(input["operation"] === "recover" ? ["candidateCallId"] : []),
            ].includes(k),
        )
      )
        throw new Failure(400, "invalid_input");
      const operation = input["operation"],
        requestId = input["requestId"];
      if (
        typeof operation !== "string" ||
        !["access", "create", "stop", "recover"].includes(operation) ||
        (operation !== "access" && (typeof requestId !== "string" || !uuid.test(requestId)))
      )
        throw new Failure(400, "invalid_input");
      const candidate = input["candidateCallId"];
      if (
        candidate !== undefined &&
        (typeof candidate !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(candidate))
      )
        throw new Failure(400, "invalid_input");
      if (operation === "create" && env("APERO_DEMO_ENABLED") !== "true")
        throw new Failure(503, "demo_disabled");
      const adminHeaders = {
        apikey: admin,
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
      };
      const rpc = async (
        command: string,
        id: unknown = requestId,
        callId: string | null = null,
      ) => {
        const response = await transport(`${base}/rest/v1/rpc/demo_call_session`, {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({
            p_command: command,
            p_user_id: userId,
            p_clinic_id: clinic,
            p_request_id: id ?? null,
            p_call_id: callId,
          }),
        });
        if (!response.ok) throw new Failure(503, "unavailable");
        const result = object(await response.json());
        if (result["code"] === "not_authorized") throw new Failure(403, "not_authorized");
        return result;
      };
      // Mapping is private, fixed to the verified account clinic, and never supplied by the browser.
      const mappingResponse = await transport(
        `${base}/rest/v1/voice_integrations?select=agent_id,conversation_flow_id,secret_env_name,active&clinic_id=eq.${clinic}`,
        { headers: adminHeaders },
      );
      if (!mappingResponse.ok) throw new Failure(503, "unavailable");
      const mappings: unknown = await mappingResponse.json();
      if (!Array.isArray(mappings) || mappings.length !== 1) throw new Failure(503, "unavailable");
      const mapping = object(mappings[0]);
      const keyName = mapping["secret_env_name"];
      if (
        mapping["agent_id"] !== AGENT ||
        mapping["conversation_flow_id"] !== FLOW ||
        mapping["active"] !== true ||
        typeof keyName !== "string" ||
        !/^RETELL_[A-Z0-9_]+$/.test(keyName)
      )
        throw new Failure(503, "unavailable");
      const key = env(keyName);
      if (!key) throw new Failure(503, "unavailable");
      const provider = (path: string, init: RequestInit = {}) =>
        transport(`https://api.retellai.com${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "X-Retell-Client-JS-SDK-Version": "3.0.3",
          },
        });
      const inspect = async (callId: string, sessionId: unknown): Promise<string> => {
        let response: Response;
        try {
          response = await provider(`/v2/get-call/${encodeURIComponent(callId)}`);
        } catch {
          throw new Failure(503, "provider_unavailable");
        }
        if (!response.ok) throw new Failure(503, "provider_unavailable");
        let call: Row;
        try {
          call = object(await response.json());
        } catch {
          throw new Failure(503, "provider_unavailable");
        }
        const metadata = call["metadata"];
        if (
          call["call_id"] !== callId ||
          call["agent_id"] !== AGENT ||
          call["agent_version"] !== APPROVED_VERSION ||
          call["call_type"] !== "web_call" ||
          !metadata ||
          typeof metadata !== "object" ||
          Array.isArray(metadata) ||
          (metadata as Row)["source"] !== "apero_private_demo" ||
          (metadata as Row)["demo_session_id"] !== sessionId
        )
          throw new Failure(409, "provider_identity_mismatch");
        const status = call["call_status"];
        if (
          typeof status !== "string" ||
          !["registered", "ongoing", "ended", "error"].includes(status)
        )
          throw new Failure(409, "provider_status_unknown");
        return status;
      };
      const isTerminal = (status: string) => status === "ended" || status === "error";
      const finish = async (row: Row, callId: string) => {
        const result = await rpc("finish", row["request_id"], callId);
        if (result["ended"] !== true) throw new Failure(503, "unavailable");
      };
      const stop = async (row: Row) => {
        if (row["ended"] === true) return true;
        const callId = row["call_id"];
        if (typeof callId !== "string") return false;
        // Never stop a call unless Get Call proves it belongs to this exact demo session.
        if (isTerminal(await inspect(callId, row["request_id"]))) {
          await finish(row, callId);
          return true;
        }
        const response = await provider(`/v2/stop-call/${encodeURIComponent(callId)}`, {
          method: "POST",
        });
        if (!response.ok && response.status !== 409) return false;
        if (!isTerminal(await inspect(callId, row["request_id"]))) return false;
        await finish(row, callId);
        return true;
      };
      if (operation === "recover") {
        const recovery = async (
          command: string,
          callId: string | null = null,
          outcome: string | null = null,
          status: string | null = null,
        ) => {
          const response = await transport(`${base}/rest/v1/rpc/demo_recover_session`, {
            method: "POST",
            headers: adminHeaders,
            body: JSON.stringify({
              p_command: command,
              p_user_id: userId,
              p_clinic_id: clinic,
              p_request_id: requestId,
              p_call_id: callId,
              p_outcome: outcome,
              p_provider_status: status,
            }),
          });
          if (!response.ok) throw new Failure(503, "unavailable");
          const result = object(await response.json());
          if (result["code"])
            throw new Failure(
              result["code"] === "not_authorized" ? 403 : 409,
              String(result["code"]),
            );
          return result;
        };
        // Only an explicitly enrolled, active Dental Zone Owner can cross this boundary.
        // An audit entry must be persisted before any provider inspection.
        const row = await recovery("begin");
        if (row["ended"] === true) return json({ recovered: true });
        const knownId = row["call_id"];
        if (typeof knownId === "string" && candidate !== undefined && candidate !== knownId) {
          await recovery("record", null, "candidate_conflict");
          throw new Failure(409, "candidate_conflict");
        }
        const callId =
          typeof knownId === "string" ? knownId : typeof candidate === "string" ? candidate : null;
        if (!callId) {
          await recovery("record", null, "candidate_required");
          throw new Failure(409, "operator_intervention_required");
        }
        let status: string;
        try {
          status = await inspect(callId, requestId);
        } catch (error) {
          const code = error instanceof Failure ? error.code : "provider_unavailable";
          await recovery("record", callId, code);
          throw error;
        }
        if (!isTerminal(status)) {
          await recovery("record", callId, "provider_active", status);
          throw new Failure(409, "provider_active");
        }
        // Recovery NEVER terminates a candidate call. It only releases a provider-confirmed terminal session.
        const completed = await recovery("finish", callId, null, status);
        if (completed["ended"] !== true) throw new Failure(503, "unavailable");
        return json({ recovered: true });
      }
      if (operation === "access") {
        const check = await rpc("authorize", null);
        if (check["ok"] !== true) throw new Failure(403, "not_authorized");
        return json({ allowed: true });
      }
      if (operation === "stop") {
        const row = await rpc("cancel");
        if (row["code"]) throw new Failure(403, "not_authorized");
        return (await stop(row)) ? json({ stopped: true }) : json({ code: "cleanup_pending" }, 409);
      }
      // Pin and validate the approved published version on every creation; no overrides.
      const agentResponse = await provider(`/get-agent/${AGENT}?version=${APPROVED_VERSION}`);
      if (!agentResponse.ok) throw new Failure(503, "unavailable");
      const agent = object(await agentResponse.json()),
        engine = object(agent["response_engine"]);
      if (
        agent["agent_id"] !== AGENT ||
        agent["version"] !== APPROVED_VERSION ||
        agent["is_published"] !== true ||
        engine["conversation_flow_id"] !== FLOW ||
        engine["version"] !== APPROVED_VERSION
      )
        throw new Failure(503, "unavailable");
      // Reconcile only provider-confirmed terminal sessions. Never expire a live lock by a timer.
      const outstanding = await rpc("outstanding", null);
      if (
        typeof outstanding["call_id"] === "string" &&
        isTerminal(await inspect(outstanding["call_id"], outstanding["request_id"]))
      )
        await finish(outstanding, outstanding["call_id"]);
      const reservation = await rpc("reserve");
      if (reservation["ok"] !== true)
        throw new Failure(
          reservation["code"] === "rate_limited" ? 429 : 409,
          String(reservation["code"] ?? "session_exists"),
        );
      // From here on an ambiguous provider/network failure deliberately retains the reservation.
      const response = await provider("/v3/create-web-call", {
        method: "POST",
        body: JSON.stringify({
          agent_id: AGENT,
          agent_version: APPROVED_VERSION,
          metadata: { source: "apero_private_demo", demo_session_id: requestId },
        }),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408)
          await rpc("finish");
        throw new Failure(502, "provider_unavailable");
      }
      for (const name of [
        "X-Retell-Client-JS-SDK-Min-Version",
        "X-Retell-Client-JS-SDK-Recommended-Version",
      ]) {
        const value = response.headers.get(name);
        if (value && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value)) headers[name] = value;
      }
      headers["Access-Control-Expose-Headers"] =
        "X-Retell-Client-JS-SDK-Min-Version, X-Retell-Client-JS-SDK-Recommended-Version";
      const connection = object(await response.json());
      const callId = connection["call_id"];
      if (typeof callId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(callId))
        throw new Failure(502, "provider_unavailable");
      let attached: Row;
      try {
        attached = await rpc("attach", requestId, callId);
      } catch (error) {
        await stop({ request_id: requestId, call_id: callId }).catch(() => undefined);
        throw error;
      }
      if (attached["call_id"] !== callId || attached["request_id"] !== requestId) {
        await stop({ request_id: requestId, call_id: callId }).catch(() => undefined);
        throw new Failure(503, "unavailable");
      }
      if (attached["cancel_requested"] === true) {
        await stop(attached);
        throw new Failure(409, "call_cancelled");
      }
      if (
        typeof connection["access_token"] !== "string" ||
        connection["transport"] !== "gateway" ||
        !Array.isArray(connection["ice_servers"]) ||
        typeof connection["expires_at"] !== "number"
      ) {
        await stop(attached);
        throw new Failure(502, "provider_unavailable");
      }
      // Only short-lived, call-scoped connection credentials leave this boundary.
      return json({
        call_id: callId,
        access_token: connection["access_token"],
        transport: connection["transport"],
        ice_servers: connection["ice_servers"],
        expires_at: connection["expires_at"],
      });
    } catch (error) {
      return json(
        { code: error instanceof Failure ? error.code : "unavailable" },
        error instanceof Failure ? error.status : 503,
      );
    }
  };
}
