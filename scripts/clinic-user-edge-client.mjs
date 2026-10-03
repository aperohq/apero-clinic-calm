// Deprecated Edge transport; retained for existing regression coverage.
// Production operators use the direct Node CLI.
import {
  parseClinicUserRequest,
  ClinicUserProvisionError,
} from "../src/lib/clinic-users.server.ts";

import {
  ProvisionDiagnosticError,
  validateOperatorEnvironment,
} from "./clinic-user-operator-config.mjs";

const safeMessages = new Set([
  "Unauthorized",
  "Operator server requests only",
  "Method not allowed",
  "Expected application/json",
  "Portal configuration unavailable",
  "Request too large",
  "Invalid provisioning input",
  "Invalid or oversized request body",
  "Clinic not found or could not be verified.",
  "Invitation could not be generated. Existing accounts require explicit association.",
  "Existing verified Auth account does not match the supplied identity.",
  "Profile could not be verified; invitation was withheld.",
  "Profile creation failed; invitation was withheld. Inspect this Auth account before retrying.",
  "Account is linked elsewhere or membership could not be verified; no reassignment was performed.",
  "Provisioning failed; inspect the account before retrying",
]);
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function provisionThroughEdge(input, supabaseUrl, operatorKey, fetcher = fetch) {
  const request = parseClinicUserRequest(input);
  const base = validateOperatorEnvironment(supabaseUrl, operatorKey);
  let response;
  try {
    response = await fetcher(`${base.origin}/functions/v1/provision-clinic-user`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { apikey: operatorKey, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    const timedOut = ["TimeoutError", "AbortError"].includes(error?.name);
    throw new ProvisionDiagnosticError(
      timedOut ? "EDGE_TIMEOUT" : "EDGE_NETWORK_ERROR",
      "No HTTP response received. Check connectivity and project URL; inspect Auth/profile state before retrying because the request may have executed.",
      { endpoint: "unconfirmed (request attempted)" },
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new ProvisionDiagnosticError(
      "EDGE_NON_JSON_RESPONSE",
      "Edge returned an unreadable/non-JSON response. Inspect gateway/function logs and Auth/profile state before retrying.",
      {
        status: response.status,
        endpoint: "HTTP response received; handler execution unconfirmed",
      },
    );
  }
  if (!response.ok) {
    // Do not trust response text for logging; invitation/provider bodies could
    // contain secrets. Keep the recovery UUID if it is syntactically valid.
    const detail = safeMessages.has(result?.error)
      ? result.error
      : "Unrecognized response message withheld; inspect function logs.";
    throw new ProvisionDiagnosticError(
      "EDGE_HTTP_ERROR",
      `Edge provisioning failed: ${detail}${response.status === 401 ? " Use a project sb_secret_ key from the function runtime SUPABASE_SECRET_KEYS; user JWTs and publishable keys are not accepted." : ""}`,
      {
        status: response.status,
        endpoint: "HTTP response received; handler execution unconfirmed",
        authUserId: uuid(result?.authUserId) ? result.authUserId : null,
      },
    );
  }
  if (
    result?.clinicId !== request.clinicId ||
    !uuid(result?.authUserId) ||
    !uuid(result?.profileId) ||
    (request.mode === "invite"
      ? typeof result.invitationUrl !== "string" || !result.invitationUrl
      : result.invitationUrl !== null)
  )
    throw new ProvisionDiagnosticError(
      "EDGE_INVALID_RESPONSE",
      "Membership response failed validation; invitation withheld. Inspect Auth/profile state before retrying.",
      { status: response.status, endpoint: "HTTP response received" },
    );
  return result;
}
