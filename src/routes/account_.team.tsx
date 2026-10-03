import { createFileRoute } from "@tanstack/react-router";
import { AccountAccessPanel } from "@/components/account-access-panel";
import { PageHeader } from "@/components/page-ui";
import { RouteShell } from "@/components/route-shell";

export const Route = createFileRoute("/account_/team")({
  head: () => ({
    meta: [
      { title: "Team — Apero" },
      { name: "description", content: "Manage your clinic's portal accounts and invitations." },
    ],
  }),
  component: () => (
    <RouteShell>
      <PageHeader title="Team" description="Portal accounts with access to your clinic." />
      <AccountAccessPanel />
    </RouteShell>
  ),
});
