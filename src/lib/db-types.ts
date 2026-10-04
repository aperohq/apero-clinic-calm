// Hand-maintained types for the Apero Supabase schema (see db/01_phase2_schema.sql).
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type ProfileRole = "owner" | "manager" | "staff";

import type { ClinicHours } from "./clinic-settings";

export type ClinicRow = {
  id: string; name: string; logo_url: string | null; phone: string | null;
  email: string | null; timezone: string; created_at: string;
  localized_name: string | null; clinic_type: string | null;
  website: string | null; fallback_phone: string | null;
  address: string | null; city: string | null; country: string | null;
  directions: string | null; parking_information: string | null;
  receptionist_name: string | null; receptionist_localized_name: string | null;
  opening_hours: ClinicHours | null;
};
export type ProfileRow = {
  id: string; auth_user_id: string; clinic_id: string; full_name: string;
  email: string; phone: string | null; role: ProfileRole; created_at: string;
  revoked_at: string | null;
};
export type TeamMemberRow = {
  id: string; full_name: string; email: string; role: ProfileRole;
  revoked_at: string | null; invite_status: "active" | "pending" | "accepted" | "revoked";
  invited_at: string | null; invite_accepted_at: string | null;
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
export type StaffTimeOffRow = {
  id: string; clinic_id: string; staff_id: string; start_time: string; end_time: string;
  reason: string | null; created_at: string;
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
  summary: string | null; transcript: Json | null; created_at: string;
};
export type ClientNoteRow = {
  id: string; clinic_id: string; client_id: string; author_profile_id: string | null;
  note: string; created_at: string;
};
export type NotificationRow = {
  id: string; clinic_id: string; profile_id: string | null; type: string;
  title: string; message: string | null; read: boolean; created_at: string;
};
export type VoiceRequestRow = {
  id: string; clinic_id: string; request_key: string; call_id: string | null;
  kind: "message" | "callback" | "urgent"; caller_name: string | null;
  patient_name: string | null; phone: string; reason: string;
  status: "Open" | "In Progress" | "Closed"; created_at: string;
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
      staff_time_off: TableDef<StaffTimeOffRow>;
      appointments: TableDef<AppointmentRow>;
      conversations: TableDef<ConversationRow>;
      client_notes: TableDef<ClientNoteRow>;
      notifications: TableDef<NotificationRow>;
      voice_requests: TableDef<VoiceRequestRow>;
    };
    Views: Record<string, never>;
    Functions: {
      clinic_analytics: { Args: { p_clinic_id: string; p_start_date: string; p_end_date: string }; Returns: Json };
      update_clinic_settings: { Args: { p_patch: Json; p_expected: Json }; Returns: ClinicRow[] };
      clinic_team_members: { Args: Record<string, never>; Returns: TeamMemberRow[] };
      revoke_clinic_member: { Args: { p_profile_id: string }; Returns: string };
      appointment_available_slots: {
        Args: { p_clinic_id: string; p_staff_id: string; p_service: string; p_date: string; p_exclude_id: string | null };
        Returns: { start_time: string; end_time: string; duration_minutes: number }[];
      };
      set_clinic_member_role: {
        Args: { p_profile_id: string; p_role: ProfileRole };
        Returns: string;
      };
      create_staff_with_schedule: {
        Args: { p_full_name: string; p_specialty: string; p_phone: string; p_email: string; p_services: string[]; p_schedule: Json };
        Returns: string;
      };
    };
    Enums: { profile_role: ProfileRole };
    CompositeTypes: Record<string, never>;
  };
};
