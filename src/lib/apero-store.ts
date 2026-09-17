// Supabase-backed data layer for the Apero clinic workspace.
// All reads and writes are scoped to the signed-in user's clinic by RLS.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth";
import type {
  AppointmentRow, ClientNoteRow, ClientRow, ConversationRow,
  StaffAvailabilityRow, StaffTimeOffRow, StaffRow,
} from "@/lib/db-types";

export type Client = ClientRow & { name: string; initials: string };
export type StaffMember = StaffRow & { name: string; initials: string; role: string };

export function initialsOf(name: string) {
  const parts = name.trim().replace(/^(dr|dr\.)\s+/i, "").split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((p) => p[0]).join("") || "?").toUpperCase();
}

const decorateClient = (row: ClientRow): Client => ({ ...row, name: row.full_name, initials: initialsOf(row.full_name) });
const decorateStaff = (row: StaffRow): StaffMember => ({ ...row, name: row.full_name, initials: initialsOf(row.full_name), role: row.specialty });

function useClinicId() {
  const { profile } = useAuth();
  return profile?.clinic_id ?? null;
}

export function useClients() {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["clients", clinicId],
    enabled: !!clinicId,
    queryFn: async () => {
      const { data, error } = await db.from("clients").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(decorateClient);
    },
  });
  return query.data ?? [];
}

export function useStaff() {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["staff", clinicId],
    enabled: !!clinicId,
    queryFn: async () => {
      const { data, error } = await db.from("staff").select("*").order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(decorateStaff);
    },
  });
  return query.data ?? [];
}

export function useAppointments() {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["appointments", clinicId],
    enabled: !!clinicId,
    queryFn: async () => {
      const { data, error } = await db.from("appointments").select("*").order("start_time", { ascending: true });
      if (error) throw error;
      return (data ?? []) as AppointmentRow[];
    },
  });
  return query.data ?? [];
}

export function useConversations() {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["conversations", clinicId],
    enabled: !!clinicId,
    queryFn: async () => {
      const { data, error } = await db.from("conversations").select("*").order("started_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ConversationRow[];
    },
  });
  return query.data ?? [];
}

export function useAvailability(staffId: string) {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["availability", clinicId, staffId],
    enabled: !!clinicId && !!staffId,
    queryFn: async () => {
      const { data, error } = await db.from("staff_availability").select("*").eq("clinic_id", clinicId!).eq("staff_id", staffId).order("day_of_week");
      if (error) throw error;
      return (data ?? []) as StaffAvailabilityRow[];
    },
  });
  return query;
}

export function useClientNotes(clientId: string) {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["client_notes", clinicId, clientId],
    enabled: !!clinicId && !!clientId,
    queryFn: async () => {
      const { data, error } = await db.from("client_notes").select("*").eq("client_id", clientId).order("created_at");
      if (error) throw error;
      return (data ?? []) as ClientNoteRow[];
    },
  });
  return query;
}

function useClinicMutation<TInput>(keys: string[], run: (clinicId: string, input: TInput) => Promise<void>) {
  const clinicId = useClinicId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => {
      if (!clinicId) throw new Error("No clinic is linked to your account yet.");
      await run(clinicId, input);
    },
    onSuccess: () => { keys.forEach((k) => void queryClient.invalidateQueries({ queryKey: [k] })); },
  });
}

export function useAddClient() {
  return useClinicMutation<{ name: string; phone: string; email?: string; notes?: string }>(["clients"], async (clinicId, input) => {
    const { error } = await db.from("clients").insert({
      clinic_id: clinicId, full_name: input.name.trim(), phone: input.phone.trim(),
      email: input.email?.trim() || null, notes: input.notes?.trim() || null,
    });
    if (error) throw error;
  });
}

export function useUpdateClient() {
  return useClinicMutation<{ id: string; full_name?: string; phone?: string; email?: string | null; notes?: string | null }>(["clients"], async (_c, input) => {
    const { id, ...patch } = input;
    const { error } = await db.from("clients").update(patch).eq("id", id);
    if (error) throw error;
  });
}

export function useAddStaff() {
  return useClinicMutation<{ name: string; specialty: string; phone?: string; email?: string; services?: string; schedule: { day_of_week: number; start_time: string; end_time: string; is_available: boolean }[] }>(["staff", "availability"], async (clinicId, input) => {
    const services = (input.services ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const { data: staffId, error } = await db.rpc("create_staff_with_schedule", {
      p_full_name: input.name.trim(), p_specialty: input.specialty.trim(),
      p_phone: input.phone?.trim() ?? "", p_email: input.email?.trim() ?? "",
      p_services: services, p_schedule: input.schedule,
    });
    if (error) throw error;
    if (!staffId) throw new Error("The staff member was not saved.");
    const { data: staff, error: staffError } = await db.from("staff")
      .select("id").eq("clinic_id", clinicId).eq("id", staffId).single();
    if (staffError) throw staffError;
    if (!staff) throw new Error("The staff member could not be verified.");
    const { data: saved, error: scheduleError } = await db.from("staff_availability")
      .select("day_of_week,start_time,end_time,is_available")
      .eq("clinic_id", clinicId).eq("staff_id", staffId);
    if (scheduleError) throw scheduleError;
    if (saved?.length !== input.schedule.length) throw new Error("The saved schedule could not be verified.");
    for (const row of input.schedule) {
      const result = saved?.find((item) => item.day_of_week === row.day_of_week);
      if (!result || result.start_time.slice(0, 5) !== row.start_time ||
          result.end_time.slice(0, 5) !== row.end_time || result.is_available !== row.is_available)
        throw new Error("The saved schedule could not be verified.");
    }
  });
}

export function useUpdateStaff() {
  return useClinicMutation<{ id: string; full_name?: string; specialty?: string; phone?: string | null; email?: string | null; services?: string[] }>(["staff"], async (_c, input) => {
    const { id, ...patch } = input;
    const { data, error } = await db.from("staff").update(patch).eq("id", id).select("id").single();
    if (error) throw error;
    if (!data) throw new Error("The staff member was not updated.");
  });
}

export function useSaveAvailability() {
  return useClinicMutation<{ staffId: string; rows: { day_of_week: number; start_time: string; end_time: string; is_available: boolean }[] }>(["availability"], async (clinicId, input) => {
    const { data: before, error: beforeError } = await db.from("staff_availability")
      .select("day_of_week").eq("clinic_id", clinicId).eq("staff_id", input.staffId);
    if (beforeError) throw beforeError;
    if (new Set((before ?? []).map((r) => r.day_of_week)).size !== (before ?? []).length)
      throw new Error("This practitioner has multiple shifts on one day. Contact support before editing.");
    const rows = input.rows.filter((r) => r.start_time && r.end_time);
    if ((before ?? []).some((saved) => !rows.some((row) => row.day_of_week === saved.day_of_week)))
      throw new Error("Existing hours cannot be blank. Turn off the working day instead.");
    if (rows.some((r) => r.end_time <= r.start_time)) throw new Error("End time must be after start time.");
    if (!rows.length) return;
    const { data, error } = await db.from("staff_availability").upsert(
      rows.map((r) => ({ ...r, clinic_id: clinicId, staff_id: input.staffId })),
      { onConflict: "staff_id,day_of_week" },
    ).select("day_of_week");
    if (error) throw error;
    if (data?.length !== rows.length) throw new Error("The full schedule was not saved.");
    const { data: saved, error: readError } = await db.from("staff_availability")
      .select("day_of_week,start_time,end_time,is_available")
      .eq("clinic_id", clinicId).eq("staff_id", input.staffId)
      .in("day_of_week", rows.map((r) => r.day_of_week));
    if (readError) throw readError;
    if (saved?.length !== rows.length) throw new Error("The saved schedule could not be verified.");
    for (const row of rows) {
      const result = saved?.find((item) => item.day_of_week === row.day_of_week);
      if (!result || result.start_time.slice(0, 5) !== row.start_time ||
          result.end_time.slice(0, 5) !== row.end_time || result.is_available !== row.is_available)
        throw new Error("The saved schedule could not be verified.");
    }
  });
}

export function useTimeOff(staffId: string) {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["time_off", clinicId, staffId], enabled: !!clinicId && !!staffId,
    queryFn: async () => {
      const { data, error } = await db.from("staff_time_off").select("*")
        .eq("clinic_id", clinicId!).eq("staff_id", staffId).order("start_time");
      if (error) throw error;
      return (data ?? []) as StaffTimeOffRow[];
    },
  });
  return query;
}

export function useSaveTimeOff() {
  return useClinicMutation<{ id?: string; staffId: string; startTime: string; endTime: string; reason: string }>(["time_off"], async (clinicId, input) => {
    if (new Date(input.endTime) <= new Date(input.startTime)) throw new Error("End time must be after start time.");
    const values = { start_time: input.startTime, end_time: input.endTime, reason: input.reason.trim() || null };
    const query = input.id
      ? db.from("staff_time_off").update(values).eq("id", input.id).eq("clinic_id", clinicId).eq("staff_id", input.staffId)
      : db.from("staff_time_off").insert({ ...values, clinic_id: clinicId, staff_id: input.staffId });
    const { data, error } = await query.select("id,start_time,end_time,reason").single();
    if (error) throw error;
    if (!data) throw new Error("The time off was not saved.");
    const { data: reloaded, error: readError } = await db.from("staff_time_off")
      .select("start_time,end_time,reason").eq("id", data.id)
      .eq("clinic_id", clinicId).eq("staff_id", input.staffId).single();
    if (readError) throw readError;
    if (!reloaded || new Date(reloaded.start_time).getTime() !== new Date(input.startTime).getTime() ||
      new Date(reloaded.end_time).getTime() !== new Date(input.endTime).getTime() || reloaded.reason !== values.reason)
      throw new Error("The saved time off could not be verified.");
  });
}

export function useRemoveTimeOff() {
  return useClinicMutation<{ id: string; staffId: string }>(["time_off"], async (clinicId, input) => {
    const { data, error } = await db.from("staff_time_off").delete()
      .eq("id", input.id).eq("clinic_id", clinicId).eq("staff_id", input.staffId).select("id").single();
    if (error) throw error;
    if (!data) throw new Error("The time off was not removed.");
    const { data: remaining, error: readError } = await db.from("staff_time_off")
      .select("id").eq("id", input.id).eq("clinic_id", clinicId)
      .eq("staff_id", input.staffId).maybeSingle();
    if (readError) throw readError;
    if (remaining) throw new Error("The time off could not be verified as removed.");
  });
}

export function useAddClientNote() {
  const { profile } = useAuth();
  return useClinicMutation<{ clientId: string; note: string }>(["client_notes"], async (clinicId, input) => {
    const { error } = await db.from("client_notes").insert({
      clinic_id: clinicId, client_id: input.clientId, note: input.note.trim(),
      author_profile_id: profile?.id ?? null,
    });
    if (error) throw error;
  });
}

export function useCreateAppointment() {
  return useClinicMutation<{ clientId: string; staffId: string; service: string; date: string; time: string; minutes?: number; notes?: string }>(["appointments"], async (clinicId, input) => {
    const start = new Date(`${input.date}T${input.time}:00`);
    const end = new Date(start.getTime() + (input.minutes ?? 45) * 60000);
    const { error } = await db.from("appointments").insert({
      clinic_id: clinicId, client_id: input.clientId, staff_id: input.staffId,
      service: input.service.trim(), start_time: start.toISOString(), end_time: end.toISOString(),
      status: "Booked", source: "Front desk", notes: input.notes?.trim() || null,
    });
    if (error) throw error;
  });
}

export function useRescheduleAppointment() {
  return useClinicMutation<{ id: string; date: string; time: string; minutes?: number }>(["appointments"], async (_c, input) => {
    const start = new Date(`${input.date}T${input.time}:00`);
    const end = new Date(start.getTime() + (input.minutes ?? 45) * 60000);
    const { error } = await db.from("appointments")
      .update({ start_time: start.toISOString(), end_time: end.toISOString(), status: "Booked" })
      .eq("id", input.id);
    if (error) throw error;
  });
}

export function useCancelAppointment() {
  return useClinicMutation<{ id: string; reason?: string }>(["appointments"], async (_c, input) => {
    const { error } = await db.from("appointments")
      .update({ status: "Cancelled", notes: input.reason?.trim() || null })
      .eq("id", input.id);
    if (error) throw error;
  });
}

// ---------------------------------------------------------------- helpers
export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
export function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
export function formatDuration(seconds: number) {
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
export function durationLabel(startIso: string, endIso: string) {
  return `${Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000))} min`;
}
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
