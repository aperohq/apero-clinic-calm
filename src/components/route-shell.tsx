import { useState, type ReactNode } from "react";
import { Link, Navigate, useRouterState } from "@tanstack/react-router";
import { AppLayout } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { canAccess } from "@/lib/permissions";
import { toast } from "sonner";

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function LogOutButton() {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className="ml-2 mt-4"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          const { error } = await signOut();
          if (error) toast.error(error);
        } catch {
          toast.error("Could not log out. Please try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Logging out…" : "Log out"}
    </Button>
  );
}

export function RouteShell({ children }: { children: ReactNode }) {
  const { loading, session, clinicId, role, authError } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });

  if (loading) return <Centered>Loading your clinic workspace…</Centered>;
  if (!session) return <Navigate to="/login" replace />;
  if (authError)
    return (
      <Centered>
        <div>
          <p>We couldn’t load your account. Please refresh or try again later.</p>
          <Button className="mt-4" variant="outline" onClick={() => window.location.reload()}>
            Try again
          </Button>
          <LogOutButton />
        </div>
      </Centered>
    );
  if (!clinicId)
    return (
      <Centered>
        <div className="max-w-sm">
          <p className="font-semibold text-foreground">No clinic is linked to this account yet.</p>
          <p className="mt-2">
            Ask Apero to finish setting up your clinic profile, then sign in again.
          </p>
          <Button className="mt-4" variant="outline" asChild>
            <a href="mailto:apero.hq@gmail.com">Contact Apero</a>
          </Button>
          <LogOutButton />
        </div>
      </Centered>
    );
  if (!canAccess(role, path))
    return (
      <AppLayout>
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          <p className="font-semibold text-foreground">
            This section isn’t available for your role.
          </p>
          <Button className="mt-4" variant="outline" asChild>
            <Link to="/home">Back to Home</Link>
          </Button>
        </div>
      </AppLayout>
    );

  return <AppLayout>{children}</AppLayout>;
}
