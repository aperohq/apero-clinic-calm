import { operationalLog } from "./operational-log.ts";
// Invoked only after signed integration and call ownership validation.
export type CalendarDetails = {
  clinicId: string; callId: string; patientName: string; patientPhone: string;
  service: string; practitioner: string; date: string; time: string;
};
export const CALENDAR_MESSAGE = "I’m sorry, I can’t access the clinic’s availability right now. I can take your preferred date and time so the clinic can follow up with you.";
const clean = (s: string) => s.replace(/\p{Cc}/gu, " ").trim().slice(0, 300);
class CalendarTimeout extends Error {}
export class InvalidAvailability extends Error {}
export async function calendarDeadline<T>(work: (signal: AbortSignal) => PromiseLike<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new CalendarTimeout());
      }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
// Bind every query in the existing discovery operation to the same deadline.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function abortableDatabase(db: any, signal: AbortSignal): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (object: any): any => new Proxy(object, {
    get(target, key) {
      if (key === "then") {
        if (signal.aborted) return (resolve: unknown, reject: (error: unknown) => void) => reject(new CalendarTimeout());
        const query = typeof target.abortSignal === "function" ? target.abortSignal(signal) : target;
        return query.then.bind(query);
      }
      const member = target[key];
      return typeof member === "function" ? (...args: unknown[]) => {
        if (signal.aborted) throw new CalendarTimeout();
        const next = member.apply(target, args);
        return next && typeof next === "object" ? wrap(next) : next;
      } : member;
    },
  });
  return wrap(db);
}
export function validateRanges(data: unknown): asserts data is Array<{start_time: string; end_time: string; duration_minutes: number}> {
  if (!Array.isArray(data)) throw new InvalidAvailability();
  for (const row of data) {
    if (!row || typeof row !== "object" || typeof row.start_time !== "string" || typeof row.end_time !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.start_time) ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.end_time) ||
      !Number.isFinite(Date.parse(row.start_time)) || !Number.isFinite(Date.parse(row.end_time)) ||
      !Number.isInteger(row.duration_minutes) || row.duration_minutes < 1 || row.duration_minutes > 1440 ||
      Date.parse(row.end_time) - Date.parse(row.start_time) !== row.duration_minutes * 60000)
      throw new InvalidAvailability();
  }
}
const domainErrors = new Set(["service_not_found", "service_ambiguous", "practitioner_not_found", "practitioner_ambiguous",
  "practitioner_preference_missing", "practitioner_missing", "practitioner_mode_mismatch", "service_mismatch",
  "invalid_patient_or_phone", "appointment_not_found", "patient_mismatch", "practitioner_mismatch", "invalid_date", "past_or_invalid_date", "invalid_time"]);
const dependencyCategory = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  return error instanceof CalendarTimeout || code === "57014" ? "timeout" :
    error instanceof InvalidAvailability ? "invalid_response" : code ? "database_error" : "dependency_unreachable";
};
export function calendarFailure(category: string, saved = false, id: string | null = null, status = "Open", needsDetails = false) {
  return { success: false, available: false, availability_checked: false, slots: [], requested_time_available: null,
    appointment_booked: false, appointment_confirmed: false, appointment_id: null,
    error_type: "calendar_unavailable", failure_category: "calendar_unavailable", dependency_category: category,
    retry_allowed: false, message: CALENDAR_MESSAGE, follow_up_saved: saved, follow_up_request_id: id,
    follow_up_status: saved ? status : "not_saved", follow_up_needs_details: needsDetails,
    patient_instruction: "No appointment is confirmed. " + (saved
      ? "Your preferences were saved for clinic follow-up. Clinic staff must verify the real schedule before confirming anything."
      : needsDetails ? "Collect patient name, phone, service and preferred date/time, then save using calendar_follow_up. Do not retry availability or book."
      : "The follow-up request could not be saved. Please contact the clinic directly. Do not promise staff received it.") };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function retain(db: any, details: CalendarDetails, category: string, ms: number) {
  let id: string | null = null, status = "Open";
  const enough = [details.patientName, details.patientPhone, details.service, details.date, details.time].every(s => !!clean(s));
  try {
    const key = `calendar-unavailable:${details.clinicId}:${details.callId}`;
    const result = await calendarDeadline(async signal => {
      const prior = await db.from("voice_requests").select("id,status").eq("clinic_id", details.clinicId).eq("request_key", key).maybeSingle().abortSignal(signal);
      if (prior.error || prior.data || !enough) return prior;
      const saved = await db.from("voice_requests").insert({ clinic_id: details.clinicId, call_id: details.callId,
        request_key: key, kind: "message", patient_name: clean(details.patientName), phone: clean(details.patientPhone),
        reason: ["Calendar unavailable — follow-up", "Failure category: calendar_unavailable",
          `Requested service: ${clean(details.service)}`, `Preferred date/time: ${clean(details.date)} ${clean(details.time)}`,
          `Preferred practitioner: ${clean(details.practitioner) || "No preference"}`, `Failure timestamp: ${new Date().toISOString()}`,
          "No appointment is confirmed. Staff must verify the real schedule before confirming anything. Do not automatically retry availability."].join("\n"), status: "Open" }).select("id,status").single().abortSignal(signal);
      if (saved.error?.code === "23505") return db.from("voice_requests").select("id,status").eq("clinic_id", details.clinicId).eq("request_key", key).single().abortSignal(signal);
      return saved;
    }, ms);
    if (!result.error && result.data?.id) { id = result.data.id; status = result.data.status; }
  } catch { /* No raw dependency output or patient details in logs. */ }
  operationalLog("calendar_unavailable", "clinic-operations", { clinic_id: details.clinicId, call_id: details.callId,
    dependency_category: category, follow_up_saved: !!id });
  return calendarFailure(category, !!id, id, status, !enough && !id);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function calendarBlocked(db: any, details: CalendarDetails, ms = 3000, failOnError = true) {
  try {
    const state = await calendarDeadline<{data: {calendar_unavailable: boolean} | null; error: unknown}>(signal => db.from("voice_call_state").select("calendar_unavailable")
      .eq("clinic_id", details.clinicId).eq("call_id", details.callId).maybeSingle().abortSignal(signal), ms);
    if (state.error) throw state.error;
    return state.data?.calendar_unavailable === true ? calendarFailure("previous_calendar_failure") : null;
  } catch (error) { return failOnError ? calendarFailure(dependencyCategory(error)) : null; }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function calendarFollowUp(db: any, details: CalendarDetails, ms = 3000) {
  const blocked = await calendarBlocked(db, details, ms);
  try {
    await calendarDeadline(signal => db.from("voice_call_state").upsert({call_id: details.callId, clinic_id: details.clinicId,
      current_check_id: null, calendar_unavailable: true, updated_at: new Date().toISOString()}, {onConflict: "call_id"}).abortSignal(signal), ms);
  } catch { /* Keep the patient response safe even when retention is unavailable. */ }
  return retain(db, details, blocked?.dependency_category ?? "transport_failure", ms);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function availabilityWithFallback(db: any, details: CalendarDetails,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  discover: (db: any) => PromiseLike<unknown>, limits = { availabilityMs: 6000, followUpMs: 2000 }) {
  let category: string;
  const blocked = await calendarBlocked(db, details, limits.followUpMs);
  if (blocked) category = blocked.dependency_category;
  else {
    try {
      const result = await calendarDeadline(signal => discover(abortableDatabase(db, signal)), limits.availabilityMs);
      if (!result || typeof result !== "object" || !("success" in result) || typeof result.success !== "boolean") throw new InvalidAvailability();
      if (result.success === true && (!("slots" in result) || !Array.isArray(result.slots) || !("available" in result) || typeof result.available !== "boolean" || result.available !== (result.slots.length > 0))) throw new InvalidAvailability();
      if (result.success === false && (!("error_type" in result) || typeof result.error_type !== "string")) throw new InvalidAvailability();
      if (result.success === true && "slots" in result && Array.isArray(result.slots) && result.slots.some(slot =>
        !slot || typeof slot !== "object" || typeof slot.slot_id !== "string" || !slot.slot_id ||
        typeof slot.practitioner_id !== "string" || !slot.practitioner_id ||
        typeof slot.service_name !== "string" || !slot.service_name ||
        typeof slot.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(slot.date) ||
        typeof slot.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time))) throw new InvalidAvailability();
      // Expected input/domain errors keep their existing behavior. Dependency errors fail closed.
      if (result.success === false && "error_type" in result) {
        if (result.error_type === "database_error") throw {code: "database_error"};
        if (result.error_type === "timeout") throw {code: "57014"};
        if (result.error_type === "tool_error") throw new Error();
        if (!domainErrors.has(String(result.error_type))) throw new InvalidAvailability();
      }
      return result;
    } catch (error) { category = dependencyCategory(error); }
  }
  try {
    await calendarDeadline(signal => db.from("voice_call_state").upsert({call_id: details.callId, clinic_id: details.clinicId,
      current_check_id: null, calendar_unavailable: true, updated_at: new Date().toISOString()}, {onConflict: "call_id"}).abortSignal(signal), limits.followUpMs);
  } catch { /* Complete database outage: AI still receives a no-retry result. */ }
  return retain(db, details, category, limits.followUpMs);
}
