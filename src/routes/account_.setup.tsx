import { createFileRoute } from "@tanstack/react-router";
import { InviteSetupPage } from "@/components/invite-setup-page";

// Non-nested route: the protected /account shell must not intercept invites.
export const Route = createFileRoute("/account_/setup")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Complete your account — Apero" },
      {
        name: "description",
        content: "Accept your Apero clinic invitation and create your password.",
      },
    ],
  }),
  component: InviteSetupPage,
});
