import { operationalLog } from "../_shared/operational-log.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseClinicUserRequest,
  invitationRedirect,
  provisionClinicUser,
  ClinicUserProvisionError,
} from "../_shared/clinic-users.ts";
import { readLimitedBody, RequestBodyTooLargeError } from "../_shared/request-security.ts";

// withSupabase's secret-key gate must run before this handler. The context
// check is defense in depth against accidentally changing the entry-point mode.
export function createProvisionClinicUserHandler(getPortalOrigin: () => string | undefined) {
  return async (req: Request, ctx: { authMode: string; supabaseAdmin: SupabaseClient }) => {
    const json = (body: unknown, status: number) =>
      Response.json(body, {
        status,
        headers: {
          "cache-control": "no-store",
          pragma: "no-cache",
          "x-content-type-options": "nosniff",
        },
      });
    if (ctx.authMode !== "secret") return json({ error: "Unauthorized" }, 401);
    if (req.headers.has("origin")) return json({ error: "Operator server requests only" }, 403);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (
      req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
    ) {
      return json({ error: "Expected application/json" }, 415);
    }
    let portalOrigin: string;
    try {
      portalOrigin = getPortalOrigin() ?? "";
      invitationRedirect(portalOrigin);
    } catch {
      return json({ error: "Portal configuration unavailable" }, 503);
    }
    let input;
    try {
      input = parseClinicUserRequest(JSON.parse(await readLimitedBody(req, 8192)));
    } catch (error) {
      return json(
        {
          error:
            error instanceof RequestBodyTooLargeError
              ? "Request too large"
              : "Invalid provisioning input",
        },
        error instanceof RequestBodyTooLargeError ? 413 : 400,
      );
    }
    try {
      const result = await provisionClinicUser(ctx.supabaseAdmin, input, portalOrigin);
      return json(result, 200);
    } catch (error) {
      if (error instanceof ClinicUserProvisionError) {
        // These messages are curated by provisioning; never relay provider errors.
        return json({ error: error.message, authUserId: error.authUserId }, 409);
      }
      operationalLog("internal_error", "provision-clinic-user");
      return json({ error: "Provisioning failed; inspect the account before retrying" }, 500);
    }
  };
}
