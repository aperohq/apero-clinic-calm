import { createContext } from "react";
import type { Session } from "@supabase/supabase-js";
import type { ClinicRow, ProfileRole, ProfileRow } from "@/lib/db-types";
export type AuthState = {
  loading: boolean;
  session: Session | null;
  profile: ProfileRow | null;
  clinic: ClinicRow | null;
  clinicId: string | null;
  role: ProfileRole | null;
  authError: boolean;
  recoveringPassword: boolean;
  refreshProfile: (background?: boolean) => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<{ error: string | null }>;
  sendPasswordReset: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (password: string) => Promise<{ error: string | null }>;
};

export const AuthContext = createContext<AuthState | null>(null);
