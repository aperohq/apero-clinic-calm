import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { db } from "@/lib/db";
import type { ClinicRow, ProfileRole, ProfileRow } from "@/lib/db-types";
import { AuthContext, type AuthState } from "@/lib/auth-context";

type ClinicAccount = { profile: ProfileRow; clinic: ClinicRow };
function sameRow(left: object, right: object) {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(right).every(([key, value]) => {
      const previous = Reflect.get(left, key);
      return (
        previous === value ||
        (previous !== null &&
          value !== null &&
          typeof previous === "object" &&
          typeof value === "object" &&
          JSON.stringify(previous) === JSON.stringify(value))
      );
    })
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [account, setAccount] = useState<ClinicAccount | null>(null);
  const resolvedClinicId = useRef<string | null>(null);
  const resolvedRole = useRef<ProfileRole | null>(null);
  const [authError, setAuthError] = useState(false);
  const [recoveringPassword, setRecoveringPassword] = useState(false);
  const requestId = useRef(0);
  const invalidateProfileRequests = useCallback(() => {
    requestId.current++;
  }, []);
  const publishAccount = useCallback(
    (next: ClinicAccount | null) => {
      const nextClinicId = next?.clinic.id ?? null;
      const nextRole = next?.profile.role ?? null;
      if (resolvedClinicId.current !== nextClinicId || resolvedRole.current !== nextRole)
        queryClient.clear();
      resolvedClinicId.current = nextClinicId;
      resolvedRole.current = nextRole;
      setAccount((previous) =>
        previous &&
        next &&
        sameRow(previous.profile, next.profile) &&
        sameRow(previous.clinic, next.clinic)
          ? previous
          : next,
      );
    },
    [queryClient],
  );

  const loadProfile = useCallback(
    async (userId: string | undefined, id = ++requestId.current, background = false) => {
      if (!background) setLoading(true);
      try {
        if (!userId) {
          publishAccount(null);
          setAuthError(false);
          return;
        }
        const { data, error } = await db
          .from("profiles")
          .select("*")
          .eq("auth_user_id", userId)
          .maybeSingle();
        if (id !== requestId.current) return;
        if (error) throw error;
        if (!data?.clinic_id || data.revoked_at || data.auth_user_id !== userId) {
          publishAccount(null);
          setAuthError(false);
          return;
        }
        const { data: clinic, error: clinicError } = await db
          .from("clinics")
          .select("*")
          .eq("id", data.clinic_id)
          .maybeSingle();
        if (id !== requestId.current) return;
        if (clinicError) throw clinicError;
        // Resolve from authenticated database relationships, never URL/storage input.
        publishAccount(clinic?.id === data.clinic_id ? { profile: data, clinic } : null);
        setAuthError(false);
      } catch (error) {
        if (id !== requestId.current) return;
        // Keep the mounted workspace on recoverable background failures. A
        // successful empty/revoked profile read above still removes access.
        const status =
          error && typeof error === "object" && "status" in error ? error.status : null;
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (
          background &&
          status !== 401 &&
          status !== 403 &&
          code !== "42501" &&
          code !== "PGRST301" &&
          code !== "PGRST303"
        )
          return;
        publishAccount(null);
        setAuthError(true);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [publishAccount],
  );

  useEffect(() => {
    let active = true;
    let authEvents = 0;
    let currentUserId: string | undefined;
    const applySession = (next: Session | null) => {
      if (!active) return;
      if (currentUserId !== next?.user.id) {
        currentUserId = next?.user.id;
        // Discard in-flight profile reads and cached portal data across accounts.
        requestId.current++;
        queryClient.clear();
        publishAccount(null);
        setAuthError(false);
        setLoading(!!next);
      }
      setSession(next);
      if (!next) setLoading(false);
    };
    setRecoveringPassword(sessionStorage.getItem("apero-password-recovery") === "1");
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (!active) return;
      authEvents++;
      if (event === "PASSWORD_RECOVERY") {
        sessionStorage.setItem("apero-password-recovery", "1");
        setRecoveringPassword(true);
      } else if (event === "SIGNED_OUT") {
        sessionStorage.removeItem("apero-password-recovery");
        setRecoveringPassword(false);
      }
      // Keep this callback synchronous. Profile reads run in their own effect.
      applySession(next);
    });
    const initialEvents = authEvents;
    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        // A slow initial read must never overwrite a newer sign-in or sign-out.
        if (!active || authEvents !== initialEvents) return;
        if (error) {
          setAuthError(true);
          setLoading(false);
          return;
        }
        applySession(data.session);
      })
      .catch(() => {
        if (active && authEvents === initialEvents) {
          setAuthError(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
      invalidateProfileRequests();
      sub.subscription.unsubscribe();
    };
  }, [queryClient, publishAccount, invalidateProfileRequests]);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) return;
    const id = ++requestId.current;
    void loadProfile(userId, id);
    return invalidateProfileRequests;
  }, [userId, loadProfile, invalidateProfileRequests]);

  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden")
        void loadProfile(userId, ++requestId.current, true);
    };
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
    };
  }, [userId, loadProfile]);

  // Expose the association only when this session's complete account is ready.
  const readyAccount =
    !loading && !authError && account?.profile.auth_user_id === session?.user.id ? account : null;
  const profile = readyAccount?.profile ?? null;
  const clinic = readyAccount?.clinic ?? null;
  const value: AuthState = {
    loading,
    session,
    profile,
    clinic,
    clinicId: clinic?.id ?? null,
    role: profile?.role ?? null,
    authError,
    recoveringPassword,
    refreshProfile: (background = false) =>
      loadProfile(session?.user?.id, ++requestId.current, background),
    signIn: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      return { error: error ? error.message : null };
    },
    signOut: async () => {
      const { error } = await supabase.auth.signOut({ scope: "local" });
      // SIGNED_OUT clears state and caches through the auth subscription.
      if (error) {
        // The SDK can clear this device's session even if remote revocation fails.
        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || data.session) return { error: "Could not log out. Please try again." };
      }
      return { error: null };
    },
    sendPasswordReset: async (email) => {
      const redirectTo =
        typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined;
      const { error } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        redirectTo ? { redirectTo } : undefined,
      );
      return { error: error ? error.message : null };
    },
    updatePassword: async (password) => {
      const { error } = await supabase.auth.updateUser({ password });
      if (!error) {
        sessionStorage.removeItem("apero-password-recovery");
        setRecoveringPassword(false);
      }
      return { error: error ? error.message : null };
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
