/** Explicit allowlists, never error messages, stacks, bodies, headers or URLs. */
export const categories = new Set([
  "booking_failed", "calendar_unavailable", "unknown_answer_followup_failed",
  "human_escalation_failed", "transfer_failed", "transfer_state", "recording_access_failed",
  "webhook_failed", "authentication_failed", "authorization_denied", "system_unavailable",
  "database_error", "provider_error", "internal_error", "human_escalation_saved", "unknown_answer_saved",
]);
const components = new Set(["clinic-operations", "book-appointment", "check-availability", "retell-webhook",
  "recording-access", "manage-clinic-users", "provision-clinic-user", "database", "portal", "portal-server"]);
const dependencies = new Set(["database_error", "provider_error", "internal_error", "timeout", "invalid_response",
  "dependency_unreachable", "previous_calendar_failure", "transport_failure", "database_unavailable",
  "backend_unavailable", "configuration_unavailable", "integration_unavailable", "authentication", "authorization"]);
const reasons = new Set(["database_error", "booking_timeout", "booking_exception", "booking_invalid_response",
  "follow_up_lookup_failed", "slot_conflict", "stale_or_invalid_slot", "slot_not_checked", "past_or_invalid_slot",
  "patient_mismatch", "invalid_request", "staff_not_found", "outside_working_hours", "staff_time_off", "service_mismatch"]);
const transfers = new Set(["success", "pending", "no_destination", "after_hours", "no_answer", "busy", "timeout", "provider_error"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeOperationalEvent(category: string, component: string, metadata: Record<string, unknown> = {}) {
  const event: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    category: categories.has(category) ? category : "internal_error",
    component: components.has(component) ? component : "portal-server",
    state: metadata["state"] === "success" ? "success" : "failure",
  };
  for (const key of ["clinic_id", "request_id", "conversation_id", "follow_up_request_id"]) {
    const value = metadata[key];
    if (typeof value === "string" && uuid.test(value)) event[key] = value;
  }
  // Retell's opaque call IDs only. Reject phone numbers and arbitrary free text.
  if (typeof metadata["call_id"] === "string" && /^call_[A-Za-z0-9_-]{1,120}$/.test(metadata["call_id"])) event["call_id"] = metadata["call_id"];
  for (const [key, allowed] of [["dependency_category", dependencies], ["reason", reasons], ["transfer_result", transfers]] as const) {
    if (typeof metadata[key] === "string" && allowed.has(metadata[key] as string)) event[key] = metadata[key];
  }
  for (const key of ["follow_up_saved", "transfer_attempted", "fallback_escalation_saved", "fallback_response_returned"]) {
    if (typeof metadata[key] === "boolean") event[key] = metadata[key];
  }
  if (typeof metadata["status"] === "number" && Number.isInteger(metadata["status"]) && metadata["status"] >= 400 && metadata["status"] <= 599) event["status"] = metadata["status"];
  if (typeof metadata["database_code"] === "string" && /^[0-9][A-Z0-9]{4}$/.test(metadata["database_code"])) event["database_code"] = metadata["database_code"];
  return event;
}

export function operationalLog(category: string, component: string, metadata: Record<string, unknown> = {}) {
  try {
    const event = safeOperationalEvent(category, component, metadata);
    const emit = event["state"] === "success" ? console.info : console.error;
    emit(JSON.stringify(event));
  } catch { /* Monitoring failure must never change patient-facing behavior. */ }
}

type Context = { clinic_id?: string; call_id?: string; conversation_id?: string; dependency_category?: string };
const contexts = new WeakMap<Request, Context>();
/** Supply only identity established by authentication and ownership checks. */
export function setOperationalContext(req: Request, context: Context) {
  contexts.set(req, { ...contexts.get(req), ...context });
}

/** One boundary event for HTTP/security failures. Specific fallback helpers log 200 failures. */
export function monitorHandler(component: string, handler: (req: Request, ...args: any[]) => Promise<Response> | Response) {
  return async (req: Request, ...args: any[]): Promise<Response> => {
    const requestId = crypto.randomUUID(); // Never accept a caller's correlation header as log text.
    try {
      const response = await handler(req, ...args);
      if (response.status === 401 || response.status === 403 || response.status >= 500 || (component === "recording-access" && response.status === 404)) {
        const context = contexts.get(req) ?? {};
        const category = response.status === 401 ? "authentication_failed" : response.status === 403 ? "authorization_denied" :
          component === "retell-webhook" ? "webhook_failed" : component === "recording-access" ? "recording_access_failed" :
          component === "book-appointment" ? "booking_failed" : component === "check-availability" ? "calendar_unavailable" : "internal_error";
        operationalLog(category, component, { ...context, request_id: requestId, status: response.status,
          dependency_category: response.status === 401 ? "authentication" : response.status === 403 ? "authorization" : context.dependency_category ?? "internal_error" });
      }
      return response;
    } catch {
      operationalLog(component === "retell-webhook" ? "webhook_failed" : component === "recording-access" ? "recording_access_failed" : component === "book-appointment" ? "booking_failed" : component === "check-availability" ? "calendar_unavailable" : "internal_error",
        component, { ...contexts.get(req), request_id: requestId, dependency_category: "internal_error", status: 500 });
      return new Response("Internal server error", { status: 500, headers: { "cache-control": "no-store" } });
    } finally { contexts.delete(req); }
  };
}
