// Private Node operator client. Never import into application/browser code.
import { createClient } from "@supabase/supabase-js";
import {
  validateOperatorEnvironment,
  ProvisionDiagnosticError,
} from "./clinic-user-operator-config.mjs";

export function createClinicUserAdmin(env, fetcher = fetch) {
  const base = validateOperatorEnvironment(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  const secret = env.SUPABASE_SECRET_KEY;
  if (!secret.startsWith("sb_secret_"))
    throw new ProvisionDiagnosticError(
      "INVALID_OPERATOR_KEY",
      "SUPABASE_SECRET_KEY must be a project sb_secret_ server key.",
    );
  return createClient(base.origin, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        // Opaque API keys belong in apikey, not the JWT Authorization slot.
        headers.delete("Authorization");
        headers.set("apikey", secret);
        return fetcher(input, {
          ...init,
          headers,
          redirect: "error",
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000),
        });
      },
    },
  });
}
