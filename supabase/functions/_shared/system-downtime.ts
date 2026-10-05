import { operationalLog } from "./operational-log.ts";
// This boundary runs only when a wider failure escaped the existing specific fallbacks.
export type DowntimeDependency = "backend_unavailable" | "database_unavailable" | "configuration_unavailable" | "provider_unavailable" | "internal_error";
export class SystemUnavailableError extends Error {
  dependency: DowntimeDependency;
  constructor(dependency: DowntimeDependency) { super("system_unavailable"); this.dependency = dependency; }
}
export const DOWNTIME_MESSAGE = "I’m sorry, the clinic’s automated system is temporarily unavailable right now. Please contact the clinic directly.";

export function trustedContact(value: unknown): string | null {
  if (typeof value !== "string" || !/^[+\d ()-]{6,50}$/.test(value)) return null;
  const number = value.replace(/[ ()-]/g, "");
  return /^\+?[1-9]\d{5,14}$/.test(number) ? number : null;
}

export function downtimeResult(contact: string | null = null) {
  const number = trustedContact(contact);
  return { apero_response_received: true, system_unavailable: true, success: false,
    available: false, requested_time_available: false, appointment_booked: false,
    appointment_id: null, appointments: [], count: 0, slots: [], resolved: false,
    follow_up_saved: false, follow_up_request_id: null, request_id: null,
    transfer_allowed: false, transfer_destination: null, availability_invalidated: false,
    error_type: "system_unavailable", category: "system_unavailable",
    message: DOWNTIME_MESSAGE + (number ? ` You can reach the clinic at ${number}.` : ""),
    patient_instruction: "State temporary unavailability. No operation or follow-up is confirmed by this response. An earlier interrupted operation may have completed: do not claim it failed or succeeded. Do not retry. Contact the clinic directly.",
  };
}

export async function downtimeResponse(input: {clinicId?: string | null; callId?: string | null; dependency: DowntimeDependency; db?: any}): Promise<Response> {
  let number: string | null = null;
  // Only after signed routing AND call ownership validation, and only when the DB
  // was not the failing dependency. One bounded read; no retry or attempted write.
  if (input.db && input.clinicId && input.callId && input.dependency === "internal_error") {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result: any = await Promise.race([
        input.db.from("clinics").select("phone,fallback_phone").eq("id",input.clinicId).single().abortSignal(controller.signal),
        new Promise((_,reject) => {timer=setTimeout(()=>{controller.abort();reject(new Error());},500);}),
      ]);
      if (!result.error) number = trustedContact(result.data?.fallback_phone) ?? trustedContact(result.data?.phone);
    } catch { /* Generic contact wording remains safe. */ }
    finally { clearTimeout(timer); }
  }
  const response = Response.json(downtimeResult(number));
  operationalLog("system_unavailable", "clinic-operations", {clinic_id:input.clinicId,call_id:input.callId,
    dependency_category:input.dependency,fallback_response_returned:true});
  return response;
}

/** Catch runtime/bootstrap exceptions without changing authentication or specific results.
 * Receipt is set only on a nonempty JSON result. Retell resets it before every tool.
 * If the runtime/backend never answers, Retell's timeout takes the same terminal path.
 */
export function downtimeBoundary(handler: (req: Request, ...args: any[]) => Promise<Response>) {
  return async (req: Request, ...args: any[]): Promise<Response> => {
    try {
      const response = await handler(req,...args);
      if (!response.ok || response.status === 204) return response;
      const body = await response.clone().json();
      if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).length)
        return downtimeResponse({dependency:"internal_error"});
      return Response.json({...body,apero_response_received:true,system_unavailable:body.system_unavailable === true},
        {status:response.status,headers:response.headers});
    } catch { return downtimeResponse({dependency:"backend_unavailable"}); }
  };
}
