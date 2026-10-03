import { ClinicUserProvisionError } from "../src/lib/clinic-users.server.ts";

// Only locally authored messages are printable. Never relay arbitrary HTTP
// bodies, provider errors, headers, or fetch exception messages to the terminal.
export class ProvisionDiagnosticError extends ClinicUserProvisionError {
  constructor(
    code,
    message,
    { status = null, endpoint = "not contacted", authUserId = null } = {},
  ) {
    super(message, authUserId);
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
  }
}

export function validateOperatorEnvironment(
  supabaseUrl,
  operatorKey,
  keyName = "SUPABASE_SECRET_KEY",
) {
  const missing = [...(!supabaseUrl ? ["SUPABASE_URL"] : []), ...(!operatorKey ? [keyName] : [])];
  if (missing.length)
    throw new ProvisionDiagnosticError(
      "MISSING_ENV",
      `Missing environment variables: ${missing.join(", ")}. Export them in this shell; this script does not load .env files automatically.`,
    );
  let base;
  try {
    base = new URL(supabaseUrl);
  } catch {
    throw new ProvisionDiagnosticError(
      "INVALID_SUPABASE_URL",
      "SUPABASE_URL must be a valid project origin.",
    );
  }
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
  ) {
    throw new ProvisionDiagnosticError(
      "INVALID_SUPABASE_URL",
      "SUPABASE_URL must be an HTTPS project origin without credentials, path, query, or fragment (HTTP loopback is allowed locally).",
    );
  }
  if (operatorKey.trim() !== operatorKey || /[\r\n]/.test(operatorKey))
    throw new ProvisionDiagnosticError(
      "INVALID_OPERATOR_KEY",
      `${keyName} contains surrounding whitespace or a newline.`,
    );
  return base;
}
