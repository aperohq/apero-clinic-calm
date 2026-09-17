import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";
import { Retell } from "npm:retell-sdk";
import { DateTime } from "npm:luxon@3";

const CLINIC_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "agent_b84b2766efeb85afc809147d7a";
// Apero's current calendar defaults new appointments to 45 minutes.
const SLOT_MINUTES = 45;
const encoder = new TextEncoder();
type Slot = { slot_id: string; checked_slot_id: string; start_time: string; end_time: string; practitioner_id: string; practitioner_name: string; service_name: string; date: string; time: string; duration_minutes: number; timezone: string };

import { resolveStaff, resolveService, phone, value, type Staff } from "./logic.ts";

function failure(error_type: string, message = error_type) { return { success: false, available: false, appointment_booked: false, error_type, message }; }
function bytesToBase64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ""); }
function base64ToBytes(text: string): Uint8Array { return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
async function sign(text: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
}
async function tokenFor(staff: Staff, service: string, start: DateTime, secret: string, callId: string, checkId: string, slotId: string): Promise<string> {
  const body = bytesToBase64(encoder.encode(JSON.stringify({ c: CLINIC_ID, s: staff.id, v: service, t: start.toUTC().toISO(), e: Date.now() + 10 * 60_000, k: callId, i: checkId, q: slotId })));
  return `${body}.${await sign(body, secret)}`;
}
async function readToken(token: string, secret: string): Promise<{ c: string; s: string; v: string; t: string; e: number; k: string; i: string; q: string } | null> {
  try {
    const [body, mac] = token.split(".");
    if (!body || !mac || mac !== await sign(body, secret)) return null;
    const data = JSON.parse(new TextDecoder().decode(base64ToBytes(body)));
    if (data.c !== CLINIC_ID || typeof data.e !== "number" || data.e < Date.now()) return null;
    return data;
  } catch { return null; }
}
async function operationKey(action: string, token: string, appointmentId = ""): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${action}:${appointmentId}:${token}`)));
  return bytesToBase64(hash);
}
async function loadStaff(db: any): Promise<Staff[]> {
  const { data, error } = await db.from("staff").select("id,full_name,specialty,services,aliases")
    .eq("clinic_id", CLINIC_ID).eq("active", true);
  if (error) throw error;
  return data ?? [];
}
async function loadTimezone(db: any): Promise<string> {
  const { data, error } = await db.from("clinics").select("timezone").eq("id", CLINIC_ID).single();
  if (error || !data) throw error ?? new Error("Clinic missing");
  return data.timezone;
}
async function availableSlots(db: any, staff: Staff[], service: string, date: string, timezone: string, secret: string, callId: string, checkId: string, excludeId?: string): Promise<Slot[]> {
  const day = DateTime.fromFormat(date, "yyyy-MM-dd", { zone: timezone });
  if (!day.isValid || day.toFormat("yyyy-MM-dd") !== date) return [];
  const now = DateTime.now().setZone(timezone);
  const slots: Slot[] = [];
  for (const person of staff) {
    const [shifts, appointments, timeOff] = await Promise.all([
      db.from("staff_availability").select("start_time,end_time").eq("clinic_id", CLINIC_ID).eq("staff_id", person.id).eq("day_of_week", day.weekday % 7).eq("is_available", true),
      db.from("appointments").select("id,start_time,end_time").eq("clinic_id", CLINIC_ID).eq("staff_id", person.id).neq("status", "Cancelled").lt("start_time", day.plus({ days: 1 }).toUTC().toISO()).gt("end_time", day.toUTC().toISO()),
      db.from("staff_time_off").select("start_time,end_time").eq("clinic_id", CLINIC_ID).eq("staff_id", person.id).lt("start_time", day.plus({ days: 1 }).toUTC().toISO()).gt("end_time", day.toUTC().toISO()),
    ]);
    if (shifts.error || appointments.error || timeOff.error) throw shifts.error ?? appointments.error ?? timeOff.error;
    for (const shift of shifts.data ?? []) {
      let start = DateTime.fromISO(`${date}T${shift.start_time}`, { zone: timezone });
      const end = DateTime.fromISO(`${date}T${shift.end_time}`, { zone: timezone });
      if (start.isValid) start = start.plus({ minutes: (30 - start.minute % 30) % 30 }).set({ second: 0, millisecond: 0 });
      while (start.isValid && end.isValid && start.plus({ minutes: SLOT_MINUTES }) <= end) {
        const finish = start.plus({ minutes: SLOT_MINUTES });
        const overlap = (items: any[]) => items.some(item => DateTime.fromISO(item.start_time) < finish && DateTime.fromISO(item.end_time) > start);
        if (start > now && !overlap((appointments.data ?? []).filter((a: any) => a.id !== excludeId)) && !overlap(timeOff.data ?? [])) {
          const checkedSlotId = crypto.randomUUID();
          slots.push({ slot_id: await tokenFor(person, service, start, secret, callId, checkId, checkedSlotId),
            checked_slot_id: checkedSlotId, start_time: start.toUTC().toISO()!, end_time: finish.toUTC().toISO()!, practitioner_id: person.id,
            practitioner_name: person.full_name, service_name: service, date, time: start.toFormat("HH:mm"), duration_minutes: SLOT_MINUTES, timezone });
        }
        start = finish;
      }
    }
  }
  return slots.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const raw = await req.text();
    const secret = Deno.env.get("RETELL_API_KEY");
    if (!secret || !await Retell.verify(raw, secret, req.headers.get("x-retell-signature") ?? ""))
      return new Response("Unauthorized", { status: 401 });
    try {
      const payload = JSON.parse(raw);
      if (payload.call?.agent_id !== AGENT_ID) return Response.json(failure("unauthorized_agent"));
      const args: Record<string, unknown> = payload.args ?? payload;
      const action = value(args, "action");
      const callId = typeof payload.call?.call_id === "string" ? payload.call.call_id : value(args, "call_id") || null;
      const db = ctx.supabaseAdmin;
      if (!callId) return Response.json(failure("missing_call_id"));
      if (action === "invalidate") {
        const { error } = await db.from("voice_call_state").upsert({ call_id: callId, clinic_id: CLINIC_ID,
          current_check_id: null, updated_at: new Date().toISOString() }, { onConflict: "call_id" });
        if (error) throw error;
        return Response.json({ success: true, availability_invalidated: true });
      }
      if (action === "resolve" || action === "availability") {
        const checkId = crypto.randomUUID();
        const { error: resetError } = await db.from("voice_call_state").upsert({ call_id: callId, clinic_id: CLINIC_ID,
          current_check_id: action === "availability" ? checkId : null, updated_at: new Date().toISOString() }, { onConflict: "call_id" });
        if (resetError) throw resetError;
        const staff = await loadStaff(db);
        const serviceResult = resolveService(staff, value(args, "service_name"));
        if (serviceResult.status !== "resolved") return Response.json({ ...failure(`service_${serviceResult.status}`), service_candidates: serviceResult.candidates ?? [] });
        const service = serviceResult.service!;
        const qualified = staff.filter(s => s.services.includes(service));
        const requestedName = value(args, "practitioner_name");
        const requestedId = value(args, "practitioner_id");
        if (action === "availability") {
          const mode = value(args, "practitioner_mode");
          if (mode !== "specific" && mode !== "any") return Response.json(failure("practitioner_preference_missing"));
          if (mode === "specific" && !requestedName && !requestedId) return Response.json(failure("practitioner_missing"));
          if (mode === "any" && (requestedName || requestedId)) return Response.json(failure("practitioner_mode_mismatch"));
        }
        let selected = qualified;
        if (requestedName || requestedId) {
          const result = requestedId
            ? { status: staff.some(s => s.id === requestedId) ? "resolved" : "not_found", practitioner: staff.find(s => s.id === requestedId) }
            : resolveStaff(staff, requestedName);
          if (result.status !== "resolved" || !result.practitioner)
            return Response.json({ ...failure(`practitioner_${result.status}`), practitioner_found: false, practitioner_candidates: result.candidates ?? [] });
          if (!qualified.some(s => s.id === result.practitioner!.id))
            return Response.json({ ...failure("service_mismatch"), practitioner_found: true, service_supported: false,
              qualified_practitioners: qualified.map(s => ({ id: s.id, name: s.full_name })) });
          selected = [result.practitioner];
        }
        const base = { success: true, service_name: service, service_supported: true, practitioner_found: true,
          qualified_practitioners: qualified.map(s => ({ id: s.id, name: s.full_name, specialty: s.specialty })),
          selected_practitioner_id: selected.length === 1 ? selected[0].id : null,
          selected_practitioner_name: selected.length === 1 ? selected[0].full_name : null };
        if (action === "resolve") return Response.json({ ...base, selected_practitioner: selected.length === 1 ? selected[0] : null });
        const timezone = await loadTimezone(db);
        let excludeAppointmentId: string | undefined;
        const existingId = value(args, "appointment_id");
        if (existingId) {
          const patientName = value(args, "client_name");
          const patientPhone = phone(args.client_phone);
          if (!patientName || !patientPhone) return Response.json(failure("invalid_patient_or_phone"));
          const { data: existing, error: existingError } = await db.from("appointments")
            .select("id,client_id,start_time").eq("id", existingId).eq("clinic_id", CLINIC_ID)
            .neq("status", "Cancelled").maybeSingle();
          if (existingError) throw existingError;
          if (!existing || DateTime.fromISO(existing.start_time) <= DateTime.now())
            return Response.json(failure("appointment_not_found"));
          const { data: patient, error: patientError } = await db.from("clients")
            .select("full_name,phone").eq("id", existing.client_id).eq("clinic_id", CLINIC_ID).maybeSingle();
          if (patientError) throw patientError;
          if (!patient || patient.full_name.trim().toLowerCase() !== patientName.toLowerCase() || phone(patient.phone) !== patientPhone)
            return Response.json(failure("patient_mismatch"));
          excludeAppointmentId = existing.id;
        }
        const requestedDate = value(args, "requested_date");
        const earliest = value(args, "search_mode") === "earliest";
        if (!earliest && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return Response.json(failure("invalid_date"));
        const first = earliest ? DateTime.now().setZone(timezone).startOf("day") : DateTime.fromFormat(requestedDate, "yyyy-MM-dd", { zone: timezone });
        if (!first.isValid || first < DateTime.now().setZone(timezone).startOf("day")) return Response.json(failure("past_or_invalid_date"));
        const maxDays = earliest ? 30 : 1;
        const windowStart = value(args, "window_start");
        const windowEnd = value(args, "window_end");
        const exactTime = value(args, "requested_time");
        if ([windowStart, windowEnd, exactTime].some(t => t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return Response.json(failure("invalid_time"));
        let all: Slot[] = [];
        for (let offset = 0; offset < maxDays; offset++) {
          const day = first.plus({ days: offset }).toFormat("yyyy-MM-dd");
          const found = (await availableSlots(db, selected, service, day, timezone, secret, callId, checkId, excludeAppointmentId)).filter(s =>
            (!windowStart || s.time >= windowStart) && (!windowEnd || s.time < windowEnd));
          all.push(...found);
          if (earliest && all.length) break;
        }
        const requestedTimeAvailable = exactTime ? all.some(s => s.time === exactTime) : null;
        if (exactTime) all.sort((a, b) => (a.time === exactTime ? -1 : b.time === exactTime ? 1 : 0));
        const offered = all.slice(0, 12);
        if (offered.length) {
          const { error: saveError } = await db.from("voice_checked_slots").insert(offered.map(s => ({
            id: s.checked_slot_id, check_id: checkId, call_id: callId, clinic_id: CLINIC_ID,
            staff_id: s.practitioner_id, service: s.service_name, start_time: s.start_time,
            end_time: s.end_time, expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          })));
          if (saveError) throw saveError;
        }
        return Response.json({ ...base, available: offered.length > 0, requested_time_available: requestedTimeAvailable,
          date: earliest ? all[0]?.date ?? first.toFormat("yyyy-MM-dd") : requestedDate, timezone,
          slots: offered.map(({ checked_slot_id, start_time, end_time, ...publicSlot }) => publicSlot),
          error_type: offered.length ? null : "no_slots" });
      }
      if (action === "book" || action === "reschedule") {
        const slotId = value(args, "slot_id");
        const slot = await readToken(slotId, secret);
        if (!slot || slot.k !== callId) return Response.json(failure("stale_or_invalid_slot"));
        const patientName = value(args, "client_name");
        const patientPhone = phone(args.client_phone);
        if (!patientName || !patientPhone) return Response.json(failure("invalid_patient_or_phone"));
        const appointmentId = value(args, "appointment_id");
        if (action === "reschedule" && !/^[0-9a-f-]{36}$/i.test(appointmentId)) return Response.json(failure("invalid_appointment_id"));
        const start = DateTime.fromISO(slot.t);
        const timezone = await loadTimezone(db);
        const localStart = start.setZone(timezone);
        if (value(args, "service_name") !== slot.v || value(args, "practitioner_id") !== slot.s ||
          value(args, "appointment_date") !== localStart.toFormat("yyyy-MM-dd") ||
          value(args, "appointment_time") !== localStart.toFormat("HH:mm"))
          return Response.json(failure("slot_mismatch"));
        const key = await operationKey(action, `${slotId}:${patientName}:${patientPhone}`, appointmentId);
        const { data: prior, error: priorError } = await db.from("voice_operations")
          .select("result").eq("operation_key", key).eq("clinic_id", CLINIC_ID).maybeSingle();
        if (priorError) throw priorError;
        if (prior?.result?.success === true) return Response.json(prior.result);
        const { data: state, error: stateError } = await db.from("voice_call_state")
          .select("current_check_id").eq("call_id", callId).eq("clinic_id", CLINIC_ID).maybeSingle();
        if (stateError) throw stateError;
        if (state?.current_check_id !== slot.i) return Response.json(failure("stale_or_invalid_slot"));
        if (!start.isValid || start <= DateTime.now()) return Response.json(failure("past_or_invalid_slot"));
        const { data, error } = await db.rpc("voice_apply_appointment", {
          p_action: action, p_clinic_id: CLINIC_ID, p_operation_key: key, p_call_id: callId, p_appointment_id: appointmentId || null,
          p_client_name: patientName, p_client_phone: patientPhone,
          p_caller_name: value(args, "caller_name") || null, p_caller_phone: phone(args.caller_phone),
          p_staff_id: slot.s, p_service: slot.v,
          p_start: start.toUTC().toISO(), p_end: start.plus({ minutes: SLOT_MINUTES }).toUTC().toISO(),
          p_check_id: slot.i, p_slot_id: slot.q,
        });
        if (error) { console.error("Voice operation failed", error); return Response.json(failure("database_error")); }
        return Response.json(data);
      }
      if (action === "lookup") {
        const patientName = value(args, "client_name");
        const patientPhone = phone(args.client_phone);
        if (!patientName || !patientPhone) return Response.json(failure("invalid_patient_or_phone"));
        const { data: clients, error: clientError } = await db.from("clients").select("id,full_name,phone")
          .eq("clinic_id", CLINIC_ID).ilike("full_name", patientName);
        if (clientError) throw clientError;
        const ids = (clients ?? []).filter((c: any) => phone(c.phone) === patientPhone).map((c: any) => c.id);
        if (!ids.length) return Response.json({ success: true, appointments: [], count: 0 });
        const { data, error } = await db.from("appointments").select("id,service,staff_id,start_time,end_time,status")
          .eq("clinic_id", CLINIC_ID).in("client_id", ids).neq("status", "Cancelled")
          .gte("start_time", new Date().toISOString()).order("start_time");
        if (error) throw error;
        return Response.json({ success: true, appointments: data ?? [], count: data?.length ?? 0 });
      }
      if (action === "cancel") {
        const appointmentId = value(args, "appointment_id");
        const patientName = value(args, "client_name");
        const patientPhone = phone(args.client_phone);
        if (!appointmentId || !patientName || !patientPhone || args.confirmed !== true) return Response.json(failure("confirmation_or_patient_missing"));
        const key = await operationKey("cancel", value(args, "operation_id") || appointmentId, appointmentId);
        const { data, error } = await db.rpc("voice_apply_appointment", {
          p_action: "cancel", p_clinic_id: CLINIC_ID, p_operation_key: key, p_call_id: callId, p_appointment_id: appointmentId,
          p_client_name: patientName, p_client_phone: patientPhone,
          p_caller_name: value(args, "caller_name") || null, p_caller_phone: phone(args.caller_phone),
          p_staff_id: null, p_service: null, p_start: null, p_end: null, p_check_id: null, p_slot_id: null,
        });
        if (error) { console.error("Cancellation failed", error); return Response.json(failure("database_error")); }
        return Response.json(data);
      }
      if (["message", "callback", "urgent"].includes(action)) {
        const contactPhone = phone(args.caller_phone);
        const reason = value(args, "reason");
        if (!contactPhone || !reason) return Response.json(failure("invalid_contact_or_reason"));
        const requestKey = await operationKey(action, `${callId ?? "unknown"}:${contactPhone}:${reason}`);
        const { data, error } = await db.from("voice_requests").insert({ clinic_id: CLINIC_ID, request_key: requestKey, call_id: callId,
          kind: action, caller_name: value(args, "caller_name") || null, patient_name: value(args, "patient_name") || null,
          phone: contactPhone, reason, status: "Open" }).select("id,status").single();
        if (error?.code === "23505") {
          const existing = await db.from("voice_requests").select("id,status")
            .eq("clinic_id", CLINIC_ID).eq("request_key", requestKey).single();
          if (!existing.error && existing.data) return Response.json({ success: true, request_id: existing.data.id, status: existing.data.status });
        }
        if (error || !data) { console.error("Voice request failed", error); return Response.json(failure("database_error")); }
        return Response.json({ success: true, request_id: data.id, status: data.status });
      }
      return Response.json(failure("unknown_action"));
    } catch (error) {
      console.error("Voice tool error", error);
      return Response.json(failure("tool_error"));
    }
  }),
};
