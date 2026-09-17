import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { db } from "@/lib/db";
import type { ClinicRow, ProfileRole, ProfileRow } from "@/lib/db-types";

type AuthState = {
  loading: boolean;
  session: Session | null;
  profile: ProfileRow | null;
  clinic: ClinicRow | null;
  role: ProfileRole | null;
  refreshProfile: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (password: string) => Promise<{ error: string | null }>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [clinic, setClinic] = useState<ClinicRow | null>(null);

  const loadProfile = async (userId: string | undefined) => {
    if (!userId) { setProfile(null); setClinic(null); return; }
    const { data } = await db.from("profiles").select("*").eq("auth_user_id", userId).maybeSingle();
    setProfile((data as ProfileRow | null) ?? null);
    if (data?.clinic_id) {
      const { data: c } = await db.from("clinics").select("*").eq("id", data.clinic_id).maybeSingle();
      setClinic((c as ClinicRow | null) ?? null);
    } else setClinic(null);
  };

  useEffect(() => {
    let active = true;
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      void loadProfile(next?.user?.id).finally(() => setLoading(false));
    });
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      await loadProfile(data.session?.user?.id);
      setLoading(false);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const value: AuthState = {
    loading,
    session,
    profile,
    clinic,
    role: profile?.role ?? null,
    refreshProfile: () => loadProfile(session?.user?.id),
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      return { error: error ? error.message : null };
    },
    signOut: async () => { await supabase.auth.signOut(); setProfile(null); setClinic(null); },
    sendPasswordReset: async (email) => {
      const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined;
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), redirectTo ? { redirectTo } : undefined);
      return { error: error ? error.message : null };
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      return { error: error ? error.message : null };
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

// Navigation permissions per role.
const ROLE_ROUTES: Record<ProfileRole, string[]> = {
  owner: ["/home", "/calendar", "/clients", "/staff", "/conversations", "/support", "/account"],
  manager: ["/home", "/calendar", "/clients", "/staff", "/conversations", "/support", "/account"],
  staff: ["/home", "/calendar", "/clients", "/conversations", "/support", "/account"],
};

export function canAccess(role: ProfileRole | null, path: string) {
  if (!role) return false;
  return (ROLE_ROUTES[role] ?? []).some((allowed) => path === allowed || path.startsWith(allowed + "/"));
}
