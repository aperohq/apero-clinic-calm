import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/clinic-pages";
import { RouteShell } from "@/components/route-shell";
export const Route = createFileRoute("/home")({
  head: () => ({
    meta: [
      { title: "Home — Apero" },
      { name: "description", content: "clinic daily operations overview." },
      { property: "og:title", content: "Home — Apero" },
      { property: "og:description", content: "clinic daily operations overview." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <RouteShell>
      <HomePage />
    </RouteShell>
  ),
});
