// Server boundary: never import into the frontend.
import { readLimitedBody, RequestBodyTooLargeError } from "../_shared/request-security.ts";
import { operationalLog } from "../_shared/operational-log.ts";

type Row = Record<string, unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callIdPattern = /^call_[a-zA-Z0-9_-]{1,120}$/;
class Failure extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Failure(503, "unavailable");
  return value as Row;
}
function single(value: unknown): Row {
  if (!Array.isArray(value) || value.length !== 1) throw new Failure(403, "not_authorized");
  return row(value[0]);
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
      const origin = env("APERO_PORTAL_ORIGIN");
      if (!origin || new URL(origin).origin !== origin) throw new Failure(503, "unavailable");
      if (req.headers.get("origin") !== origin) throw new Failure(403, "not_authorized");
      Object.assign(headers, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
      if (req.method !== "POST") throw new Failure(405, "method_not_allowed");
      const bearer = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
      if (!bearer) throw new Failure(401, "not_authorized");
      const base = env("SUPABASE_URL"),
        anon = env("SUPABASE_ANON_KEY"),
        admin = env("SUPABASE_SERVICE_ROLE_KEY"),
        clinic = env("APERO_DEMO_CLINIC_ID"),
        configuredAgent = env("APERO_DEMO_AGENT_ID");
      if (
        !base ||
        !anon ||
        !admin ||
        !clinic ||
        !uuid.test(clinic) ||
        !configuredAgent ||
        !/^agent_[a-zA-Z0-9_-]+$/.test(configuredAgent)
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
      const user = row(await identity.json())["id"];
      if (typeof user !== "string" || !uuid.test(user)) throw new Failure(401, "not_authorized");
      const membership = await transport(
        `${base}/rest/v1/profiles?select=auth_user_id,clinic_id,role,revoked_at&auth_user_id=eq.${user}`,
        { headers: userHeaders },
      );
      if (!membership.ok) throw new Failure(503, "unavailable");
      const actor = single(await membership.json());
      if (
        actor["auth_user_id"] !== user ||
        actor["clinic_id"] !== clinic ||
        actor["role"] !== "owner" ||
        actor["revoked_at"] !== null
      )
        throw new Failure(403, "not_authorized");
      if (req.headers.get("content-type")?.split(";")[0] !== "application/json")
        throw new Failure(415, "invalid_input");
      let input: Row;
      try {
        input = row(JSON.parse(await readLimitedBody(req, 1024, AbortSignal.timeout(5000))));
      } catch (error) {
        throw new Failure(error instanceof RequestBodyTooLargeError ? 413 : 400, "invalid_input");
      }
      const operation = input["operation"],
        requestId = input["requestId"];
      if (
        Object.keys(input).some((k) => !["operation", "requestId"].includes(k)) ||
        !["access", "create", "stop"].includes(String(operation)) ||
        (operation !== "access" && (typeof requestId !== "string" || !uuid.test(requestId)))
      )
        throw new Failure(400, "invalid_input");
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
            p_user_id: user,
            p_clinic_id: clinic,
            p_request_id: id ?? null,
            p_call_id: callId,
          }),
        });
        if (!response.ok) throw new Failure(503, "unavailable");
        const result = row(await response.json());
        if (result["code"] === "not_authorized") throw new Failure(403, "not_authorized");
        return result;
      };
      if (operation === "access") {
        if ((await rpc("authorize", null))["ok"] !== true) throw new Failure(403, "not_authorized");
        return json({ allowed: true });
      }
      // This private clinic mapping is authoritative; no browser agent or flow overrides.
      const mappingResponse = await transport(
        `${base}/rest/v1/voice_integrations?select=agent_id,conversation_flow_id,secret_env_name,active&clinic_id=eq.${clinic}&active=eq.true`,
        { headers: adminHeaders },
      );
      if (!mappingResponse.ok) throw new Failure(503, "unavailable");
      const mapping = single(await mappingResponse.json()),
        agent = mapping["agent_id"],
        flow = mapping["conversation_flow_id"],
        keyName = mapping["secret_env_name"];
      if (
        typeof agent !== "string" ||
        !/^agent_[a-zA-Z0-9_-]+$/.test(agent) ||
        typeof flow !== "string" ||
        !/^conversation_flow_[a-zA-Z0-9_-]+$/.test(flow) ||
        mapping["active"] !== true ||
        typeof keyName !== "string" ||
        !/^RETELL_[A-Z0-9_]+$/.test(keyName) ||
        configuredAgent !== agent
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
      const inspect = async (callId: string, id: unknown) => {
        if (!callIdPattern.test(callId)) throw new Failure(503, "unavailable");
        const response = await provider(`/v2/get-call/${callId}`);
        if (!response.ok) throw new Failure(503, "unavailable");
        const call = row(await response.json()),
          metadata = row(call["metadata"]);
        if (
          call["call_id"] !== callId ||
          call["agent_id"] !== agent ||
          call["call_type"] !== "web_call" ||
          metadata["source"] !== "apero_private_demo" ||
          metadata["demo_session_id"] !== id ||
          !["registered", "ongoing", "ended", "error"].includes(String(call["call_status"]))
        )
          throw new Failure(503, "unavailable");
        return String(call["call_status"]);
      };
      const terminal = (status: string) => status === "ended" || status === "error";
      const finish = async (id: unknown, callId: string | null) => {
        if ((await rpc("finish", id, callId))["ended"] !== true)
          throw new Failure(503, "unavailable");
      };
      const stop = async (session: Row) => {
        if (session["ended"] === true) return true;
        const callId = session["call_id"];
        if (typeof callId !== "string") return false; // Ambiguous creation retains the lock.
        if (!terminal(await inspect(callId, session["request_id"]))) {
          const response = await provider(`/v2/stop-call/${callId}`, { method: "POST" });
          if (!response.ok && response.status !== 409) return false;
          if (!terminal(await inspect(callId, session["request_id"]))) return false;
        }
        await finish(session["request_id"], callId);
        return true;
      };
      if (operation === "stop") {
        const session = await rpc("cancel");
        if (session["code"]) throw new Failure(409, "cleanup_pending");
        if (!(await stop(session))) throw new Failure(409, "cleanup_pending");
        return json({ stopped: true });
      }
      if (env("APERO_DEMO_ENABLED") !== "true") throw new Failure(503, "unavailable");
      // Read-only validation of the current published response engine, never a numeric pin.
      const agentResponse = await provider(`/get-agent/${agent}?version=latest_published`);
      if (!agentResponse.ok) throw new Failure(503, "unavailable");
      const published = row(await agentResponse.json()),
        engine = row(published["response_engine"]);
      if (
        published["agent_id"] !== agent ||
        published["is_published"] !== true ||
        engine["type"] !== "conversation-flow" ||
        engine["conversation_flow_id"] !== flow ||
        !Number.isInteger(engine["version"])
      )
        throw new Failure(503, "unavailable");
      const outstanding = await rpc("outstanding", null);
      if (
        typeof outstanding["call_id"] === "string" &&
        terminal(await inspect(outstanding["call_id"], outstanding["request_id"]))
      )
        await finish(outstanding["request_id"], outstanding["call_id"]);
      const reservation = await rpc("reserve");
      if (reservation["ok"] !== true)
        throw new Failure(
          reservation["code"] === "rate_limited" ? 429 : 409,
          reservation["code"] === "rate_limited" ? "rate_limited" : "session_exists",
        );
      // Never retry provider creation: timeout/5xx may mean a call was already allocated.
      const response = await provider("/v3/create-web-call", {
        method: "POST",
        body: JSON.stringify({
          agent_id: agent,
          agent_version: "latest_published",
          metadata: { source: "apero_private_demo", demo_session_id: requestId },
        }),
      });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408)
          await finish(requestId, null);
        throw new Failure(502, "unavailable");
      }
      const connection = row(await response.json()),
        callId = connection["call_id"];
      if (typeof callId !== "string" || !callIdPattern.test(callId))
        throw new Failure(502, "unavailable");
      const attached = await rpc("attach", requestId, callId);
      if (attached["call_id"] !== callId || attached["request_id"] !== requestId) {
        await stop({ request_id: requestId, call_id: callId }).catch(() => undefined);
        throw new Failure(503, "unavailable");
      }
      if (attached["cancel_requested"] === true) {
        await stop(attached);
        throw new Failure(409, "cleanup_pending");
      }
      const ice = connection["ice_servers"];
      if (
        typeof connection["access_token"] !== "string" ||
        !connection["access_token"] ||
        connection["access_token"] === key ||
        connection["transport"] !== "gateway" ||
        !Array.isArray(ice) ||
        typeof connection["expires_at"] !== "number"
      ) {
        await stop(attached);
        throw new Failure(502, "unavailable");
      }
      // Explicit allowlist, including nested ICE credentials scoped to this connection.
      const servers = ice.map((value) => {
        const server = row(value),
          urls = server["urls"];
        if (
          !(
            typeof urls === "string" ||
            (Array.isArray(urls) && urls.every((u) => typeof u === "string"))
          ) ||
          (server["username"] !== undefined && typeof server["username"] !== "string") ||
          (server["credential"] !== undefined && typeof server["credential"] !== "string")
        )
          throw new Failure(502, "unavailable");
        return {
          urls,
          ...(typeof server["username"] === "string" ? { username: server["username"] } : {}),
          ...(typeof server["credential"] === "string" ? { credential: server["credential"] } : {}),
        };
      });
      const safe = {
        call_id: callId,
        access_token: connection["access_token"],
        transport: "gateway",
        ice_servers: servers,
        expires_at: connection["expires_at"],
      };
      if (JSON.stringify(safe).includes(key)) {
        await stop(attached);
        throw new Failure(502, "unavailable");
      }
      return json(safe);
    } catch (error) {
      const status = error instanceof Failure ? error.status : 503;
      if (status >= 500)
        operationalLog("provider_error", "portal-server", {
          dependency_category: "integration_unavailable",
          status,
        });
      return json({ code: error instanceof Failure ? error.code : "unavailable" }, status);
    }
  };
}
