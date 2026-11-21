import { createFileRoute } from "@tanstack/react-router";
import { CalendarPage } from "@/components/clinic-pages";
import { RouteShell } from "@/components/route-shell";
export const Route = createFileRoute("/calendar")({
  head: () => ({
    meta: [
      { title: "Calendar — Apero" },
      { name: "description", content: "Manage clinic appointments and staff availability." },
      { property: "og:title", content: "Calendar — Apero" },
      { property: "og:description", content: "Manage clinic appointments and staff availability." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <RouteShell>
      <CalendarPage />
    </RouteShell>
  ),
});
