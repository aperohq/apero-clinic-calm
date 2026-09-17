import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { AppLayout } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { canAccess, useAuth } from "@/lib/auth";

function Centered({ children }: { children: ReactNode }) {
  return <div className="grid min-h-screen place-items-center bg-background p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

export function RouteShell({ children }: { children: ReactNode }) {
  const { loading, session, profile, role, authError } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });

  if (loading) return <Centered>Loading your clinic workspace…</Centered>;
  if (authError) return <Centered><div><p>We couldn’t load your account. Please refresh or try again later.</p><Button className="mt-4" variant="outline" onClick={() => window.location.reload()}>Try again</Button></div></Centered>;
  if (!session)
    return <Centered><div><p>You need to sign in to view this page.</p><Button className="mt-4" asChild><Link to="/login">Go to sign in</Link></Button></div></Centered>;
  if (!profile)
    return <Centered><div className="max-w-sm"><p className="font-semibold text-foreground">No clinic is linked to this account yet.</p><p className="mt-2">Ask Apero to finish setting up your clinic profile, then sign in again.</p><Button className="mt-4" variant="outline" asChild><a href="mailto:apero.hq@gmail.com">Contact Apero</a></Button></div></Centered>;
  if (!canAccess(role, path))
    return <AppLayout><div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground"><p className="font-semibold text-foreground">This section isn’t available for your role.</p><Button className="mt-4" variant="outline" asChild><Link to="/home">Back to Home</Link></Button></div></AppLayout>;

  return <AppLayout>{children}</AppLayout>;
}
