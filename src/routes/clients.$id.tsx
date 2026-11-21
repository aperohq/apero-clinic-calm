import { createFileRoute } from "@tanstack/react-router";
import { ClientDetailPage } from "@/components/clinic-pages";
export const Route = createFileRoute("/clients/$id")({
  head: () => ({
    meta: [
      { title: "Client details — Apero" },
      { name: "description", content: "Review client appointments, calls, and notes." },
      { property: "og:title", content: "Client details — Apero" },
      { property: "og:description", content: "Review client appointments, calls, and notes." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Page,
});
function Page() {
  const { id } = Route.useParams();
  return <ClientDetailPage id={id} />;
}
