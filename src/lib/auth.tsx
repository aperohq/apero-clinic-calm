import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { db } from "@/lib/db";
import type { ClinicRow, ProfileRole, ProfileRow } from "@/lib/db-types";

export { canAccess } from "@/lib/permissions";

type AuthState = {
  loading: boolean;
  session: Session | null;
  profile: ProfileRow | null;
  clinic: ClinicRow | null;
  clinicId: string | null;
  role: ProfileRole | null;
  authError: boolean;
  recoveringPassword: boolean;
  refreshProfile: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<{ error: string | null }>;
  sendPasswordReset: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (password: string) => Promise<{ error: string | null }>;
};

const AuthContext = createContext<AuthState | null>(null);

function sameRow(left: object | null, right: object | null) {
  return left === right || (!!left && !!right && Object.keys(left).length === Object.keys(right).length &&
    Object.entries(right).every(([key, value]) => Reflect.get(left, key) === value));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [clinic, setClinic] = useState<ClinicRow | null>(null);
  const [authError, setAuthError] = useState(false);
  const [recoveringPassword, setRecoveringPassword] = useState(false);
  const requestId = useRef(0);
  const permissionScope = useRef<string | null>(null);

  const loadProfile = useCallback(async (userId: string | undefined, id = ++requestId.current) => {
    if (!userId) { permissionScope.current = null; queryClient.clear(); setProfile(null); setClinic(null); setAuthError(false); return; }
    const { data, error } = await db.from("profiles").select("*").eq("auth_user_id", userId).maybeSingle();
    if (id !== requestId.current) return;
    if (error) { permissionScope.current = null; queryClient.clear(); setAuthError(true); setProfile(null); setClinic(null); return; }
    const nextScope = data ? `${userId}:${data.clinic_id}:${data.role}` : null;
    if (permissionScope.current !== nextScope) queryClient.clear();
    permissionScope.current = nextScope;
    setProfile((previous) => sameRow(previous, data) ? previous : data);
    if (data?.clinic_id) {
      const { data: c, error: clinicError } = await db.from("clinics").select("*").eq("id", data.clinic_id).maybeSingle();
      if (id !== requestId.current) return;
      if (clinicError) { setAuthError(true); setClinic(null); return; }
      setClinic((previous) => sameRow(previous, c) ? previous : c);
    } else setClinic(null);
    setAuthError(false);
  }, [queryClient]);

  useEffect(() => {
    let active = true;
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY") {
        sessionStorage.setItem("apero-password-recovery", "1");
        setRecoveringPassword(true);
      } else if (event === "SIGNED_OUT") {
        sessionStorage.removeItem("apero-password-recovery");
        setRecoveringPassword(false);
      }
      setSession(next);
      setLoading(true);
      const id = ++requestId.current;
      void loadProfile(next?.user?.id, id).finally(() => { if (active && id === requestId.current) setLoading(false); });
    });
    void supabase.auth.getSession().then(async ({ data, error }) => {
      if (!active) return;
      if (error) { setAuthError(true); setLoading(false); return; }
      setRecoveringPassword(sessionStorage.getItem("apero-password-recovery") === "1");
      setSession(data.session);
      const id = ++requestId.current;
      await loadProfile(data.session?.user?.id, id);
      if (active && id === requestId.current) setLoading(false);
    }).catch(() => { if (active) { setAuthError(true); setLoading(false); } });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [loadProfile]);

  // Recheck trusted database role on focus; preserve unchanged form state.
  useEffect(() => {
    const userId = session?.user.id;
    if (!userId) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const id = ++requestId.current;
      void loadProfile(userId, id).catch(() => {
        if (id === requestId.current) { setAuthError(true); setProfile(null); setClinic(null); }
      });
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [session?.user.id, loadProfile]);

  const readyProfile = !loading && !authError && profile?.auth_user_id === session?.user.id &&
    clinic?.id === profile?.clinic_id ? profile : null;
  const readyClinic = readyProfile ? clinic : null;

  const value: AuthState = {
    loading,
    session,
    profile: readyProfile,
    clinic: readyClinic,
    clinicId: readyClinic?.id ?? null,
    role: readyProfile?.role ?? null,
    authError,
    recoveringPassword,
    refreshProfile: () => loadProfile(session?.user?.id),
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      return { error: error ? error.message : null };
    },
    signOut: async () => {
      const { error } = await supabase.auth.signOut();
      if (!error) { requestId.current++; setSession(null); setProfile(null); setClinic(null); sessionStorage.removeItem("apero-password-recovery"); setRecoveringPassword(false); }
      return { error: error ? "Could not log out. Please try again." : null };
    },
    sendPasswordReset: async (email) => {
      const redirectTo = typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined;
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), redirectTo ? { redirectTo } : undefined);
      return { error: error ? error.message : null };
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (!error) { sessionStorage.removeItem("apero-password-recovery"); setRecoveringPassword(false); }
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
