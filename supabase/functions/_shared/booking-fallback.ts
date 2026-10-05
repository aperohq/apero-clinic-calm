import { operationalLog } from "./operational-log.ts";
export type FailedBookingDetails = {
  clinicId: string;
  callId: string;
  patientName: string;
  patientPhone: string;
  service: string;
  practitioner: string;
  date: string;
  time: string;
};

const reasons = new Set([
  "database_error",
  "booking_timeout",
  "booking_exception",
  "booking_invalid_response",
  "follow_up_lookup_failed",
  "slot_conflict",
  "stale_or_invalid_slot",
  "slot_not_checked",
  "past_or_invalid_slot",
  "patient_mismatch",
  "invalid_request",
  "staff_not_found",
  "outside_working_hours",
  "staff_time_off",
  "service_mismatch",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Remove control characters from structured staff notes.
const text = (value: string) =>
  value
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 300);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function confirmedBooking(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value["success"] === true &&
    value["appointment_booked"] === true &&
    typeof value["appointment_id"] === "string" &&
    uuid.test(value["appointment_id"])
  );
}

class BookingTimeout extends Error {}

// Racing the deadline also bounds a throwing/hung adapter; abort the actual
// Supabase request, never schedule a retry or continue creation in the catch path.
async function bounded<T>(work: (signal: AbortSignal) => PromiseLike<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new BookingTimeout());
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function failed(reason: string, saved: boolean, requestId: string | null, status = "Open") {
  return {
    success: false,
    available: false,
    appointment_booked: false,
    appointment_confirmed: false,
    appointment_id: null,
    error_type: reason,
    message: "The booking could not be completed. Your appointment is NOT confirmed.",
    follow_up_saved: saved,
    follow_up_request_id: requestId,
    follow_up_status: saved ? status : "not_saved",
    retry_allowed: false,
    patient_instruction: saved
      ? "Your appointment is not confirmed. Your requested details were saved for clinic follow-up; clinic staff must check before confirming anything."
      : "Your appointment is not confirmed. We could not save the follow-up request. Please contact the clinic directly.",
  };
}

// Called only after the existing signed integration/call-ownership boundary.
// The runtime supplies its service-role client; browser roles cannot INSERT
// these requests. Existing voice_requests RLS and role permissions stay intact.
export async function bookingWithFallback(
  // Edge's supplied admin client and local query adapter share this interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  operationKey: string,
  details: FailedBookingDetails,
  create: (signal: AbortSignal) => PromiseLike<unknown>,
  limits = { bookingMs: 8000, followUpMs: 3000 },
) {
  const requestKey = `failed-booking:${details.clinicId}:${operationKey}`;
  let reason = "booking_invalid_response";
  try {
    const previous = (await bounded(
      (signal) =>
        db
          .from("voice_requests")
          .select("id,status")
          .eq("clinic_id", details.clinicId)
          .eq("request_key", requestKey)
          .maybeSingle()
          .abortSignal(signal),
      limits.followUpMs,
    )) as { data: { id: string; status: string } | null; error: unknown };
    if (previous.error) reason = "follow_up_lookup_failed";
    else if (previous.data) {
      // A replay after the patient was told failure must not start creation,
      // including when staff subsequently marked the follow-up handled.
      return failed("previous_booking_failure", true, previous.data.id, previous.data.status);
    } else {
      try {
        const result = await bounded(create, limits.bookingMs);
        if (confirmedBooking(result)) return result;
        if (
          isRecord(result) &&
          result["success"] === false &&
          typeof result["error_type"] === "string"
        )
          reason = reasons.has(result["error_type"]) ? result["error_type"] : "database_error";
      } catch (error) {
        reason =
          error instanceof BookingTimeout || (isRecord(error) && error["code"] === "57014")
            ? "booking_timeout"
            : "booking_exception";
      }
    }
  } catch {
    reason = "follow_up_lookup_failed";
  }

  const failureTime = new Date().toISOString();
  let requestId: string | null = null;
  let status = "Open";
  try {
    const saved = (await bounded(async (signal) => {
      const result = await db
        .from("voice_requests")
        .insert({
          clinic_id: details.clinicId,
          request_key: requestKey,
          call_id: details.callId,
          kind: "message",
          patient_name: text(details.patientName),
          phone: text(details.patientPhone),
          reason: [
            "Booking not confirmed — requires clinic follow-up.",
            `Requested service: ${text(details.service) || "Not provided"}`,
            `Requested practitioner: ${text(details.practitioner) || "No preference provided"}`,
            `Requested date/time: ${text(details.date)} ${text(details.time)}`,
            `Failure timestamp: ${failureTime}`,
            `Failure reason: ${reason}`,
            "Check the call and existing appointments before scheduling or confirming anything. Do not automatically retry creation.",
          ].join("\n"),
          status: "Open",
        })
        .select("id,status")
        .single()
        .abortSignal(signal);
      if (result.error?.code === "23505") {
        return db
          .from("voice_requests")
          .select("id,status")
          .eq("clinic_id", details.clinicId)
          .eq("request_key", requestKey)
          .single()
          .abortSignal(signal);
      }
      return result;
    }, limits.followUpMs)) as { data: { id: string; status: string } | null; error: unknown };
    if (!saved.error && saved.data?.id) {
      requestId = saved.data.id;
      status = saved.data.status;
    }
  } catch {
    /* Never claim that staff received a request that could not be saved. */
  }
  // Only fixed categories and an opaque follow-up ID, not patient data, slot
  // credentials, raw errors, transcripts, workspace secrets or bearer tokens.
  operationalLog("booking_failed", "book-appointment", {
    clinic_id: details.clinicId, call_id: details.callId, reason,
    dependency_category: reason === "booking_timeout" ? "timeout" : reason === "booking_exception" ? "internal_error" : reason === "booking_invalid_response" ? "invalid_response" : "database_error",
    follow_up_saved: !!requestId, follow_up_request_id: requestId,
  });
  return failed(reason, !!requestId, requestId, status);
}
