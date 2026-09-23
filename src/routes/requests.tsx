import { createFileRoute } from "@tanstack/react-router";
import { RequestsPage } from "@/components/requests";
import { RouteShell } from "@/components/route-shell";

export const Route = createFileRoute("/requests")({
  head: () => ({ meta: [{ title: "Requests — Apero" }] }),
  component: () => (
    <RouteShell>
      <RequestsPage />
    </RouteShell>
  ),
});
