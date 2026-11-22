import { createClient } from "@supabase/supabase-js";
import { readLimitedBody } from "../request-security.ts";
import { unseal, seal } from "./crypto.ts";
import { exchangeToken } from "./google.ts";
import type { GoogleConfig, GoogleTokens } from "./google.ts";
export type Env = (name: string) => string | undefined;
export function clients(env: Env, fetcher: typeof fetch = fetch, token?: string) {
  const url = env("SUPABASE_URL"),
    key = env("SUPABASE_SERVICE_ROLE_KEY"),
    anon = env("SUPABASE_ANON_KEY");
  if (!url || !key || !anon) throw new Error("not_configured");
  const transport: typeof fetch = (input, init) =>
    fetcher(input, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) });
  const options = {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: transport },
  };
  return {
    admin: createClient(url, key, options),
    user: createClient(url, anon, {
      ...options,
      global: { ...options.global, headers: token ? { Authorization: `Bearer ${token}` } : {} },
    }),
  };
}
export type Admin = ReturnType<typeof clients>["admin"];
export function config(env: Env): GoogleConfig {
  const clientId = env("GOOGLE_CLIENT_ID"),
    clientSecret = env("GOOGLE_CLIENT_SECRET"),
    redirectUri = env("GOOGLE_REDIRECT_URI");
  if (!clientId || !clientSecret || !redirectUri || new URL(redirectUri).protocol !== "https:")
    throw new Error("oauth_not_configured");
  return { clientId, clientSecret, redirectUri };
}
export async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    throw new Error("invalid_input");
  const result: unknown = JSON.parse(
    await readLimitedBody(req, 16384, AbortSignal.any([req.signal, AbortSignal.timeout(10000)])),
  );
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("invalid_input");
  return result as Record<string, unknown>;
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}
export async function owner(user: ReturnType<typeof clients>["user"], token: string) {
  const identity = await user.auth.getUser(token);
  if (identity.error || !identity.data.user) return null;
  const membership = await user
    .from("profiles")
    .select("clinic_id,role,revoked_at")
    .eq("auth_user_id", identity.data.user.id)
    .maybeSingle();
  if (
    membership.error ||
    !membership.data ||
    membership.data.role !== "owner" ||
    membership.data.revoked_at
  )
    return null;
  return { clinic: membership.data.clinic_id as string, actor: identity.data.user.id };
}
export async function accessToken(
  admin: Admin,
  env: Env,
  c: { id: string; clinic_id: string; credentials: string },
  fetcher: typeof fetch = fetch,
  workerLease?: string,
): Promise<string> {
  const secret = env("INTEGRATION_ENCRYPTION_KEY") ?? "";
  const tokens = await unseal<GoogleTokens>(c.credentials, secret, c.clinic_id + ":" + c.id);
  if (tokens.expires_at > Date.now() + 60000) return tokens.access_token;
  const claim = await admin.rpc("integration_refresh_claim", {
    p_id: c.id,
    p_credentials: c.credentials,
    p_existing_lease: workerLease ?? null,
  });
  if (claim.error || !claim.data) throw new Error("connection_busy");
  const lease = claim.data as string;
  try {
    const refreshed = await exchangeToken(
      config(env),
      { grant_type: "refresh_token", refresh_token: tokens.refresh_token },
      fetcher,
    );
    const result = await admin
      .from("calendar_connections")
      .update({ credentials: await seal(refreshed, secret, c.clinic_id + ":" + c.id) })
      .eq("id", c.id)
      .eq("credentials", c.credentials)
      .eq("lease_id", lease)
      .gt("lease_until", new Date().toISOString())
      .neq("status", "disconnected")
      .select("id");
    if (result.error || result.data?.length !== 1) throw new Error("connection_changed");
    return refreshed.access_token;
  } finally {
    if (!workerLease)
      await admin.rpc("integration_refresh_release", { p_id: c.id, p_lease: lease });
  }
}
export function reply(status: number, data: unknown, headers: Record<string, string> = {}) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}
