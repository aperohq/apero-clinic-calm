import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

import { resolveVoiceIntegration } from "../_shared/voice-integration.ts";
import { logDatabaseFailure, readLimitedBody, RequestBodyTooLargeError } from "../_shared/request-security.ts";

function normalizePhone(phone: string | null | undefined) {
  if (!phone) return null;
  return phone.replace(/[^\d+]/g, "");
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function normalizeTranscript(items: any[] | undefined) {
  if (!Array.isArray(items)) return null;

  return items.map((item) => ({
    speaker: item.role === "agent" ? "Apero" : "Caller",
    text: item.content ?? "",
    time: formatTime(item.words?.[0]?.start ?? 0),
  }));
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let rawBody: string;
    try { rawBody = await readLimitedBody(req, 2 * 1024 * 1024); }
    catch (error) { return new Response("Request body too large", { status: error instanceof RequestBodyTooLargeError ? 413 : 400 }); }
    const signature = req.headers.get("x-retell-signature");
    const timestamp = signature?.match(/^v=(\d+),d=[0-9a-fA-F]+$/)?.[1];
    if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000)
      return new Response("Unauthorized", { status: 401 });
    const identity = await resolveVoiceIntegration(ctx.supabaseAdmin, rawBody, signature);
    if (!identity) return new Response("Unauthorized", { status: 401 });
    const clinicId = identity.integration.clinic_id;

    let payload: any;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const { event, call } = payload;

    // For now we only care about completed/analyzed calls.
    if (!["call_ended", "call_analyzed"].includes(event)) {
      return new Response(null, { status: 204 });
    }

    if (!call?.call_id) {
      return new Response("Missing call_id", { status: 400 });
    }
    const { data: existingCall, error: existingCallError } = await ctx.supabaseAdmin
      .from("conversations").select("clinic_id").eq("retell_call_id", call.call_id).maybeSingle();
    if (existingCallError) return new Response("Database error", { status: 500 });
    if (existingCall && existingCall.clinic_id !== clinicId)
      return new Response("Call clinic mismatch", { status: 403 });

    const analysis = call.call_analysis ?? {};
    const custom = analysis.custom_analysis_data ?? {};
    const collected = call.collected_dynamic_variables ?? {};

    // Keep the patient side of telephony calls; web calls need a collected number.
    const telephonyPatientPhone = call.direction === "outbound"
      ? call.to_number
      : call.from_number;
    const callerPhone = [
      telephonyPatientPhone,
      custom.client_phone,
      collected.client_phone,
      collected.callback_number,
    ].find((phone) => typeof phone === "string" && phone.trim()) ?? null;

    const normalizedCaller = normalizePhone(callerPhone);

    // Operational outcomes come from successful server-side actions, never from
    // a summary or an unverified post-call model extraction.
    const { data: operations, error: operationsError } = await ctx.supabaseAdmin
      .from("voice_operations")
      .select("action,result")
      .eq("clinic_id", clinicId)
      .eq("call_id", call.call_id)
      .order("created_at", { ascending: false });
    if (operationsError) {
      logDatabaseFailure("Retell operations lookup", operationsError);
      return new Response("Database error", { status: 500 });
    }
    const completedOperations = (operations ?? []).filter((o: any) => o.result?.success === true);
    const lastOperation = completedOperations[0] ?? null;
    const { data: savedRequests, error: requestsError } = await ctx.supabaseAdmin
      .from("voice_requests").select("id").eq("clinic_id", clinicId)
      .eq("call_id", call.call_id).limit(1);
    if (requestsError) {
      logDatabaseFailure("Retell requests lookup", requestsError);
      return new Response("Database error", { status: 500 });
    }

    // Try to connect the call with an existing Apero client.
    let clientId: string | null = null;

    const { data: clients, error: clientsError } = await ctx.supabaseAdmin
      .from("clients")
      .select("id, phone")
      .eq("clinic_id", clinicId);
    if (clientsError) {
      logDatabaseFailure("Retell client lookup", clientsError);
      return new Response("Database error", { status: 500 });
    }

    if (normalizedCaller && clients) {
      const client = clients.find(
        (c: any) => normalizePhone(c.phone) === normalizedCaller,
      );

      clientId = client?.id ?? null;
    }

    // Link an appointment only when it belongs to this clinic. The appointment's
    // patient wins over the caller's phone (a parent may book for a child).
    let appointmentId: string | null = null;
    const collectedAppointmentId = lastOperation?.result?.appointment_id ?? collected.appointment_id;
    if (typeof collectedAppointmentId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(collectedAppointmentId)) {
      const { data: appointment, error: appointmentError } = await ctx.supabaseAdmin
        .from("appointments")
        .select("id,client_id")
        .eq("id", collectedAppointmentId)
        .eq("clinic_id", clinicId)
        .maybeSingle();

      if (appointmentError) {
        logDatabaseFailure("Retell appointment validation", appointmentError);
        return new Response("Database error", { status: 500 });
      }
      if (appointment && (lastOperation || appointment.client_id === clientId)) {
        appointmentId = appointment.id;
        clientId = appointment.client_id;
      }
    }

    const summary =
      analysis.call_summary ??
      call.call_summary ??
      null;

    const booked = completedOperations.some((o: any) => o.action === "book");

    const missedReasons = [
      "dial_no_answer",
      "dial_busy",
      "dial_failed",
      "user_declined",
      "error_user_not_joined",
    ];

    let status = "Completed";

    if (booked) {
      status = "Booked";
    } else if (missedReasons.includes(call.disconnection_reason)) {
      status = "Missed";
    } else if (analysis.call_successful === false) {
      status = "Needs Review";
    }

    const outcome = lastOperation?.action === "book" ? "Appointment Booked"
      : lastOperation?.action === "reschedule" ? "Appointment Rescheduled"
      : lastOperation?.action === "cancel" ? "Appointment Cancelled"
      : savedRequests?.length ? "Follow-up Needed"
      : analysis.call_successful === true ? "General Inquiry"
      : "No Appointment";

    const title =
      custom.call_title ??
      custom.intent ??
      (booked ? "Appointment Booking Call" : "Phone Call");

    const row: Record<string, any> = {
      clinic_id: clinicId,
      client_id: clientId,
      retell_call_id: call.call_id,
      retell_agent_id: call.agent_id ?? null,
      caller_phone: callerPhone ?? null,
      title,
      status,
      outcome,
    };

    if (appointmentId) {
      row.appointment_id = appointmentId;
    }

    if (call.start_timestamp) {
      row.started_at = new Date(call.start_timestamp).toISOString();
    }

    if (typeof call.duration_ms === "number") {
      row.duration_seconds = Math.round(call.duration_ms / 1000);
    }

    if (call.transcript_object) {
      row.transcript = normalizeTranscript(call.transcript_object);
    }

    if (call.recording_url) {
      row.recording_url = call.recording_url;
    }

    if (summary) {
      row.summary = summary;
    }

    const { error } = await ctx.supabaseAdmin
      .from("conversations")
      .upsert(row, {
        onConflict: "retell_call_id",
        ignoreDuplicates: event === "call_ended",
      });

    if (error) {
      logDatabaseFailure("Retell conversation save", error);
      return new Response("Database error", { status: 500 });
    }

    console.log(`Processed Retell ${event}`);

    return new Response(null, { status: 204 });
  }),
};
