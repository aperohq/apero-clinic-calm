import { clients, reply, uuid } from "../_shared/integrations/runtime.ts";
import type { Env } from "../_shared/integrations/runtime.ts";
import { sha256 } from "../_shared/integrations/crypto.ts";
export function createCalendarWebhook(env: Env, fetcher: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return reply(405, { code: "method_not_allowed" });
    if (env("INTEGRATIONS_ENABLED") !== "true")
      return reply(503, { code: "integrations_disabled" });
    const channel = req.headers.get("x-goog-channel-id"),
      token = req.headers.get("x-goog-channel-token"),
      resource = req.headers.get("x-goog-resource-id"),
      number = req.headers.get("x-goog-message-number"),
      state = req.headers.get("x-goog-resource-state");
    if (
      !uuid(channel) ||
      !token ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !resource ||
      resource.length > 1024 ||
      !number ||
      !/^\d{1,30}$/.test(number) ||
      !state ||
      !["sync", "exists", "not_exists"].includes(state)
    )
      return reply(403, { code: "invalid_notification" });
    try {
      const { admin } = clients(env, fetcher);
      const result = await admin.rpc("integration_notify", {
        p_channel: channel,
        p_hash: await sha256(token),
        p_resource: resource,
        p_number: number,
        p_state: state,
      });
      if (result.error) return reply(503, { code: "notification_not_saved" });
      return result.data
        ? new Response(null, { status: 204 })
        : reply(403, { code: "invalid_notification" });
    } catch {
      return reply(503, { code: "unavailable" });
    }
  };
}
