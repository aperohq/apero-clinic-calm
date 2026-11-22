import {
  body,
  clients,
  config,
  owner,
  accessToken,
  reply,
  uuid,
} from "../_shared/integrations/runtime.ts";
import type { Env } from "../_shared/integrations/runtime.ts";
import { challenge, randomSecret, seal, sha256 } from "../_shared/integrations/crypto.ts";
import { exchangeToken, GoogleCalendarAdapter, oauthUrl } from "../_shared/integrations/google.ts";
import { ProviderError } from "../_shared/integrations/adapter.ts";
export function createIntegrationApi(env: Env, fetcher: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = { vary: "Origin" };
    const origin = env("APERO_PORTAL_ORIGIN");
    if (req.headers.has("origin")) {
      if (!origin || req.headers.get("origin") !== origin)
        return reply(403, { code: "not_authorized" });
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-headers"] =
        "authorization,apikey,content-type,x-client-info,idempotency-key";
      headers["access-control-allow-methods"] = "GET,POST,OPTIONS";
    }
    const send = (status: number, data: unknown) => reply(status, data, headers);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (env("INTEGRATIONS_ENABLED") !== "true") return send(503, { code: "integrations_disabled" });
    const path = new URL(req.url).pathname.split("/integration-api")[1] || "/";
    try {
      if (path === "/oauth/callback") {
        if (req.method !== "GET") return send(405, { code: "method_not_allowed" });
        const query = new URL(req.url).searchParams;
        const state = query.get("state"),
          code = query.get("code");
        if (!state || !/^[a-f0-9]{64}$/.test(state))
          return send(400, { code: "invalid_oauth_state" });
        // Relay only the short-lived authorization code. Token exchange requires the
        // initiating browser's stored state AND the same authenticated clinic owner.
        if (!origin || new URL(origin).protocol !== "https:")
          return send(503, { code: "not_configured" });
        const target = new URL("/account", origin);
        if (!code || code.length > 4096 || query.has("error"))
          target.searchParams.set("integration_error", "oauth_denied");
        else {
          target.searchParams.set("integration_code", code);
          target.searchParams.set("integration_state", state);
        }
        return new Response(null, {
          status: 303,
          headers: {
            location: target.href,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (path.startsWith("/manage/")) {
        if (req.method !== "POST") return send(405, { code: "method_not_allowed" });
        const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
        if (!token) return send(401, { code: "not_authorized" });
        const { admin, user } = clients(env, fetcher, token),
          actor = await owner(user, token);
        if (!actor) return send(403, { code: "not_authorized" });
        const input = await body(req);
        if (path === "/manage/oauth/start") {
          const settings = config(env);
          if (!/^[a-f0-9]{64}$/i.test(env("INTEGRATION_ENCRYPTION_KEY") ?? ""))
            return send(503, { code: "not_configured" });
          const state = randomSecret(),
            verifier = randomSecret();
          const result = await admin.rpc("integration_start_oauth", {
            p_clinic: actor.clinic,
            p_actor: actor.actor,
            p_hash: await sha256(state),
            p_verifier: verifier,
          });
          if (result.error) return send(409, { code: "oauth_limit" });
          return send(200, { url: oauthUrl(settings, state, await challenge(verifier)), state });
        }
        if (path === "/manage/oauth/complete") {
          const state = input["state"],
            code = input["code"];
          if (
            typeof state !== "string" ||
            !/^[a-f0-9]{64}$/.test(state) ||
            typeof code !== "string" ||
            code.length < 1 ||
            code.length > 4096
          )
            return send(400, { code: "invalid_oauth_state" });
          const consumed = await admin
            .from("integration_oauth_states")
            .delete()
            .eq("state_hash", await sha256(state))
            .eq("clinic_id", actor.clinic)
            .eq("actor_id", actor.actor)
            .gt("expires_at", new Date().toISOString())
            .select("*")
            .maybeSingle();
          if (consumed.error) return send(503, { code: "unavailable" });
          const saved = consumed.data;
          if (!saved) return send(400, { code: "invalid_oauth_state" });
          const tokens = await exchangeToken(
            config(env),
            { grant_type: "authorization_code", code, code_verifier: saved.verifier },
            fetcher,
          );
          const id = crypto.randomUUID();
          const result = await admin.rpc("integration_save_connection", {
            p_id: id,
            p_clinic: actor.clinic,
            p_actor: actor.actor,
            p_credentials: await seal(
              tokens,
              env("INTEGRATION_ENCRYPTION_KEY") ?? "",
              actor.clinic + ":" + id,
            ),
          });
          if (result.error) return send(503, { code: "connection_not_saved" });
          return send(200, { connected: true });
        }
        if (!uuid(input["connection_id"])) return send(400, { code: "invalid_input" });
        const result = await admin
          .from("calendar_connections")
          .select("*")
          .eq("id", input["connection_id"])
          .eq("clinic_id", actor.clinic)
          .neq("status", "disconnected")
          .maybeSingle();
        if (result.error) return send(503, { code: "unavailable" });
        const connection = result.data;
        if (!connection) return send(404, { code: "connection_not_found" });
        if (path === "/manage/calendars" || path === "/manage/select") {
          const adapter = new GoogleCalendarAdapter(
            await accessToken(admin, env, connection, fetcher),
            fetcher,
          );
          const calendars = await adapter.calendars();
          if (path === "/manage/calendars") return send(200, { calendars });
          if (
            !uuid(input["staff_id"]) ||
            typeof input["calendar_id"] !== "string" ||
            !calendars.some((c) => c.id === input["calendar_id"])
          )
            return send(400, { code: "invalid_calendar" });
          const selected = await user.rpc("integration_select_calendar", {
            p_id: connection.id,
            p_calendar: input["calendar_id"],
            p_staff: input["staff_id"],
          });
          if (selected.error) return send(409, { code: "calendar_selection_failed" });
          return send(200, { selected: true });
        }
        if (path === "/manage/disconnect" || path === "/manage/retry") {
          const updated = await user.rpc(
            path.endsWith("disconnect") ? "integration_disconnect" : "integration_retry",
            { p_id: connection.id },
          );
          if (updated.error) return send(409, { code: "connection_update_failed" });
          return send(200, { success: true });
        }
        return send(404, { code: "not_found" });
      }
      const scopes: Record<string, string> = {
        "/v1/appointments": req.method === "GET" ? "appointments:read" : "appointments:write",
        "/v1/availability": "availability:read",
      };
      const scope = scopes[path];
      if (!scope) return send(404, { code: "not_found" });
      if (
        !["GET", "POST"].includes(req.method) ||
        (path === "/v1/availability" && req.method !== "GET")
      )
        return send(405, { code: "method_not_allowed" });
      const key = req.headers.get("authorization")?.match(/^Bearer (apero_[a-f0-9]{64})$/)?.[1];
      if (!key) return send(401, { code: "invalid_api_key" });
      const { admin } = clients(env, fetcher);
      const authorized = await admin.rpc("integration_authorize", {
        p_hash: await sha256(key),
        p_scope: scope,
      });
      if (authorized.error) return send(503, { code: "unavailable" });
      const actor = authorized.data as { id: string; clinic_id: string; limited?: boolean } | null;
      if (!actor) return send(401, { code: "invalid_api_key" });
      if (actor.limited) {
        headers["retry-after"] = "60";
        return send(429, { code: "rate_limited" });
      }
      if (path === "/v1/appointments" && req.method === "POST") {
        const input = await body(req);
        const allowed = [
          "action",
          "appointment_id",
          "client_id",
          "staff_id",
          "service",
          "start_time",
          "end_time",
        ];
        if (
          Object.keys(input).some((k) => !allowed.includes(k)) ||
          !["book", "cancel", "reschedule"].includes(String(input["action"])) ||
          ["appointment_id", "client_id", "staff_id"].some(
            (k) => input[k] !== undefined && !uuid(input[k]),
          ) ||
          ["start_time", "end_time"].some(
            (k) =>
              input[k] !== undefined &&
              (typeof input[k] !== "string" ||
                !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input[k]) ||
                !Number.isFinite(Date.parse(input[k]))),
          ) ||
          (input["service"] !== undefined &&
            (typeof input["service"] !== "string" || input["service"].length > 120))
        )
          return send(400, { code: "invalid_input" });
        const changed = await admin.rpc("integration_mutate", {
          p_key: actor.id,
          p_request: req.headers.get("idempotency-key"),
          p_body: input,
        });
        if (changed.error) {
          const code = changed.error.code;
          return send(
            code === "42501"
              ? 401
              : code === "P0002"
                ? 404
                : ["23P01", "40P01", "23505"].includes(code)
                  ? 409
                  : 400,
            {
              code:
                code === "23505"
                  ? "idempotency_conflict"
                  : code === "23P01" || code === "40P01"
                    ? "slot_conflict"
                    : "appointment_rejected",
            },
          );
        }
        return send(200, { appointment: changed.data });
      }
      const query = new URL(req.url).searchParams;
      if (path === "/v1/availability") {
        const staff = query.get("staff_id"),
          date = query.get("date"),
          service = query.get("service");
        if (
          !uuid(staff) ||
          !date ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !service ||
          service.length > 120
        )
          return send(400, { code: "invalid_input" });
        const slots = await admin.rpc("appointment_available_slots", {
          p_clinic_id: actor.clinic_id,
          p_staff_id: staff,
          p_service: service,
          p_date: date,
        });
        if (slots.error) return send(400, { code: "availability_rejected" });
        return send(200, { slots: slots.data });
      }
      const from = query.get("from"),
        until = query.get("until");
      if (
        !from ||
        !until ||
        !Number.isFinite(Date.parse(from)) ||
        !Number.isFinite(Date.parse(until)) ||
        Date.parse(until) <= Date.parse(from) ||
        Date.parse(until) - Date.parse(from) > 31 * 86400000
      )
        return send(400, { code: "invalid_date_range" });
      const rows = await admin
        .from("appointments")
        .select("id,staff_id,service,start_time,end_time,status")
        .eq("clinic_id", actor.clinic_id)
        .gte("start_time", from)
        .lt("start_time", until)
        .order("start_time")
        .order("id")
        .limit(201);
      if (rows.error) return send(503, { code: "unavailable" });
      if ((rows.data?.length ?? 0) > 200) return send(422, { code: "narrow_date_range" });
      return send(200, { appointments: rows.data });
    } catch (e) {
      // No raw exception strings, tokens, provider payloads or patient data in responses/logs.
      if (e instanceof ProviderError) return send(e.retryable ? 503 : 409, { code: e.code });
      if ((e instanceof Error && ["invalid_input"].includes(e.message)) || e instanceof SyntaxError)
        return send(400, { code: "invalid_input" });
      return send(503, { code: "integration_unavailable" });
    }
  };
}
