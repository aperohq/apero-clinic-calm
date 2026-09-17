import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { Retell } from "npm:retell-sdk";
import { DateTime } from "npm:luxon@3";

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const SLOT_MINUTES = 30;

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

function matchesPractitioner(staff: any, requestedName: string) {
  if (namesMatch(staff.full_name, requestedName)) {
    return true;
  }

  return (staff.aliases ?? []).some((alias: string) =>
    namesMatch(alias, requestedName)
  );
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    try {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const rawBody = await req.text();

      const signature = req.headers.get("x-retell-signature");
      const apiKey = Deno.env.get("RETELL_API_KEY");

      if (
        !apiKey ||
        !signature ||
        !await Retell.verify(rawBody, apiKey, signature)
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      const payload = JSON.parse(rawBody);
      const args = payload.args ?? payload;

      const requestedDate =
        typeof args.requested_date === "string"
          ? args.requested_date.trim()
          : "";

      const practitionerName =
        typeof args.practitioner_name === "string"
          ? args.practitioner_name.trim()
          : "";

      if (!requestedDate) {
        return Response.json({
          available: false,
          message: "requested_date is required.",
        });
      }

      // ---------------------------
      // CLINIC
      // ---------------------------

      const { data: clinic, error: clinicError } =
        await ctx.supabaseAdmin
          .from("clinics")
          .select("timezone")
          .eq("id", CLINIC_ID)
          .single();

      if (clinicError || !clinic) {
        console.error("Clinic error:", clinicError);

        return Response.json(
          {
            available: false,
            message: "Clinic could not be loaded.",
          },
          { status: 500 },
        );
      }

      const timezone = clinic.timezone || "Asia/Kuwait";

      const requestedDay = DateTime.fromISO(requestedDate, {
        zone: timezone,
      });

      if (!requestedDay.isValid) {
        return Response.json({
          available: false,
          message: "Invalid requested date.",
        });
      }

      const now = DateTime.now().setZone(timezone);

      if (requestedDay.endOf("day").toMillis() < now.toMillis()) {
        return Response.json({
          available: false,
          date: requestedDate,
          message: "The requested date is in the past.",
        });
      }

      // Sunday = 0
      // Monday = 1
      // ...
      // Saturday = 6
      const dayOfWeek = requestedDay.weekday % 7;

      // ---------------------------
      // STAFF
      // ---------------------------

      const { data: staffList, error: staffError } =
        await ctx.supabaseAdmin
          .from("staff")
          .select(
            "id, full_name, specialty, services, aliases"
          )
          .eq("clinic_id", CLINIC_ID)
          .eq("active", true);

      if (staffError || !staffList) {
        console.error("Staff error:", staffError);

        return Response.json(
          {
            available: false,
            message: "Staff could not be loaded.",
          },
          { status: 500 },
        );
      }

      let candidates = staffList;

      if (practitionerName) {
        candidates = staffList.filter((staff: any) =>
          matchesPractitioner(staff, practitionerName)
        );

        if (candidates.length === 0) {
          return Response.json({
            available: false,
            practitioner_found: false,
            requested_practitioner: practitionerName,
            message:
              "The requested practitioner could not be matched.",
          });
        }
      }

      // ---------------------------
      // DAY BOUNDARIES
      // ---------------------------

      const dayStart = requestedDay.startOf("day");
      const dayEnd = requestedDay.endOf("day");

      const results: any[] = [];
      const debug: any[] = [];

      // ---------------------------
      // EACH PRACTITIONER
      // ---------------------------

      for (const staff of candidates) {
        const { data: shifts, error: shiftsError } =
          await ctx.supabaseAdmin
            .from("staff_availability")
            .select("start_time, end_time")
            .eq("clinic_id", CLINIC_ID)
            .eq("staff_id", staff.id)
            .eq("day_of_week", dayOfWeek)
            .eq("is_available", true)
            .order("start_time");

        if (shiftsError) {
          console.error("Shift error:", shiftsError);
          continue;
        }

        if (!shifts || shifts.length === 0) {
          debug.push({
            practitioner: staff.full_name,
            day_of_week: dayOfWeek,
            shifts_found: 0,
          });

          continue;
        }

        // ---------------------------
        // EXISTING APPOINTMENTS
        // ---------------------------

        const { data: appointments, error: appointmentError } =
          await ctx.supabaseAdmin
            .from("appointments")
            .select("start_time, end_time, status")
            .eq("clinic_id", CLINIC_ID)
            .eq("staff_id", staff.id)
            .lt("start_time", dayEnd.toUTC().toISO())
            .gt("end_time", dayStart.toUTC().toISO())
            .neq("status", "Cancelled");

        if (appointmentError) {
          console.error("Appointment error:", appointmentError);
          continue;
        }

        // ---------------------------
        // TIME OFF
        // ---------------------------

        const { data: timeOff, error: timeOffError } =
          await ctx.supabaseAdmin
            .from("staff_time_off")
            .select("start_time, end_time")
            .eq("clinic_id", CLINIC_ID)
            .eq("staff_id", staff.id)
            .lt("start_time", dayEnd.toUTC().toISO())
            .gt("end_time", dayStart.toUTC().toISO());

        if (timeOffError) {
          console.error("Time off error:", timeOffError);
          continue;
        }

        const freeSlots: string[] = [];

        // ---------------------------
        // GENERATE SLOTS
        // ---------------------------

        for (const shift of shifts) {
          const shiftStart = DateTime.fromISO(
            `${requestedDate}T${shift.start_time}`,
            { zone: timezone },
          );

          const shiftEnd = DateTime.fromISO(
            `${requestedDate}T${shift.end_time}`,
            { zone: timezone },
          );

          if (!shiftStart.isValid || !shiftEnd.isValid) {
            console.error("Invalid shift:", shift);
            continue;
          }

          let slotStart = shiftStart;

          while (
            slotStart.plus({ minutes: SLOT_MINUTES }).toMillis() <=
            shiftEnd.toMillis()
          ) {
            const slotEnd = slotStart.plus({
              minutes: SLOT_MINUTES,
            });

            // Don't return times already passed
            if (slotStart.toMillis() <= now.toMillis()) {
              slotStart = slotEnd;
              continue;
            }

            // Existing appointment overlap
            const appointmentConflict = (appointments ?? []).some(
              (appointment: any) => {
                const existingStart = DateTime.fromISO(
                  appointment.start_time,
                );

                const existingEnd = DateTime.fromISO(
                  appointment.end_time,
                );

                return (
                  slotStart.toUTC().toMillis() <
                    existingEnd.toUTC().toMillis() &&
                  slotEnd.toUTC().toMillis() >
                    existingStart.toUTC().toMillis()
                );
              },
            );

            // Time-off overlap
            const timeOffConflict = (timeOff ?? []).some(
              (block: any) => {
                const blockedStart = DateTime.fromISO(
                  block.start_time,
                );

                const blockedEnd = DateTime.fromISO(
                  block.end_time,
                );

                return (
                  slotStart.toUTC().toMillis() <
                    blockedEnd.toUTC().toMillis() &&
                  slotEnd.toUTC().toMillis() >
                    blockedStart.toUTC().toMillis()
                );
              },
            );

            if (!appointmentConflict && !timeOffConflict) {
              freeSlots.push(slotStart.toFormat("h:mm a"));
            }

            slotStart = slotEnd;
          }
        }

        debug.push({
          practitioner: staff.full_name,
          day_of_week: dayOfWeek,
          shifts_found: shifts.length,
          appointments_found: appointments?.length ?? 0,
          time_off_found: timeOff?.length ?? 0,
          slots_generated: freeSlots.length,
        });

        if (freeSlots.length > 0) {
          results.push({
            practitioner_id: staff.id,
            practitioner_name: staff.full_name,
            specialty: staff.specialty,
            available_slots: freeSlots,
          });
        }
      }

      // ---------------------------
      // NO SLOTS
      // ---------------------------

      if (results.length === 0) {
        return Response.json({
          available: false,
          practitioner_found: practitionerName ? true : undefined,
          date: requestedDate,
          timezone,
          message:
            "No appointment slots are available on the requested date.",

          // TEMPORARY DEBUG

        });
      }

      // ---------------------------
      // SUCCESS
      // ---------------------------

      return Response.json({
        available: true,
        practitioner_found: practitionerName ? true : undefined,
        date: requestedDate,
        timezone,
        slot_duration_minutes: SLOT_MINUTES,
        practitioners: results,

        // TEMPORARY DEBUG

      });
    } catch (error) {
      console.error(error);

      return Response.json(
        {
          available: false,
          message: "Availability check failed.",
          error: String(error),
        },
        { status: 500 },
      );
    }
  }),
};
