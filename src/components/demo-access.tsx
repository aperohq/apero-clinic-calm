import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { demoRequest } from "@/hooks/use-retell-demo";

export function DemoAccess({ children }: { children: ReactNode }) {
  const { session, profile, loading, authError, recoveringPassword } = useAuth();
  const identity = session && profile ? `${session.user.id}:${profile.clinic_id}` : null;
  const eligible =
    !loading &&
    !authError &&
    !recoveringPassword &&
    !!session &&
    profile?.auth_user_id === session.user.id &&
    profile?.role === "owner" &&
    profile.revoked_at === null;
  const [verification, setVerification] = useState<{ identity: string; allowed: boolean } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!eligible || !identity) {
      setVerification(null);
      return;
    }
    let active = true;
    void demoRequest("access")
      .then(async (response) => {
        const data: unknown = response.ok ? await response.json() : null;
        if (active)
          setVerification({
            identity,
            allowed:
              !!data && typeof data === "object" && "allowed" in data && data.allowed === true,
          });
      })
      .catch(() => {
        if (active) setVerification({ identity, allowed: false });
      });
    return () => {
      active = false;
    };
  }, [eligible, identity, attempt]);
  if (eligible && identity && verification?.identity === identity && verification.allowed)
    return children;
  const pending = loading || (eligible && verification?.identity !== identity);
  return (
    <div className="demo-access">
      <img src="/apero-logo-black.png" alt="Apero" width="54" height="54" />
      <h1>{pending ? "Preparing your demo…" : "Your Apero voice experience"}</h1>
      <p>
        {pending
          ? "Just a moment while we check your access."
          : !session
            ? "Sign in with your clinic owner account to continue."
            : "Demo access is unavailable. Check with your Apero host, then retry."}
      </p>
      <div>
        <Link to="/login">Sign in</Link>
        {session && !pending && (
          <button
            onClick={() => {
              setVerification(null);
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
