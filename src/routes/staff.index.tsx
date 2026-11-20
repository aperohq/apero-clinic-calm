import { createFileRoute } from "@tanstack/react-router";
import { StaffPage } from "@/components/clinic-pages";
export const Route = createFileRoute("/staff/")({
  head: () => ({
    meta: [
      { title: "Staff — Apero" },
      { name: "description", content: "clinic team directory." },
      { property: "og:title", content: "Staff — Apero" },
      { property: "og:description", content: "clinic team directory." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: StaffPage,
});
