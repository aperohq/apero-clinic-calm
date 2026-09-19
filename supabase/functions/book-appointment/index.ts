import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { resolveVoiceIntegration } from "../_shared/voice-integration.ts";
import { logDatabaseFailure, readLimitedBody, RequestBodyTooLargeError } from "../_shared/request-security.ts";
import { DateTime } from "npm:luxon@3";

const SLOT_MINUTES = 30;

function normalizePhone(
  phone: string | null | undefined,
) {
  if (!phone) return "";

  return phone.replace(/\D/g, "");
}

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
  staff: any,
  requestedName: string,
) {
  if (
    namesMatch(
      staff.full_name,
      requestedName,
    )
  ) {
    return true;
  }

  return (staff.aliases ?? []).some(
    (alias: string) =>
      namesMatch(alias, requestedName),
  );
}

export default {
  fetch: withSupabase(
    { auth: "none" },
    async (req, ctx) => {
      if (req.method !== "POST") {
        return new Response(
          "Method not allowed",
          { status: 405 },
        );
      }

      let rawBody: string;
      try { rawBody = await readLimitedBody(req, 128 * 1024); }
      catch (error) { return new Response("Request body too large", { status: error instanceof RequestBodyTooLargeError ? 413 : 400 }); }

      const identity = await resolveVoiceIntegration(ctx.supabaseAdmin, rawBody, req.headers.get("x-retell-signature"));
      if (!identity) return new Response("Unauthorized", { status: 401 });
      const clinicId = identity.integration.clinic_id;

      let payload: any;

      try {
        payload = JSON.parse(rawBody);
      } catch {
        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error: "Invalid JSON",
          },
          { status: 400 },
        );
      }

      const args = payload.args ?? payload;

      const clientName =
        args.client_name?.trim();

      const clientPhone =
        args.client_phone?.trim();

      const practitionerName =
        args.practitioner_name?.trim();

      const serviceName =
        args.service_name?.trim();

      const appointmentDate =
        args.appointment_date?.trim();

      const appointmentTime =
        args.appointment_time?.trim();

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
          error:
            "Missing required booking information",
        });
      }

      const normalizedPhone =
        normalizePhone(clientPhone);

      // Basic usable phone validation
      if (
        normalizedPhone.length < 8 ||
        normalizedPhone.length > 15
      ) {
        return Response.json({
          success: false,
          appointment_booked: false,
          error:
            "The patient phone number is invalid.",
        });
      }

      // Clinic timezone
      const {
        data: clinic,
        error: clinicError,
      } = await ctx.supabaseAdmin
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
            error: "Clinic not found",
          },
          { status: 500 },
        );
      }

      const timezone =
        clinic.timezone;

      // Required:
      // appointment_date = YYYY-MM-DD
      // appointment_time = HH:mm
      const start = DateTime.fromISO(
        `${appointmentDate}T${appointmentTime}`,
        { zone: timezone },
      );

      if (!start.isValid) {
        return Response.json({
          success: false,
          appointment_booked: false,
          error:
            "Invalid date or time. Use YYYY-MM-DD and HH:mm.",
        });
      }

      const now =
        DateTime.now().setZone(timezone);

      if (start <= now) {
        return Response.json({
          success: false,
          appointment_booked: false,
          error:
            "Appointments cannot be booked in the past.",
        });
      }

      const end = start.plus({
        minutes: SLOT_MINUTES,
      });

      // Load active practitioners including aliases
      const {
        data: staffList,
        error: staffError,
      } = await ctx.supabaseAdmin
        .from("staff")
        .select(
          "id, full_name, specialty, services, aliases",
        )
        .eq("clinic_id", clinicId)
        .eq("active", true);

      if (staffError || !staffList) {
        logDatabaseFailure("Booking staff lookup", staffError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error:
              "Unable to load practitioners",
          },
          { status: 500 },
        );
      }

      const practitioner =
        staffList.find((staff: any) =>
          matchesPractitioner(
            staff,
            practitionerName,
          )
        );

      if (!practitioner) {
        return Response.json({
          success: false,
          appointment_booked: false,
          practitioner_found: false,
          error:
            "Requested practitioner could not be matched.",
        });
      }

      // Sunday = 0
      const dayOfWeek =
        start.weekday % 7;

      // Make sure the doctor works at this time
      const {
        data: shifts,
        error: shiftError,
      } = await ctx.supabaseAdmin
        .from("staff_availability")
        .select(
          "start_time, end_time",
        )
        .eq("clinic_id", clinicId)
        .eq(
          "staff_id",
          practitioner.id,
        )
        .eq(
          "day_of_week",
          dayOfWeek,
        )
        .eq("is_available", true);

      if (shiftError) {
        logDatabaseFailure("Booking shift lookup", shiftError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error:
              "Unable to check practitioner hours",
          },
          { status: 500 },
        );
      }

      const insideShift = (
        shifts ?? []
      ).some((shift: any) => {
        const shiftStart =
          DateTime.fromISO(
            `${appointmentDate}T${shift.start_time}`,
            { zone: timezone },
          );

        const shiftEnd =
          DateTime.fromISO(
            `${appointmentDate}T${shift.end_time}`,
            { zone: timezone },
          );

        return (
          start >= shiftStart &&
          end <= shiftEnd
        );
      });

      if (!insideShift) {
        return Response.json({
          success: false,
          appointment_booked: false,
          available: false,
          practitioner_found: true,
          error:
            `${practitioner.full_name} is not working at the requested time.`,
        });
      }

      // Check time off
      const {
        data: timeOff,
        error: timeOffError,
      } = await ctx.supabaseAdmin
        .from("staff_time_off")
        .select(
          "start_time, end_time",
        )
        .eq("clinic_id", clinicId)
        .eq(
          "staff_id",
          practitioner.id,
        )
        .lt(
          "start_time",
          end.toUTC().toISO(),
        )
        .gt(
          "end_time",
          start.toUTC().toISO(),
        );

      if (timeOffError) {
        logDatabaseFailure("Booking time-off lookup", timeOffError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error:
              "Unable to check practitioner availability",
          },
          { status: 500 },
        );
      }

      if (
        timeOff &&
        timeOff.length > 0
      ) {
        return Response.json({
          success: false,
          appointment_booked: false,
          available: false,
          practitioner_found: true,
          error:
            `${practitioner.full_name} is unavailable at the requested time.`,
        });
      }

      // Re-check existing appointments
      const {
        data: conflicts,
        error: conflictError,
      } = await ctx.supabaseAdmin
        .from("appointments")
        .select("id")
        .eq("clinic_id", clinicId)
        .eq(
          "staff_id",
          practitioner.id,
        )
        .lt(
          "start_time",
          end.toUTC().toISO(),
        )
        .gt(
          "end_time",
          start.toUTC().toISO(),
        )
        .neq(
          "status",
          "Cancelled",
        );

      if (conflictError) {
        logDatabaseFailure("Booking conflict lookup", conflictError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error:
              "Unable to verify appointment availability",
          },
          { status: 500 },
        );
      }

      if (
        conflicts &&
        conflicts.length > 0
      ) {
        return Response.json({
          success: false,
          appointment_booked: false,
          available: false,
          practitioner_found: true,
          error:
            "That appointment time is no longer available. Check availability again.",
        });
      }

      // Find existing client by phone
      const {
        data: clients,
        error: clientsError,
      } = await ctx.supabaseAdmin
        .from("clients")
        .select("id, phone")
        .eq("clinic_id", clinicId);

      if (clientsError) {
        logDatabaseFailure("Booking client lookup", clientsError);

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error:
              "Unable to check patient record",
          },
          { status: 500 },
        );
      }

      let client = (
        clients ?? []
      ).find(
        (c: any) =>
          normalizePhone(c.phone) ===
          normalizedPhone,
      );

      // Create client when new
      if (!client) {
        const {
          data: newClient,
          error: clientError,
        } = await ctx.supabaseAdmin
          .from("clients")
          .insert({
            clinic_id: clinicId,
            full_name: clientName,
            phone: clientPhone,
          })
          .select("id")
          .single();

        if (
          clientError ||
          !newClient
        ) {
          logDatabaseFailure("Booking client create", clientError);

          return Response.json(
            {
              success: false,
              appointment_booked: false,
              error:
                "Unable to create patient record",
            },
            { status: 500 },
          );
        }

        client = newClient;
      }

      // Final insert
      const {
        data: appointment,
        error: appointmentError,
      } = await ctx.supabaseAdmin
        .from("appointments")
        .insert({
          clinic_id: clinicId,
          client_id: client.id,
          staff_id:
            practitioner.id,
          service: serviceName,
          start_time:
            start.toUTC().toISO(),
          end_time:
            end.toUTC().toISO(),
          status: "Booked",
          source: "Booked by Apero",
        })
        .select("id")
        .single();

      if (appointmentError) {
        logDatabaseFailure("Booking appointment insert", appointmentError);

        // Exclusion constraint:
        // another booking took the slot
        if (
          appointmentError.code ===
          "23P01"
        ) {
          return Response.json({
            success: false,
            appointment_booked: false,
            available: false,
            practitioner_found: true,
            error:
              "That time was just booked by someone else. Check availability again.",
          });
        }

        return Response.json(
          {
            success: false,
            appointment_booked: false,
            error:
              "Appointment could not be created",
          },
          { status: 500 },
        );
      }

      return Response.json({
        success: true,
        appointment_booked: true,
        available: true,
        practitioner_found: true,

        appointment_id:
          appointment.id,

        client_name:
          clientName,

        client_phone:
          clientPhone,

        practitioner_name:
          practitioner.full_name,

        service_name:
          serviceName,

        appointment_date:
          appointmentDate,

        appointment_time:
          start.toFormat("h:mm a"),

        timezone,

        message:
          `Appointment successfully booked for ${clientName} with ${practitioner.full_name} on ${appointmentDate} at ${start.toFormat("h:mm a")}.`,
      });
    },
  ),
};
