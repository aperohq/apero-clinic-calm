// Supabase-backed data layer for the Apero clinic workspace.
// All reads and writes are scoped to the signed-in user's clinic by RLS.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth";
import type {
  AppointmentRow, ClientNoteRow, ClientRow, ConversationRow,
  StaffAvailabilityRow, StaffRow,
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
      const { data, error } = await db.from("staff_availability").select("*").eq("staff_id", staffId).order("day_of_week");
      if (error) throw error;
      return (data ?? []) as StaffAvailabilityRow[];
    },
  });
  return query.data ?? [];
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
  return query.data ?? [];
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
  return useClinicMutation<{ name: string; specialty: string; phone?: string; email?: string; services?: string; days?: string }>(["staff", "availability"], async (clinicId, input) => {
    const services = (input.services ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const { data, error } = await db.from("staff").insert({
      clinic_id: clinicId, full_name: input.name.trim(), specialty: input.specialty.trim(),
      phone: input.phone?.trim() || null, email: input.email?.trim() || null, services,
    }).select("id").single();
    if (error) throw error;
    const staffId = (data as { id: string } | null)?.id;
    if (staffId) {
      const rows = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
        clinic_id: clinicId, staff_id: staffId, day_of_week: day,
        start_time: "09:00", end_time: "17:00", is_available: day >= 1 && day <= 4,
      }));
      await db.from("staff_availability").insert(rows);
    }
  });
}

export function useUpdateStaff() {
  return useClinicMutation<{ id: string; full_name?: string; specialty?: string; phone?: string | null; email?: string | null; services?: string[] }>(["staff"], async (_c, input) => {
    const { id, ...patch } = input;
    const { error } = await db.from("staff").update(patch).eq("id", id);
    if (error) throw error;
  });
}

export function useSaveAvailability() {
  return useClinicMutation<{ staffId: string; rows: { day_of_week: number; start_time: string; end_time: string; is_available: boolean }[] }>(["availability"], async (clinicId, input) => {
    const { error } = await db.from("staff_availability").upsert(
      input.rows.map((r) => ({ ...r, clinic_id: clinicId, staff_id: input.staffId })),
      { onConflict: "staff_id,day_of_week" },
    );
    if (error) throw error;
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
