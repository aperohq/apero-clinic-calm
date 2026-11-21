import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RouteShell } from "@/components/route-shell";
export const Route = createFileRoute("/conversations")({
  component: () => (
    <RouteShell>
      <Outlet />
    </RouteShell>
  ),
});
