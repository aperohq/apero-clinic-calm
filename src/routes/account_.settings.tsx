import { createFileRoute } from "@tanstack/react-router";
import { ClinicSettingsPanel } from "@/components/clinic-settings-panel";
import { PageHeader } from "@/components/page-ui";
import { RouteShell } from "@/components/route-shell";

export const Route = createFileRoute("/account_/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Apero" },
      {
        name: "description",
        content: "Manage your clinic profile, contact information and public hours.",
      },
    ],
  }),
  component: () => (
    <RouteShell>
      <PageHeader
        title="Settings"
        description="Clinic profile, contact information and public hours."
      />
      <ClinicSettingsPanel />
    </RouteShell>
  ),
});
