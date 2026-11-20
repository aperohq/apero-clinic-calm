import { monitorHandler, setOperationalContext } from "../_shared/operational-log.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { phone as normalizeClinicPhone } from "../clinic-operations/logic.ts";
import { resolveVoiceIntegration } from "../_shared/voice-integration.ts";
import {
  logDatabaseFailure,
  readLimitedBody,
  RequestBodyTooLargeError,
} from "../_shared/request-security.ts";
import { DateTime } from "npm:luxon@3";
import { bookingWithFallback } from "../_shared/booking-fallback.ts";

type LegacyArgs = {
  client_name?: string;
  client_phone?: string;
  practitioner_name?: string;
  service_name?: string;
  appointment_date?: string;
  appointment_time?: string;
};

function normalizeName(value: string) {
  return (value ?? "")
    .toLowerCase()
    .replace(/doctor|dr\.?|دكتور|الدكتور/gi, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function namesMatch(a: string, b: string) {
  const x = normalizeName(a);
  const y = normalizeName(b);

  if (!x || !y) return false;

  return x === y || x.includes(y) || y.includes(x);
}

function matchesPractitioner(
  staff: { id: string; full_name: string; services: string[]; aliases?: string[] },
  requestedName: string,
) {
  if (namesMatch(staff.full_name, requestedName)) {
    return true;
  }

  return (staff.aliases ?? []).some((alias: string) => namesMatch(alias, requestedName));
}

export default {
  fetch: monitorHandler(
    "book-appointment",
    withSupabase({ auth: "none" }, async (req, ctx) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      let rawBody: string;
      try {
        rawBody = await readLimitedBody(req, 128 * 1024);
      } catch (error) {
        return new Response("Request body too large", {
          status: error instanceof RequestBodyTooLargeError ? 413 : 400,
        });
      }

      const identity = await resolveVoiceIntegration(
        ctx.supabaseAdmin,
        rawBody,
        req.headers.get("x-retell-signature"),
      );
      if (!identity) return new Response("Unauthorized", { status: 401 });
      const clinicId = identity.integration.clinic_id;
      const SLOT_MINUTES = identity.integration.slot_minutes;
      setOperationalContext(req, { clinic_id: clinicId });

      let payload: { call?: { call_id?: string }; args?: LegacyArgs } & LegacyArgs;

      try {
        payload = JSON.parse(rawBody);
        setOperationalContext(req, { call_id: payload.call?.call_id });
      } catch {
        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error_type: "invalid_request",
            error: "Invalid JSON",
          },
          { status: 400 },
        );
      }

      const args = payload.args ?? payload;

      const clientName = args.client_name?.trim();

      const clientPhone = args.client_phone?.trim();

      const practitionerName = args.practitioner_name?.trim();

      const serviceName = args.service_name?.trim();

      const appointmentDate = args.appointment_date?.trim();

      const appointmentTime = args.appointment_time?.trim();

      if (
        !clientName ||
        !clientPhone ||
        !practitionerName ||
        !serviceName ||
        !appointmentDate ||
        !appointmentTime
      ) {
        return Response.json({
          success: false,
          appointment_booked: false,
          error: "Missing required booking information",
        });
      }

      const normalizedPhone = normalizeClinicPhone(
        clientPhone,
        identity.integration.dialing_prefix,
        identity.integration.local_number_length,
      );

      // Basic usable phone validation
      if (!normalizedPhone) {
        return Response.json({
          success: false,
          appointment_booked: false,
          error: "The patient phone number is invalid.",
        });
      }

      // Clinic timezone
      const { data: clinic, error: clinicError } = await ctx.supabaseAdmin
        .from("clinics")
        .select("timezone")
        .eq("id", clinicId)
        .single();

      if (clinicError || !clinic) {
        logDatabaseFailure("Booking clinic lookup", clinicError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error_type: "database_error",
            error: "Clinic not found",
          },
          { status: 500 },
        );
      }

      const timezone = clinic.timezone;

      // Required:
      // appointment_date = YYYY-MM-DD
      // appointment_time = HH:mm
      const start = DateTime.fromISO(`${appointmentDate}T${appointmentTime}`, { zone: timezone });

      if (!start.isValid) {
        return Response.json({
          success: false,
          appointment_booked: false,
          error: "Invalid date or time. Use YYYY-MM-DD and HH:mm.",
        });
      }

      const now = DateTime.now().setZone(timezone);

      if (start <= now) {
        return Response.json({
          success: false,
          appointment_booked: false,
          error: "Appointments cannot be booked in the past.",
        });
      }

      const end = start.plus({
        minutes: SLOT_MINUTES,
      });

      // Load active practitioners including aliases
      const { data: staffList, error: staffError } = await ctx.supabaseAdmin
        .from("staff")
        .select("id, full_name, specialty, services, aliases")
        .eq("clinic_id", clinicId)
        .eq("active", true);

      if (staffError || !staffList) {
        logDatabaseFailure("Booking staff lookup", staffError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error_type: "database_error",
            error: "Unable to load practitioners",
          },
          { status: 500 },
        );
      }

      const practitioner = staffList.find(
        (staff: { id: string; full_name: string; services: string[]; aliases?: string[] }) =>
          matchesPractitioner(staff, practitionerName),
      );

      if (!practitioner) {
        return Response.json({
          success: false,
          appointment_booked: false,
          practitioner_found: false,
          error: "Requested practitioner could not be matched.",
        });
      }

      if (!practitioner.services?.includes(serviceName))
        return Response.json({
          success: false,
          appointment_booked: false,
          error_type: "service_mismatch",
          message: "The selected practitioner does not offer this service.",
        });

      // Sunday = 0
      const dayOfWeek = start.weekday % 7;

      // Make sure the doctor works at this time
      const { data: shifts, error: shiftError } = await ctx.supabaseAdmin
        .from("staff_availability")
        .select("start_time, end_time")
        .eq("clinic_id", clinicId)
        .eq("staff_id", practitioner.id)
        .eq("day_of_week", dayOfWeek)
        .eq("is_available", true);

      if (shiftError) {
        logDatabaseFailure("Booking shift lookup", shiftError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error_type: "database_error",
            error: "Unable to check practitioner hours",
          },
          { status: 500 },
        );
      }

      const insideShift = (shifts ?? []).some((shift: { start_time: string; end_time: string }) => {
        const shiftStart = DateTime.fromISO(`${appointmentDate}T${shift.start_time}`, {
          zone: timezone,
        });

        const shiftEnd = DateTime.fromISO(`${appointmentDate}T${shift.end_time}`, {
          zone: timezone,
        });

        return start >= shiftStart && end <= shiftEnd;
      });

      if (!insideShift) {
        return Response.json({
          success: false,
          appointment_booked: false,
          available: false,
          practitioner_found: true,
          error: `${practitioner.full_name} is not working at the requested time.`,
        });
      }

      // Check time off
      const { data: timeOff, error: timeOffError } = await ctx.supabaseAdmin
        .from("staff_time_off")
        .select("start_time, end_time")
        .eq("clinic_id", clinicId)
        .eq("staff_id", practitioner.id)
        .lt("start_time", end.toUTC().toISO())
        .gt("end_time", start.toUTC().toISO());

      if (timeOffError) {
        logDatabaseFailure("Booking time-off lookup", timeOffError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error_type: "database_error",
            error: "Unable to check practitioner availability",
          },
          { status: 500 },
        );
      }

      if (timeOff && timeOff.length > 0) {
        return Response.json({
          success: false,
          appointment_booked: false,
          available: false,
          practitioner_found: true,
          error: `${practitioner.full_name} is unavailable at the requested time.`,
        });
      }

      // Re-check existing appointments
      const { data: conflicts, error: conflictError } = await ctx.supabaseAdmin
        .from("appointments")
        .select("id")
        .eq("clinic_id", clinicId)
        .eq("staff_id", practitioner.id)
        .lt("start_time", end.toUTC().toISO())
        .gt("end_time", start.toUTC().toISO())
        .neq("status", "Cancelled");

      if (conflictError) {
        logDatabaseFailure("Booking conflict lookup", conflictError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error_type: "database_error",
            error: "Unable to verify appointment availability",
          },
          { status: 500 },
        );
      }

      if (conflicts && conflicts.length > 0) {
        return Response.json({
          success: false,
          appointment_booked: false,
          available: false,
          practitioner_found: true,
          error: "That appointment time is no longer available. Check availability again.",
        });
      }

      // Find existing client by phone
      const { data: clients, error: clientsError } = await ctx.supabaseAdmin.rpc(
        "clinic_clients_by_phone",
        {
          p_clinic_id: clinicId,
          p_phone: normalizedPhone,
          p_prefix: identity.integration.dialing_prefix,
          p_length: identity.integration.local_number_length,
        },
      );
      if (clientsError)
        return Response.json(
          { success: false, appointment_booked: false, error_type: "database_error" },
          { status: 503 },
        );
      if (clients?.length > 1)
        return Response.json(
          { success: false, appointment_booked: false, error_type: "ambiguous_patient" },
          { status: 409 },
        );
      let client = clients?.[0];

      // Create client when new
      if (!client) {
        const { data: newClient, error: clientError } = await ctx.supabaseAdmin
          .from("clients")
          .insert({
            clinic_id: clinicId,
            full_name: clientName,
            phone: clientPhone,
          })
          .select("id")
          .single();

        if (clientError || !newClient) {
          logDatabaseFailure("Booking client create", clientError);

          return Response.json(
            {
              success: false,
              appointment_booked: false,
              error: "Unable to create patient record",
            },
            { status: 500 },
          );
        }

        client = newClient;
      }

      // Keep the legacy insertion path, but bound creation and retain failure
      // in the same clinic Requests queue used by the current master endpoint.
      const callId = payload.call?.call_id;
      if (typeof callId !== "string" || !callId.trim())
        return Response.json({
          success: false,
          appointment_booked: false,
          appointment_confirmed: false,
          error_type: "missing_call_id",
          message: "Your appointment is NOT confirmed.",
        });
      const keyBytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([
              clinicId,
              callId,
              normalizedPhone,
              clientName,
              practitioner.id,
              serviceName,
              appointmentDate,
              appointmentTime,
            ]),
          ),
        ),
      );
      const key = Array.from(keyBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await bookingWithFallback(
        ctx.supabaseAdmin,
        key,
        {
          clinicId,
          callId,
          patientName: clientName,
          patientPhone: clientPhone,
          service: serviceName,
          practitioner: practitioner.full_name,
          date: appointmentDate,
          time: appointmentTime,
        },
        async (signal) => {
          const { data: appointment, error: appointmentError } = await ctx.supabaseAdmin
            .from("appointments")
            .insert({
              clinic_id: clinicId,
              client_id: client.id,
              staff_id: practitioner.id,
              service: serviceName,
              start_time: start.toUTC().toISO(),
              end_time: end.toUTC().toISO(),
              status: "Booked",
              source: "Booked by Apero",
            })
            .select("id")
            .single()
            .abortSignal(signal);
          if (appointmentError)
            return {
              success: false,
              appointment_booked: false,
              error_type:
                appointmentError.code === "23P01"
                  ? "slot_conflict"
                  : appointmentError.code === "57014"
                    ? "booking_timeout"
                    : "database_error",
            };
          return {
            success: true,
            appointment_booked: true,
            available: true,
            practitioner_found: true,
            appointment_id: appointment?.id,
            client_name: clientName,
            client_phone: clientPhone,
            practitioner_name: practitioner.full_name,
            service_name: serviceName,
          };
        },
      );
      return Response.json(result);
    }),
  ),
};
