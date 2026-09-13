// Hand-maintained types for the Apero Supabase schema (see db/01_phase2_schema.sql).
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type ProfileRole = "owner" | "manager" | "staff";

export type ClinicRow = {
  id: string; name: string; logo_url: string | null; phone: string | null;
  email: string | null; timezone: string; created_at: string;
};
export type ProfileRow = {
  id: string; auth_user_id: string; clinic_id: string; full_name: string;
  email: string; phone: string | null; role: ProfileRole; created_at: string;
};
export type ClientRow = {
  id: string; clinic_id: string; full_name: string; phone: string;
  email: string | null; notes: string | null; created_at: string; updated_at: string;
};
export type StaffRow = {
  id: string; clinic_id: string; full_name: string; specialty: string; phone: string | null;
  email: string | null; services: string[]; active: boolean; created_at: string; updated_at: string;
};
export type StaffAvailabilityRow = {
  id: string; clinic_id: string; staff_id: string; day_of_week: number;
  start_time: string; end_time: string; is_available: boolean;
};
export type AppointmentRow = {
  id: string; clinic_id: string; client_id: string | null; staff_id: string | null;
  service: string; start_time: string; end_time: string; status: string; source: string;
  notes: string | null; created_at: string; updated_at: string;
};
export type ConversationRow = {
  id: string; clinic_id: string; client_id: string | null; appointment_id: string | null;
  retell_call_id: string | null; retell_agent_id: string | null; title: string; status: string;
  outcome: string | null; caller_phone: string | null; started_at: string; duration_seconds: number;
  summary: string | null; transcript: Json | null; recording_url: string | null; created_at: string;
};
export type ClientNoteRow = {
  id: string; clinic_id: string; client_id: string; author_profile_id: string | null;
  note: string; created_at: string;
};
export type NotificationRow = {
  id: string; clinic_id: string; profile_id: string | null; type: string;
  title: string; message: string | null; read: boolean; created_at: string;
};

type TableDef<Row> = {
  Row: Row;
  Insert: Partial<Row> & Record<string, unknown>;
  Update: Partial<Row>;
  Relationships: [];
};

export type AperoDatabase = {
  public: {
    Tables: {
      clinics: TableDef<ClinicRow>;
      profiles: TableDef<ProfileRow>;
      clients: TableDef<ClientRow>;
      staff: TableDef<StaffRow>;
      staff_availability: TableDef<StaffAvailabilityRow>;
      appointments: TableDef<AppointmentRow>;
      conversations: TableDef<ConversationRow>;
      client_notes: TableDef<ClientNoteRow>;
      notifications: TableDef<NotificationRow>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: { profile_role: ProfileRole };
    CompositeTypes: Record<string, never>;
  };
};
