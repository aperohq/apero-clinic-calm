import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RouteShell } from "@/components/route-shell";
export const Route = createFileRoute("/staff")({
  component: () => (
    <RouteShell>
      <Outlet />
    </RouteShell>
  ),
});
