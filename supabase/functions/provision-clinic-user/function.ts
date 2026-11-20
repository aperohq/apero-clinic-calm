import { monitorHandler, setOperationalContext } from "../_shared/operational-log.ts";
import { withSupabase } from "@supabase/server";
import { createProvisionClinicUserHandler } from "./handler.ts";
import { readLimitedBody, RequestBodyTooLargeError } from "../_shared/request-security.ts";

export function createProvisionClinicUserFunction(getEnv: (name: string) => string | undefined) {
  const handler = createProvisionClinicUserHandler(() => getEnv("APERO_PORTAL_ORIGIN"));
  const authorized = withSupabase(
    {
      // SDK validates against runtime SUPABASE_SECRET_KEYS (or singular
      // SUPABASE_SECRET_KEY), without a legacy credential override.
      auth: "secret",
      cors: "disabled",
    },
    handler,
  );
  return monitorHandler("provision-clinic-user", async (req: Request) => {
    // Bound the stream before middleware can buffer it. No JSON parsing or
    // provider operations occur here; operator authentication remains in SDK.
    let bounded = req;
    if (req.body) {
      try {
        const body = await readLimitedBody(req, 8192);
        bounded = new Request(req, { body });
      } catch (error) {
        return Response.json(
          { error: "Invalid or oversized request body" },
          {
            status: error instanceof RequestBodyTooLargeError ? 413 : 400,
            headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          },
        );
      }
    }
    const response = await authorized(bounded);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  });
}
