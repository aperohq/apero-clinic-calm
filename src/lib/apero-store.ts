import { appointmentWriteError } from "@/lib/appointment-conflicts";
// Supabase-backed data layer for the Apero clinic workspace.
// Use the resolved account clinic for queries and writes; existing RLS remains
// the database enforcement boundary.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth";
import type {
  AppointmentRow,
  ClientNoteRow,
  ClientRow,
  ConversationRow,
  StaffAvailabilityRow,
  StaffTimeOffRow,
  StaffRow,
} from "@/lib/db-types";

export type Client = ClientRow & { name: string; initials: string };
export type StaffMember = StaffRow & { name: string; initials: string; role: string };

export function initialsOf(name: string) {
  const parts = name
    .trim()
    .replace(/^(dr|dr\.)\s+/i, "")
    .split(/\s+/)
    .filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((p) => p[0])
      .join("") || "?"
  ).toUpperCase();
}

const decorateClient = (row: ClientRow): Client => ({
  ...row,
  name: row.full_name,
  initials: initialsOf(row.full_name),
});
const decorateStaff = (row: StaffRow): StaffMember => ({
  ...row,
  name: row.full_name,
  initials: initialsOf(row.full_name),
  role: row.specialty,
});

function useClinicId() {
  const { clinicId } = useAuth();
  return clinicId;
}

export function useClients() {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["clients", clinicId],
    enabled: !!clinicId,
    queryFn: async () => {
      const { data, error } = await db
        .from("clients")
        .select("*")
        .eq("clinic_id", clinicId!)
        .order("created_at", { ascending: false });
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
      const { data, error } = await db
        .from("staff")
        .select("*")
        .eq("clinic_id", clinicId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map(decorateStaff);
    },
  });
  return query.data ?? [];
}

export function useAppointments(window?: { start: string; end: string }) {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: window
      ? ["appointments", clinicId, window.start, window.end]
      : ["appointments", clinicId],
    refetchInterval: 30_000,
    enabled: !!clinicId,
    queryFn: async () => {
      const rows: AppointmentRow[] = [];
      for (let offset = 0; ; offset += 1000) {
        let request = db
          .from("appointments")
          .select("*")
          .eq("clinic_id", clinicId!)
          .order("start_time", { ascending: true })
          .order("id")
          .range(offset, offset + 999);
        if (window) request = request.lt("start_time", window.end).gt("end_time", window.start);
        const { data, error } = await request;
        if (error) throw error;
        rows.push(...(data ?? []));
        if ((data?.length ?? 0) < 1000) break;
      }
      return rows;
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
      const { data, error } = await db
        .from("conversations")
        .select(
          "id,clinic_id,client_id,appointment_id,retell_call_id,retell_agent_id,title,status,outcome,caller_phone,started_at,duration_seconds,summary,transcript,created_at",
        )
        .eq("clinic_id", clinicId!)
        .order("started_at", { ascending: false });
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
      const { data, error } = await db
        .from("staff_availability")
        .select("*")
        .eq("clinic_id", clinicId!)
        .eq("staff_id", staffId)
        .order("day_of_week");
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
      const { data, error } = await db
        .from("client_notes")
        .select("*")
        .eq("clinic_id", clinicId!)
        .eq("client_id", clientId)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as ClientNoteRow[];
    },
  });
  return query;
}

function useClinicMutation<TInput>(
  keys: string[],
  run: (clinicId: string, input: TInput) => Promise<void>,
) {
  const clinicId = useClinicId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) => {
      if (!clinicId) throw new Error("No clinic is linked to your account yet.");
      await run(clinicId, input);
    },
    onSuccess: async () => {
      await Promise.all(
        keys.map((key) => queryClient.invalidateQueries({ queryKey: [key, clinicId] })),
      );
    },
  });
}

export function useAddClient() {
  return useClinicMutation<{ name: string; phone: string; email?: string; notes?: string }>(
    ["clients"],
    async (clinicId, input) => {
      const values = {
        clinic_id: clinicId,
        full_name: input.name.trim(),
        phone: input.phone.trim(),
        email: input.email?.trim() || null,
        notes: input.notes?.trim() || null,
      };
      const { data, error } = await db.from("clients").insert(values).select("id").single();
      if (error) throw error;
      const { data: saved, error: readError } = await db
        .from("clients")
        .select("full_name,phone,email,notes")
        .eq("id", data.id)
        .eq("clinic_id", clinicId)
        .single();
      if (
        readError ||
        !saved ||
        Object.entries(values).some(
          ([key, value]) => key !== "clinic_id" && saved[key as keyof typeof saved] !== value,
        )
      )
        throw new Error("The client could not be verified.");
    },
  );
}

export function useUpdateClient() {
  return useClinicMutation<{
    id: string;
    full_name?: string;
    phone?: string;
    email?: string | null;
    notes?: string | null;
  }>(["clients"], async (clinicId, input) => {
    const { id, ...patch } = input;
    const { data, error } = await db
      .from("clients")
      .update(patch)
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .select("id")
      .single();
    if (error) throw error;
    if (!data) throw new Error("The client was not updated.");
    const { data: saved, error: readError } = await db
      .from("clients")
      .select("full_name,phone,email,notes")
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .single();
    if (
      readError ||
      !saved ||
      Object.entries(patch).some(([key, value]) => saved[key as keyof typeof saved] !== value)
    )
      throw new Error("The client changes could not be verified.");
  });
}

export function useAddStaff() {
  return useClinicMutation<{
    name: string;
    specialty: string;
    phone?: string;
    email?: string;
    services?: string;
    schedule: {
      day_of_week: number;
      start_time: string;
      end_time: string;
      is_available: boolean;
    }[];
  }>(["staff", "availability"], async (clinicId, input) => {
    const services = (input.services ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const { data: staffId, error } = await db.rpc("create_staff_with_schedule", {
      p_full_name: input.name.trim(),
      p_specialty: input.specialty.trim(),
      p_phone: input.phone?.trim() ?? "",
      p_email: input.email?.trim() ?? "",
      p_services: services,
      p_schedule: input.schedule,
    });
    if (error) throw error;
    if (!staffId) throw new Error("The staff member was not saved.");
    const { data: staff, error: staffError } = await db
      .from("staff")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("id", staffId)
      .single();
    if (staffError) throw staffError;
    if (!staff) throw new Error("The staff member could not be verified.");
    const { data: saved, error: scheduleError } = await db
      .from("staff_availability")
      .select("day_of_week,start_time,end_time,is_available")
      .eq("clinic_id", clinicId)
      .eq("staff_id", staffId);
    if (scheduleError) throw scheduleError;
    if (saved?.length !== input.schedule.length)
      throw new Error("The saved schedule could not be verified.");
    for (const row of input.schedule) {
      const result = saved?.find((item) => item.day_of_week === row.day_of_week);
      if (
        !result ||
        result.start_time.slice(0, 5) !== row.start_time ||
        result.end_time.slice(0, 5) !== row.end_time ||
        result.is_available !== row.is_available
      )
        throw new Error("The saved schedule could not be verified.");
    }
  });
}

export function useUpdateStaff() {
  return useClinicMutation<{
    id: string;
    full_name?: string;
    specialty?: string;
    phone?: string | null;
    email?: string | null;
    services?: string[];
  }>(["staff"], async (clinicId, input) => {
    const { id, ...patch } = input;
    const { data, error } = await db
      .from("staff")
      .update(patch)
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .select("id")
      .single();
    if (error) throw error;
    if (!data) throw new Error("The staff member was not updated.");
    const { data: saved, error: readError } = await db
      .from("staff")
      .select("full_name,specialty,phone,email,services")
      .eq("id", id)
      .eq("clinic_id", clinicId)
      .single();
    if (
      readError ||
      !saved ||
      Object.entries(patch).some(([key, value]) =>
        key === "services"
          ? JSON.stringify(saved.services) !== JSON.stringify(value)
          : saved[key as keyof typeof saved] !== value,
      )
    )
      throw new Error("The staff changes could not be verified.");
  });
}

export function useSaveAvailability() {
  return useClinicMutation<{
    staffId: string;
    rows: { day_of_week: number; start_time: string; end_time: string; is_available: boolean }[];
  }>(["availability"], async (clinicId, input) => {
    const { data: before, error: beforeError } = await db
      .from("staff_availability")
      .select("day_of_week")
      .eq("clinic_id", clinicId)
      .eq("staff_id", input.staffId);
    if (beforeError) throw beforeError;
    if (new Set((before ?? []).map((r) => r.day_of_week)).size !== (before ?? []).length)
      throw new Error(
        "This practitioner has multiple shifts on one day. Contact support before editing.",
      );
    const rows = input.rows.filter((r) => r.start_time && r.end_time);
    if ((before ?? []).some((saved) => !rows.some((row) => row.day_of_week === saved.day_of_week)))
      throw new Error("Existing hours cannot be blank. Turn off the working day instead.");
    if (rows.some((r) => r.end_time <= r.start_time))
      throw new Error("End time must be after start time.");
    if (!rows.length) return;
    const { data, error } = await db
      .from("staff_availability")
      .upsert(
        rows.map((r) => ({ ...r, clinic_id: clinicId, staff_id: input.staffId })),
        { onConflict: "staff_id,day_of_week" },
      )
      .select("day_of_week");
    if (error) throw error;
    if (data?.length !== rows.length) throw new Error("The full schedule was not saved.");
    const { data: saved, error: readError } = await db
      .from("staff_availability")
      .select("day_of_week,start_time,end_time,is_available")
      .eq("clinic_id", clinicId)
      .eq("staff_id", input.staffId)
      .in(
        "day_of_week",
        rows.map((r) => r.day_of_week),
      );
    if (readError) throw readError;
    if (saved?.length !== rows.length) throw new Error("The saved schedule could not be verified.");
    for (const row of rows) {
      const result = saved?.find((item) => item.day_of_week === row.day_of_week);
      if (
        !result ||
        result.start_time.slice(0, 5) !== row.start_time ||
        result.end_time.slice(0, 5) !== row.end_time ||
        result.is_available !== row.is_available
      )
        throw new Error("The saved schedule could not be verified.");
    }
  });
}

export function useTimeOff(staffId: string) {
  const clinicId = useClinicId();
  const query = useQuery({
    queryKey: ["time_off", clinicId, staffId],
    enabled: !!clinicId && !!staffId,
    queryFn: async () => {
      const { data, error } = await db
        .from("staff_time_off")
        .select("*")
        .eq("clinic_id", clinicId!)
        .eq("staff_id", staffId)
        .order("start_time");
      if (error) throw error;
      return (data ?? []) as StaffTimeOffRow[];
    },
  });
  return query;
}

export function useSaveTimeOff() {
  return useClinicMutation<{
    id?: string;
    staffId: string;
    startTime: string;
    endTime: string;
    reason: string;
  }>(["time_off"], async (clinicId, input) => {
    if (new Date(input.endTime) <= new Date(input.startTime))
      throw new Error("End time must be after start time.");
    const values = {
      start_time: input.startTime,
      end_time: input.endTime,
      reason: input.reason.trim() || null,
    };
    const query = input.id
      ? db
          .from("staff_time_off")
          .update(values)
          .eq("id", input.id)
          .eq("clinic_id", clinicId)
          .eq("staff_id", input.staffId)
      : db
          .from("staff_time_off")
          .insert({ ...values, clinic_id: clinicId, staff_id: input.staffId });
    const { data, error } = await query.select("id,start_time,end_time,reason").single();
    if (error) throw error;
    if (!data) throw new Error("The time off was not saved.");
    const { data: reloaded, error: readError } = await db
      .from("staff_time_off")
      .select("start_time,end_time,reason")
      .eq("id", data.id)
      .eq("clinic_id", clinicId)
      .eq("staff_id", input.staffId)
      .single();
    if (readError) throw readError;
    if (
      !reloaded ||
      new Date(reloaded.start_time).getTime() !== new Date(input.startTime).getTime() ||
      new Date(reloaded.end_time).getTime() !== new Date(input.endTime).getTime() ||
      reloaded.reason !== values.reason
    )
      throw new Error("The saved time off could not be verified.");
  });
}

export function useRemoveTimeOff() {
  return useClinicMutation<{ id: string; staffId: string }>(
    ["time_off"],
    async (clinicId, input) => {
      const { data, error } = await db
        .from("staff_time_off")
        .delete()
        .eq("id", input.id)
        .eq("clinic_id", clinicId)
        .eq("staff_id", input.staffId)
        .select("id")
        .single();
      if (error) throw error;
      if (!data) throw new Error("The time off was not removed.");
      const { data: remaining, error: readError } = await db
        .from("staff_time_off")
        .select("id")
        .eq("id", input.id)
        .eq("clinic_id", clinicId)
        .eq("staff_id", input.staffId)
        .maybeSingle();
      if (readError) throw readError;
      if (remaining) throw new Error("The time off could not be verified as removed.");
    },
  );
}

export function useAddClientNote() {
  const { profile } = useAuth();
  return useClinicMutation<{ clientId: string; note: string }>(
    ["client_notes"],
    async (clinicId, input) => {
      const values = {
        clinic_id: clinicId,
        client_id: input.clientId,
        note: input.note.trim(),
        author_profile_id: profile?.id ?? null,
      };
      const { data, error } = await db.from("client_notes").insert(values).select("id").single();
      if (error) throw error;
      const { data: saved, error: readError } = await db
        .from("client_notes")
        .select("client_id,note,author_profile_id")
        .eq("id", data.id)
        .eq("clinic_id", clinicId)
        .single();
      if (
        readError ||
        !saved ||
        saved.client_id !== values.client_id ||
        saved.note !== values.note ||
        saved.author_profile_id !== values.author_profile_id
      )
        throw new Error("The note could not be verified.");
    },
  );
}

export type AppointmentSlot = { start_time: string; end_time: string; duration_minutes: number };

export function useAppointmentSlots(
  staffId: string,
  service: string,
  date: string,
  appointmentId: string | null,
  enabled: boolean,
) {
  const clinicId = useClinicId();
  return useQuery({
    queryKey: ["appointment_slots", clinicId, staffId, service, date, appointmentId],
    enabled: enabled && !!clinicId && !!staffId && !!service && !!date,
    staleTime: 0,
    refetchInterval: enabled ? 30_000 : false,
    queryFn: async () => {
      const { data, error } = await db.rpc("appointment_available_slots", {
        p_clinic_id: clinicId!,
        p_staff_id: staffId,
        p_service: service,
        p_date: date,
        p_exclude_id: appointmentId,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateAppointment() {
  return useClinicMutation<{
    clientId: string;
    staffId: string;
    service: string;
    slot: AppointmentSlot;
  }>(["appointments", "appointment_slots"], async (clinicId, input) => {
    const { data, error } = await db
      .from("appointments")
      .insert({
        clinic_id: clinicId,
        client_id: input.clientId,
        staff_id: input.staffId,
        service: input.service,
        start_time: input.slot.start_time,
        end_time: input.slot.end_time,
        status: "Booked",
        source: "Front desk",
      })
      .select("id")
      .single();
    if (error) throw appointmentWriteError(error);
    const { data: saved, error: readError } = await db
      .from("appointments")
      .select("*")
      .eq("id", data.id)
      .eq("clinic_id", clinicId)
      .single();
    if (
      readError ||
      !saved ||
      saved.client_id !== input.clientId ||
      saved.staff_id !== input.staffId ||
      saved.service !== input.service ||
      Date.parse(saved.start_time) !== Date.parse(input.slot.start_time) ||
      Date.parse(saved.end_time) !== Date.parse(input.slot.end_time) ||
      saved.status !== "Booked" ||
      saved.source !== "Front desk"
    )
      throw new Error("The appointment could not be verified.");
  });
}

export function useRescheduleAppointment() {
  return useClinicMutation<{ id: string; slot: AppointmentSlot }>(
    ["appointments", "appointment_slots"],
    async (clinicId, input) => {
      const { error } = await db
        .from("appointments")
        .update({ start_time: input.slot.start_time, end_time: input.slot.end_time })
        .eq("id", input.id)
        .eq("clinic_id", clinicId)
        .eq("status", "Booked")
        .select("id")
        .single();
      if (error) throw appointmentWriteError(error);
      const { data: saved, error: readError } = await db
        .from("appointments")
        .select("start_time,end_time,status")
        .eq("id", input.id)
        .eq("clinic_id", clinicId)
        .single();
      if (
        readError ||
        !saved ||
        Date.parse(saved.start_time) !== Date.parse(input.slot.start_time) ||
        Date.parse(saved.end_time) !== Date.parse(input.slot.end_time) ||
        saved.status !== "Booked"
      )
        throw new Error("The appointment changes could not be verified.");
    },
  );
}

export function useCancelAppointment() {
  return useClinicMutation<{ id: string; reason?: string }>(
    ["appointments", "appointment_slots"],
    async (clinicId, input) => {
      const { data: existing, error: readError } = await db
        .from("appointments")
        .select("notes,updated_at")
        .eq("id", input.id)
        .eq("clinic_id", clinicId)
        .eq("status", "Booked")
        .single();
      if (readError) throw readError;
      const reason = input.reason?.trim();
      const notes = reason
        ? [existing.notes, `Cancellation: ${reason}`].filter(Boolean).join("\n")
        : existing.notes;
      const { error } = await db
        .from("appointments")
        .update({ status: "Cancelled", notes })
        .eq("id", input.id)
        .eq("clinic_id", clinicId)
        .eq("status", "Booked")
        .eq("updated_at", existing.updated_at)
        .select("id")
        .single();
      if (error) throw error;
      const { data: saved, error: verifyError } = await db
        .from("appointments")
        .select("status,notes")
        .eq("id", input.id)
        .eq("clinic_id", clinicId)
        .single();
      if (verifyError || !saved || saved.status !== "Cancelled" || saved.notes !== notes)
        throw new Error("The cancellation could not be verified.");
    },
  );
}

// ---------------------------------------------------------------- helpers
export function formatDate(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
}
export function formatTime(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}
export function formatDuration(seconds: number) {
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
export function durationLabel(startIso: string, endIso: string) {
  return `${Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000))} min`;
}
export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
