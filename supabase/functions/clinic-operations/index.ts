import {
  operationalLog,
  monitorHandler,
  setOperationalContext,
} from "../_shared/operational-log.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { resolveVoiceIntegration } from "../_shared/voice-integration.ts";
import {
  downtimeBoundary,
  downtimeResponse,
  SystemUnavailableError,
} from "../_shared/system-downtime.ts";
import { readLimitedBody, RequestBodyTooLargeError } from "../_shared/request-security.ts";
import { DateTime } from "npm:luxon@3";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Slot discovery and booking validation share the database appointment rules.

const encoder = new TextEncoder();
type Slot = {
  slot_id: string;
  checked_slot_id: string;
  start_time: string;
  end_time: string;
  practitioner_id: string;
  practitioner_name: string;
  service_name: string;
  date: string;
  time: string;
  duration_minutes: number;
  timezone: string;
};

import {
  resolveStaff,
  resolveService,
  phone as normalizePhone,
  value,
  type Staff,
} from "./logic.ts";
import { loadResolutionInputs } from "./resolution-inputs.ts";
import {
  availabilityWithFallback,
  calendarFollowUp,
  calendarBlocked,
  calendarDeadline,
  calendarFailure,
  validateRanges,
} from "../_shared/calendar-fallback.ts";
import {
  transferGate,
  transferFallback,
  observeTransferFallback,
  transferBlocked,
  transferLog,
  TRANSFER_FAILED_UNSAVED,
} from "../_shared/call-transfer.ts";
import {
  humanEscalationFollowUp,
  humanEscalationResult,
  isHumanCategory,
} from "../_shared/human-escalation.ts";
import { unknownAnswerFollowUp, unknownAnswerResult } from "../_shared/unknown-answer.ts";
import { bookingWithFallback } from "../_shared/booking-fallback.ts";
import { checkCallOwnership } from "./call-ownership.ts";
import { createPerformanceTiming, type TimingPhase } from "./performance-timing.ts";

function failure(error_type: string, message = error_type) {
  return {
    success: false,
    available: false,
    appointment_booked: false,
    appointment_id: null,
    error_type,
    message,
  };
}
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
function base64ToBytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
async function sign(text: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
}
async function tokenFor(
  clinicId: string,
  staff: Staff,
  service: string,
  start: DateTime,
  secret: string,
  callId: string,
  checkId: string,
  slotId: string,
  minutes: number,
): Promise<string> {
  const body = bytesToBase64(
    encoder.encode(
      JSON.stringify({
        c: clinicId,
        s: staff.id,
        v: service,
        t: start.toUTC().toISO(),
        e: Date.now() + 10 * 60_000,
        k: callId,
        i: checkId,
        q: slotId,
        m: minutes,
      }),
    ),
  );
  return `${body}.${await sign(body, secret)}`;
}
async function readToken(
  token: string,
  secret: string,
  clinicId: string,
): Promise<{
  c: string;
  s: string;
  v: string;
  t: string;
  e: number;
  k: string;
  i: string;
  q: string;
  m?: number;
} | null> {
  try {
    const [body, mac] = token.split(".");
    if (!body || !mac || mac !== (await sign(body, secret))) return null;
    const data = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
    if (
      (data.m !== undefined && (!Number.isInteger(data.m) || data.m < 1 || data.m > 1440)) ||
      data.c !== clinicId ||
      typeof data.e !== "number" ||
      data.e < Date.now()
    )
      return null;
    return data;
  } catch {
    return null;
  }
}
async function operationKey(action: string, token: string, appointmentId = ""): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`${action}:${appointmentId}:${token}`)),
  );
  return bytesToBase64(hash);
}
async function loadTimezone(db: SupabaseClient, clinicId: string): Promise<string> {
  const { data, error } = await db.from("clinics").select("timezone").eq("id", clinicId).single();
  if (error || !data || typeof data.timezone !== "string")
    throw new SystemUnavailableError("configuration_unavailable");
  return data.timezone;
}
async function availableSlots(
  db: SupabaseClient,
  clinicId: string,
  staff: Staff[],
  service: string,
  date: string,
  timezone: string,
  secret: string,
  callId: string,
  checkId: string,
  excludeId: string | undefined,
  timing: ReturnType<typeof createPerformanceTiming>,
  days = 1,
  windowStart = "",
  windowEnd = "",
  requestedTime = "",
): Promise<Slot[]> {
  if (!staff.length) return [];
  const { data: ranges, error } = await timing.run<{
    data: Array<{
      staff_id: string;
      start_time: string;
      end_time: string;
      duration_minutes: number;
    }> | null;
    error: unknown;
  }>(
    "schedule_reads",
    () =>
      db.rpc("appointment_search_slots", {
        p_clinic_id: clinicId,
        p_staff_ids: staff.map((person) => person.id),
        p_service: service,
        p_date: date,
        p_days: days,
        p_window_start: windowStart || null,
        p_window_end: windowEnd || null,
        p_exclude_id: excludeId ?? null,
        p_requested_time: requestedTime || null,
      }),
    (result) => !result.error,
  );
  if (error) throw error;
  validateRanges(ranges);
  const slots: Slot[] = [];
  const generationStart = performance.now();
  for (const range of ranges ?? []) {
    const person = staff.find((person) => person.id === range.staff_id);
    if (!person) throw new Error("Unexpected availability practitioner");
    const start = DateTime.fromISO(range.start_time, { zone: timezone });
    const checkedSlotId = crypto.randomUUID();
    slots.push({
      slot_id: await tokenFor(
        clinicId,
        person,
        service,
        start,
        secret,
        callId,
        checkId,
        checkedSlotId,
        range.duration_minutes,
      ),
      checked_slot_id: checkedSlotId,
      start_time: range.start_time,
      end_time: range.end_time,
      practitioner_id: person.id,
      practitioner_name: person.full_name,
      service_name: service,
      date: start.toFormat("yyyy-MM-dd"),
      time: start.toFormat("HH:mm"),
      duration_minutes: range.duration_minutes,
      timezone,
    });
  }
  timing.mark("slot_generation", performance.now() - generationStart, "success");
  return slots.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

export default {
  fetch: monitorHandler(
    "clinic-operations",
    downtimeBoundary(
      withSupabase({ auth: "none" }, async (req, ctx) => {
        const timing = createPerformanceTiming();
        let outcome: "success" | "failure" = "success";
        const json = (body: unknown, init?: ResponseInit) => {
          if (body && typeof body === "object" && "success" in body && body.success === false)
            outcome = "failure";
          return timing.runSync("response_serialization", () => Response.json(body, init));
        };
        try {
          if (req.method !== "POST") {
            outcome = "failure";
            return new Response("Method not allowed", { status: 405 });
          }
          let raw: string;
          try {
            raw = await timing.run("request_parse", () => readLimitedBody(req, 128 * 1024));
          } catch (error) {
            outcome = "failure";
            return new Response("Request body too large", {
              status: error instanceof RequestBodyTooLargeError ? 413 : 400,
            });
          }
          let identity;
          try {
            identity = await resolveVoiceIntegration(
              ctx.supabaseAdmin,
              raw,
              req.headers.get("x-retell-signature"),
              (phase: TimingPhase, elapsed, category) => timing.mark(phase, elapsed, category),
            );
          } catch (error) {
            outcome = "failure";
            throw error;
          }
          if (!identity) {
            outcome = "failure";
            return new Response("Unauthorized", { status: 401 });
          }
          const { secret } = identity;
          const clinicId = identity.integration.clinic_id;
          setOperationalContext(req, { clinic_id: clinicId });
          const phone = (input: unknown) =>
            normalizePhone(
              input,
              identity.integration.dialing_prefix,
              identity.integration.local_number_length,
            );
          let trustedCallId: string | null = null;
          try {
            const payload = timing.runSync("request_parse", () => JSON.parse(raw));
            const args: Record<string, unknown> = payload.args ?? payload;
            const action = value(args, "action");
            timing.setAction(action);
            const callId =
              typeof payload.call?.call_id === "string"
                ? payload.call.call_id
                : ["human_escalation", "transfer_gate", "transfer_fallback"].includes(action)
                  ? null
                  : value(args, "call_id") || null;
            const db = ctx.supabaseAdmin;
            if (!callId) return json(failure("missing_call_id"));
            try {
              if (
                !(await (action === "availability" ||
                action === "unknown_answer_follow_up" ||
                action === "human_escalation" ||
                action === "transfer_gate" ||
                action === "transfer_fallback"
                  ? calendarDeadline(() => checkCallOwnership(db, callId, clinicId, timing), 3000)
                  : checkCallOwnership(db, callId, clinicId, timing)))
              )
                return json(failure("call_clinic_mismatch"), { status: 403 });
            } catch {
              if (action === "transfer_gate" || action === "transfer_fallback") {
                transferLog(clinicId, callId, false, "provider_error", false);
                return json({
                  ...transferBlocked(),
                  follow_up_saved: false,
                  message: TRANSFER_FAILED_UNSAVED,
                });
              }
              if (action === "human_escalation") {
                operationalLog("human_escalation_failed", "clinic-operations", {
                  clinic_id: clinicId,
                  dependency_category: "database_error",
                  follow_up_saved: false,
                });
                return json(humanEscalationResult(false, null, "not_saved"));
              }
              if (action === "unknown_answer_follow_up") {
                operationalLog("unknown_answer_followup_failed", "clinic-operations", {
                  clinic_id: clinicId,
                  dependency_category: "database_error",
                  follow_up_saved: false,
                });
                return json(unknownAnswerResult(false, null, "not_saved"));
              }
              if (action === "availability") {
                operationalLog("calendar_unavailable", "clinic-operations", {
                  clinic_id: clinicId,
                  dependency_category: "database_error",
                  follow_up_saved: false,
                });
                return json(calendarFailure("database_error"));
              }
              throw new SystemUnavailableError("database_unavailable");
            }
            trustedCallId = callId;
            setOperationalContext(req, { call_id: callId });
            if (action === "transfer_gate" || action === "transfer_fallback") {
              try {
                const existing = (await calendarDeadline(
                  (signal) =>
                    db
                      .from("conversations")
                      .select("clinic_id")
                      .eq("retell_call_id", callId)
                      .maybeSingle()
                      .abortSignal(signal),
                  3000,
                )) as { data: { clinic_id: string } | null; error: unknown };
                if (existing.error) throw new Error();
                if (existing.data && existing.data.clinic_id !== clinicId)
                  return json(failure("call_clinic_mismatch"), { status: 403 });
              } catch {
                transferLog(clinicId, callId, false, "provider_error", false);
                return json({
                  ...transferBlocked(),
                  follow_up_saved: false,
                  message: TRANSFER_FAILED_UNSAVED,
                });
              }
              if (action === "transfer_gate")
                return json(
                  await transferGate(db, {
                    clinicId,
                    callId,
                    category: value(args, "escalation_category"),
                    explicitHuman: args.explicit_human_request === true,
                    liveAppropriate: args.live_transfer_appropriate === true,
                    callType: payload.call?.call_type ?? "",
                    inboundNumber:
                      payload.call?.direction === "inbound" ? (payload.call?.to_number ?? "") : "",
                  }),
                );
              return json(
                await transferFallback(db, {
                  clinicId,
                  callId,
                  name: value(args, "patient_name"),
                  phone: phone(args.caller_phone) || "",
                }),
              );
            }
            if (action === "human_escalation") {
              const result = await humanEscalationFollowUp(db, {
                clinicId,
                callId,
                requested: args.escalation_required === true,
                category: value(args, "escalation_category"),
                reason: value(args, "reason"),
                name: value(args, "patient_name"),
                phone: phone(args.caller_phone) || "",
              });
              await observeTransferFallback(db, { clinicId, callId }, result.follow_up_saved);
              return json(result);
            }
            if (action === "unknown_answer_follow_up")
              return json(
                await unknownAnswerFollowUp(db, {
                  clinicId,
                  callId,
                  requested: args.follow_up_requested === true,
                  question: value(args, "question"),
                  name: value(args, "patient_name") || value(args, "caller_name"),
                  phone: phone(args.caller_phone) || "",
                }),
              );
            if (action === "invalidate") {
              const { error } = await timing.run<{ error: unknown }>(
                "action_setup",
                () =>
                  db.from("voice_call_state").upsert(
                    {
                      call_id: callId,
                      clinic_id: clinicId,
                      current_check_id: null,
                      updated_at: new Date().toISOString(),
                    },
                    { onConflict: "call_id" },
                  ),
                (result) => !result.error,
              );
              if (error) throw error;
              return json({ success: true, availability_invalidated: true });
            }
            const calendarDetails = {
              clinicId,
              callId,
              patientName:
                value(args, "client_name") ||
                value(args, "patient_name") ||
                value(args, "caller_name"),
              patientPhone: phone(args.client_phone) || phone(args.caller_phone) || "",
              service: value(args, "service_name"),
              practitioner: value(args, "practitioner_name") || value(args, "practitioner_id"),
              date: value(args, "requested_date"),
              time:
                value(args, "requested_time") ||
                [value(args, "window_start"), value(args, "window_end")].filter(Boolean).join("–"),
            };
            if (action === "calendar_follow_up")
              return json(await calendarFollowUp(db, calendarDetails));
            if (action === "book" || action === "reschedule") {
              const blocked = await calendarBlocked(db, calendarDetails, 3000, false);
              if (blocked) return json(blocked);
            }
            if (action === "resolve" || action === "availability") {
              const run = async (db: SupabaseClient) => {
                const json = (body: unknown) => body;
                const checkId = crypto.randomUUID();
                const { error: resetError } = await timing.run<{ error: unknown }>(
                  "action_setup",
                  () =>
                    db.from("voice_call_state").upsert(
                      {
                        call_id: callId,
                        clinic_id: clinicId,
                        current_check_id: action === "availability" ? checkId : null,
                        updated_at: new Date().toISOString(),
                      },
                      { onConflict: "call_id" },
                    ),
                  (result) => !result.error,
                );
                if (resetError) throw resetError;
                const { staff, aliases } = await loadResolutionInputs(db, clinicId, timing);
                const serviceResult = timing.runSync(
                  "service_resolution",
                  () => resolveService(staff, value(args, "service_name"), aliases),
                  (result) => result.status === "resolved",
                );
                if (serviceResult.status !== "resolved")
                  return json({
                    ...failure(`service_${serviceResult.status}`),
                    service_candidates: serviceResult.candidates ?? [],
                  });
                const service = serviceResult.service!;
                const qualified = staff.filter((s) => s.services.includes(service));
                const requestedName = value(args, "practitioner_name");
                const requestedId = value(args, "practitioner_id");
                if (action === "availability") {
                  const mode = value(args, "practitioner_mode");
                  if (mode !== "specific" && mode !== "any")
                    return json(failure("practitioner_preference_missing"));
                  if (mode === "specific" && !requestedName && !requestedId)
                    return json(failure("practitioner_missing"));
                  if (mode === "any" && (requestedName || requestedId))
                    return json(failure("practitioner_mode_mismatch"));
                }
                let selected = qualified;
                if (requestedName || requestedId) {
                  const result = timing.runSync(
                    "practitioner_resolution",
                    () =>
                      requestedId
                        ? {
                            status: staff.some((s) => s.id === requestedId)
                              ? "resolved"
                              : "not_found",
                            practitioner: staff.find((s) => s.id === requestedId),
                          }
                        : resolveStaff(staff, requestedName),
                    (result) => result.status === "resolved",
                  );
                  if (result.status !== "resolved" || !result.practitioner)
                    return json({
                      ...failure(`practitioner_${result.status}`),
                      practitioner_found: false,
                      practitioner_candidates: result.candidates ?? [],
                    });
                  if (!qualified.some((s) => s.id === result.practitioner!.id))
                    return json({
                      ...failure("service_mismatch"),
                      practitioner_found: true,
                      service_supported: false,
                      qualified_practitioners: qualified.map((s) => ({
                        id: s.id,
                        name: s.full_name,
                      })),
                    });
                  selected = [result.practitioner];
                }
                const base = {
                  success: true,
                  service_name: service,
                  service_supported: true,
                  practitioner_found: true,
                  qualified_practitioners: qualified.map((s) => ({
                    id: s.id,
                    name: s.full_name,
                    specialty: s.specialty,
                  })),
                  selected_practitioner_id: selected.length === 1 ? selected[0].id : null,
                  selected_practitioner_name: selected.length === 1 ? selected[0].full_name : null,
                };
                if (action === "resolve")
                  return json({
                    ...base,
                    selected_practitioner: selected.length === 1 ? selected[0] : null,
                  });
                const timezone = await loadTimezone(db, clinicId);
                let excludeAppointmentId: string | undefined;
                const existingId = value(args, "appointment_id");
                if (existingId) {
                  const patientName = value(args, "client_name");
                  const patientPhone = phone(args.client_phone);
                  if (!patientName || !patientPhone)
                    return json(failure("invalid_patient_or_phone"));
                  const { data: existing, error: existingError } = await db
                    .from("appointments")
                    .select("id,client_id,start_time,staff_id,service")
                    .eq("id", existingId)
                    .eq("clinic_id", clinicId)
                    .neq("status", "Cancelled")
                    .maybeSingle();
                  if (existingError) throw existingError;
                  if (!existing || DateTime.fromISO(existing.start_time) <= DateTime.now())
                    return json(failure("appointment_not_found"));
                  const { data: patient, error: patientError } = await db
                    .from("clients")
                    .select("full_name,phone")
                    .eq("id", existing.client_id)
                    .eq("clinic_id", clinicId)
                    .maybeSingle();
                  if (patientError) throw patientError;
                  if (
                    !patient ||
                    patient.full_name.trim().toLowerCase() !== patientName.toLowerCase() ||
                    phone(patient.phone) !== patientPhone
                  )
                    return json(failure("patient_mismatch"));
                  if (existing.service !== service) return json(failure("service_mismatch"));
                  // Keep the selected eligible practitioner; the voice RPC validates the new slot.
                  if (!selected.length) return json(failure("practitioner_mismatch"));
                  base.selected_practitioner_id = selected[0]!.id;
                  base.selected_practitioner_name = selected[0]!.full_name;
                  excludeAppointmentId = existing.id;
                }
                const requestedDate = value(args, "requested_date");
                const earliest = value(args, "search_mode") === "earliest";
                if (!earliest && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate))
                  return json(failure("invalid_date"));
                const first = earliest
                  ? DateTime.now().setZone(timezone).startOf("day")
                  : DateTime.fromFormat(requestedDate, "yyyy-MM-dd", { zone: timezone });
                if (!first.isValid || first < DateTime.now().setZone(timezone).startOf("day"))
                  return json(failure("past_or_invalid_date"));
                const maxDays = earliest ? 30 : 1;
                const windowStart = value(args, "window_start");
                const windowEnd = value(args, "window_end");
                const exactTime = value(args, "requested_time");
                if (
                  [windowStart, windowEnd, exactTime].some(
                    (t) => t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t),
                  )
                )
                  return json(failure("invalid_time"));
                const all = await availableSlots(
                  db,
                  clinicId,
                  selected,
                  service,
                  first.toFormat("yyyy-MM-dd"),
                  timezone,
                  secret,
                  callId,
                  checkId,
                  excludeAppointmentId,
                  timing,
                  maxDays,
                  windowStart,
                  windowEnd,
                  exactTime,
                );
                const requestedTimeAvailable = exactTime
                  ? all.some((s) => s.time === exactTime)
                  : null;
                if (exactTime)
                  all.sort((a, b) => (a.time === exactTime ? -1 : b.time === exactTime ? 1 : 0));
                const offered = all.slice(0, 12);
                if (offered.length) {
                  const { error: saveError } = await timing.run<{ error: unknown }>(
                    "checked_slot_write",
                    () =>
                      db.from("voice_checked_slots").insert(
                        offered.map((s) => ({
                          id: s.checked_slot_id,
                          check_id: checkId,
                          call_id: callId,
                          clinic_id: clinicId,
                          staff_id: s.practitioner_id,
                          service: s.service_name,
                          start_time: s.start_time,
                          end_time: s.end_time,
                          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
                        })),
                      ),
                    (result) => !result.error,
                  );
                  if (saveError) throw saveError;
                }
                return json({
                  ...base,
                  available: offered.length > 0,
                  requested_time_available: requestedTimeAvailable,
                  date: earliest ? (all[0]?.date ?? first.toFormat("yyyy-MM-dd")) : requestedDate,
                  timezone,
                  slots: offered.map(
                    ({ checked_slot_id, start_time, end_time, ...publicSlot }) => publicSlot,
                  ),
                  error_type: offered.length ? null : "no_slots",
                });
              };
              if (action === "resolve") return json(await run(db));
              return json(
                await availabilityWithFallback(
                  db,
                  calendarDetails,
                  run,
                  undefined,
                  value(args, "search_mode") === "earliest",
                ),
              );
            }
            if (action === "book" || action === "reschedule") {
              const slotId = value(args, "slot_id");
              const slot = await readToken(slotId, secret, clinicId);
              if (!slot || slot.k !== callId) return json(failure("stale_or_invalid_slot"));
              const patientName = value(args, "client_name");
              const patientPhone = phone(args.client_phone);
              if (!patientName || !patientPhone) return json(failure("invalid_patient_or_phone"));
              const appointmentId = value(args, "appointment_id");
              if (action === "reschedule" && !/^[0-9a-f-]{36}$/i.test(appointmentId))
                return json(failure("invalid_appointment_id"));
              const start = DateTime.fromISO(slot.t);
              const timezone = await loadTimezone(db, clinicId);
              const localStart = start.setZone(timezone);
              if (
                value(args, "service_name") !== slot.v ||
                value(args, "practitioner_id") !== slot.s ||
                value(args, "appointment_date") !== localStart.toFormat("yyyy-MM-dd") ||
                value(args, "appointment_time") !== localStart.toFormat("HH:mm")
              )
                return json(failure("slot_mismatch"));
              const key = await operationKey(
                action,
                `${slotId}:${patientName}:${patientPhone}`,
                appointmentId,
              );
              const complete = async (signal?: AbortSignal) => {
                const priorQuery = db
                  .from("voice_operations")
                  .select("result")
                  .eq("operation_key", key)
                  .eq("clinic_id", clinicId)
                  .maybeSingle();
                if (signal) priorQuery.abortSignal(signal);
                const { data: prior, error: priorError } = await priorQuery;
                if (priorError) throw priorError;
                if (prior?.result?.success === true) return prior.result;
                const stateQuery = db
                  .from("voice_call_state")
                  .select("current_check_id")
                  .eq("call_id", callId)
                  .eq("clinic_id", clinicId)
                  .maybeSingle();
                if (signal) stateQuery.abortSignal(signal);
                const { data: state, error: stateError } = await stateQuery;
                if (stateError) throw stateError;
                if (state?.current_check_id !== slot.i) return failure("stale_or_invalid_slot");
                if (!start.isValid || start <= DateTime.now())
                  return failure("past_or_invalid_slot");
                const { data, error } = await timing.run<{ data: unknown; error: unknown }>(
                  "booking_rpc",
                  () => {
                    const query = db.rpc("voice_apply_appointment", {
                      p_action: action,
                      p_clinic_id: clinicId,
                      p_operation_key: key,
                      p_call_id: callId,
                      p_appointment_id: appointmentId || null,
                      p_client_name: patientName,
                      p_client_phone: patientPhone,
                      p_caller_name: value(args, "caller_name") || null,
                      p_caller_phone: phone(args.caller_phone),
                      p_staff_id: slot.s,
                      p_service: slot.v,
                      p_start: start.toUTC().toISO(),
                      p_end: start
                        .plus({ minutes: slot.m ?? identity.integration.slot_minutes ?? 45 })
                        .toUTC()
                        .toISO(),
                      p_check_id: slot.i,
                      p_slot_id: slot.q,
                    });
                    if (signal) query.abortSignal(signal);
                    return query;
                  },
                  (result) => !result.error,
                );
                if (error) {
                  if (action !== "book") throw new SystemUnavailableError("database_unavailable");
                  return failure(
                    action === "book" &&
                      typeof error === "object" &&
                      error !== null &&
                      "code" in error &&
                      error.code === "57014"
                      ? "booking_timeout"
                      : "database_error",
                  );
                }
                return data;
              };
              if (action === "book")
                return json(
                  await bookingWithFallback(
                    db,
                    key,
                    {
                      clinicId,
                      callId,
                      patientName,
                      patientPhone,
                      service: slot.v,
                      practitioner: value(args, "practitioner_name") || slot.s,
                      date: localStart.toFormat("yyyy-MM-dd"),
                      time: localStart.toFormat("HH:mm"),
                    },
                    (signal) => complete(signal),
                  ),
                );
              return json(await complete());
            }
            if (action === "lookup") {
              const patientName = value(args, "client_name");
              const patientPhone = phone(args.client_phone);
              if (!patientName || !patientPhone) return json(failure("invalid_patient_or_phone"));
              const { data: clients, error: clientError } = await db
                .from("clients")
                .select("id,full_name,phone")
                .eq("clinic_id", clinicId)
                .ilike("full_name", patientName);
              if (clientError) throw clientError;
              const ids = (clients ?? [])
                .filter((c: { phone: string }) => phone(c.phone) === patientPhone)
                .map((c: { id: string }) => c.id);
              if (!ids.length) return json({ success: true, appointments: [], count: 0 });
              const { data, error } = await db
                .from("appointments")
                .select("id,service,staff_id,start_time,end_time,status")
                .eq("clinic_id", clinicId)
                .in("client_id", ids)
                .neq("status", "Cancelled")
                .gte("start_time", new Date().toISOString())
                .order("start_time");
              if (error) throw error;
              return json({ success: true, appointments: data ?? [], count: data?.length ?? 0 });
            }
            if (action === "cancel") {
              const appointmentId = value(args, "appointment_id");
              const patientName = value(args, "client_name");
              const patientPhone = phone(args.client_phone);
              if (!appointmentId || !patientName || !patientPhone || args.confirmed !== true)
                return json(failure("confirmation_or_patient_missing"));
              const key = await operationKey(
                "cancel",
                value(args, "operation_id") || appointmentId,
                appointmentId,
              );
              const { data, error } = await timing.run<{ data: unknown; error: unknown }>(
                "booking_rpc",
                () =>
                  db.rpc("voice_apply_appointment", {
                    p_action: "cancel",
                    p_clinic_id: clinicId,
                    p_operation_key: key,
                    p_call_id: callId,
                    p_appointment_id: appointmentId,
                    p_client_name: patientName,
                    p_client_phone: patientPhone,
                    p_caller_name: value(args, "caller_name") || null,
                    p_caller_phone: phone(args.caller_phone),
                    p_staff_id: null,
                    p_service: null,
                    p_start: null,
                    p_end: null,
                    p_check_id: null,
                    p_slot_id: null,
                  }),
                (result) => !result.error,
              );
              if (error) {
                outcome = "failure";
                return downtimeResponse({
                  clinicId,
                  callId: trustedCallId,
                  dependency: "database_unavailable",
                });
              }
              return json(data);
            }
            if (["message", "callback", "urgent"].includes(action)) {
              const contactPhone = phone(args.caller_phone);
              const reason = value(args, "reason");
              if (!contactPhone || !reason) return json(failure("invalid_contact_or_reason"));
              const requestKey = await operationKey(
                action,
                `${callId ?? "unknown"}:${contactPhone}:${reason}`,
              );
              const { data, error } = await db
                .from("voice_requests")
                .insert({
                  clinic_id: clinicId,
                  request_key: requestKey,
                  call_id: callId,
                  kind: action,
                  caller_name: value(args, "caller_name") || null,
                  patient_name: value(args, "patient_name") || null,
                  phone: contactPhone,
                  reason,
                  status: "Open",
                })
                .select("id,status")
                .single();
              if (error?.code === "23505") {
                const existing = await db
                  .from("voice_requests")
                  .select("id,status")
                  .eq("clinic_id", clinicId)
                  .eq("request_key", requestKey)
                  .single();
                if (!existing.error && existing.data)
                  return json({
                    success: true,
                    request_id: existing.data.id,
                    status: existing.data.status,
                  });
              }
              if (error || !data) {
                outcome = "failure";
                return downtimeResponse({
                  clinicId,
                  callId: trustedCallId,
                  dependency: "database_unavailable",
                });
              }
              return json({ success: true, request_id: data.id, status: data.status });
            }
            return json(failure("unknown_action"));
          } catch (error) {
            outcome = "failure";
            const dependency =
              error instanceof SystemUnavailableError
                ? error.dependency
                : error && typeof error === "object" && "code" in error
                  ? "database_unavailable"
                  : "internal_error";
            return downtimeResponse({
              clinicId,
              callId: trustedCallId,
              dependency,
              db: trustedCallId && dependency === "internal_error" ? ctx.supabaseAdmin : undefined,
            });
          }
        } finally {
          timing.finish(outcome);
        }
      }),
    ),
  ),
};
