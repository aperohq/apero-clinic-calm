import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { invitationRedirect } from "../_shared/clinic-users.ts";
import { createTeamHandler } from "./handler.ts";

// Auth validates the bearer with Supabase getUser, never local JWT decoding.
// The admin client is constructed only at the server boundary, never imported
// by frontend code. Injectable factories keep tests entirely local.
export function createTeamFunction(
  getEnv: (name: string) => string | undefined,
  clients: typeof createClient = createClient,
  fetcher: typeof fetch = fetch,
  limits = { requestMs: 45000, fetchMs: 15000, calls: 8 },
) {
  return async (req: Request): Promise<Response> => {
    let origin: string;
    try {
      origin = new URL(invitationRedirect(getEnv("APERO_PORTAL_ORIGIN") ?? "")).origin;
    } catch {
      return Response.json({ code: "unavailable" }, { status: 503 });
    }
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      vary: "Origin",
    };
    if (req.headers.get("origin") === origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Headers"] =
        "authorization, apikey, content-type, x-client-info";
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    } else if (req.headers.has("origin")) {
      return Response.json({ code: "not_authorized" }, { status: 403, headers });
    }
    const json = (code: string, status: number) => Response.json({ code }, { status, headers });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return json("method_not_allowed", 405);
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      return json("invalid_input", 415);
    const bearer = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
    if (!bearer) return json("not_authorized", 401);
    const url = getEnv("SUPABASE_URL"),
      publicKey = getEnv("SUPABASE_ANON_KEY"),
      serverKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !publicKey || !serverKey) return json("unavailable", 503);
    const controller = new AbortController();
    const deadline = controller.signal;
    const timer = setTimeout(
      () => controller.abort(new Error("Request deadline exceeded")),
      limits.requestMs,
    );
    const abortRequest = () => controller.abort(req.signal.reason);
    req.signal.addEventListener("abort", abortRequest, { once: true });
    if (req.signal.aborted) abortRequest();
    let transportCalls = 0;
    let databaseCalls = 0;
    const authCalls = new Set<string>();
    let userClient: SupabaseClient | undefined, admin: SupabaseClient | undefined;
    try {
      const options = {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: {
          fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            // Including getUser and profile resolution: at most eight outgoing
            // calls. No SDK retry or cleanup can exceed the shared budget.
            if (++transportCalls > limits.calls || deadline.aborted)
              throw new Error("Request work exhausted");
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
            if (path.startsWith("/auth/v1/")) {
              if (
                !["/auth/v1/user", "/auth/v1/admin/generate_link", "/auth/v1/invite"].includes(
                  path,
                ) ||
                authCalls.has(path)
              )
                throw new Error("Auth operation exhausted");
              authCalls.add(path);
            }
            if (path.startsWith("/rest/v1/") && ++databaseCalls > 5)
              throw new Error("Database work exhausted");
            return fetcher(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, deadline, AbortSignal.timeout(limits.fetchMs)])
                : AbortSignal.any([deadline, AbortSignal.timeout(limits.fetchMs)]),
            });
          },
        },
      };
      userClient = clients(url, publicKey, {
        ...options,
        global: { ...options.global, headers: { Authorization: `Bearer ${bearer}` } },
      });
      const identity = await userClient.auth.getUser(bearer);
      if (identity.error || !identity.data.user) return json("not_authorized", 401);
      admin = clients(url, serverKey, options);
      const result = await createTeamHandler(origin)(req, {
        authUserId: identity.data.user.id,
        userClient,
        admin,
        signal: deadline,
      });
      return new Response(result.body, {
        status: result.status,
        headers: { ...Object.fromEntries(result.headers), ...headers },
      });
    } catch {
      return json("unavailable", 503);
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", abortRequest);
      await userClient?.auth.dispose();
      await admin?.auth.dispose();
    }
  };
}
