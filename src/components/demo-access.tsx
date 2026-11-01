import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { DEMO_CLINIC_REFERENCE } from "@/lib/demo-call";
import { demoRequest } from "@/hooks/use-retell-demo";

export function DemoAccess({ children }: { children: ReactNode }) {
  const { session, profile, loading, authError, recoveringPassword } = useAuth();
  const [verification, setVerification] = useState<{ token: string; allowed: boolean } | null>(
    null,
  );
  const token = session?.access_token;
  const eligible =
    !loading &&
    !authError &&
    !recoveringPassword &&
    !!session &&
    profile?.auth_user_id === session.user.id &&
    profile?.clinic_id === DEMO_CLINIC_REFERENCE &&
    profile?.role === "owner" &&
    profile.revoked_at === null;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!eligible || !token) return;
    let active = true;
    void demoRequest("access")
      .then(async (result) => {
        const body: unknown = result.ok ? await result.json() : null;
        const allowed =
          !!body && typeof body === "object" && "allowed" in body && body.allowed === true;
        if (active) setVerification({ token, allowed });
      })
      .catch(() => {
        if (active) setVerification({ token, allowed: false });
      });
    return () => {
      active = false;
    };
  }, [eligible, token, attempt]);
  if (eligible && token && verification?.token === token && verification.allowed) return children;
  const pending = loading || (eligible && verification?.token !== token);
  return (
    <div className="voice-demo grid min-h-screen place-items-center p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold">
          {pending ? "Verifying demo access…" : "Private Apero voice demo"}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {pending
            ? "Checking your clinic membership."
            : !session
              ? "Sign in with your Dental Zone Owner account to continue."
              : "Access could not be verified. This demo requires an active Dental Zone Owner account and available demo services."}
        </p>
        <div className="mt-6 flex justify-center gap-5">
          <Link to="/login" className="underline">
            Sign in
          </Link>
          {session && !pending && (
            <button
              className="underline"
              onClick={() => {
                setVerification(null);
                setAttempt((a) => a + 1);
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
