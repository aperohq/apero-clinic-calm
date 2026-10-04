import { createFileRoute } from "@tanstack/react-router";
import { AnalyticsPage } from "@/components/analytics-page";
import { RouteShell } from "@/components/route-shell";

export const Route = createFileRoute("/analytics")({
  head: () => ({ meta: [{ title: "Analytics — Apero" }] }),
  component: () => (
    <RouteShell>
      <AnalyticsPage />
    </RouteShell>
  ),
});
