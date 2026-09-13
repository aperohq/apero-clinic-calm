import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordPage } from "@/components/clinic-pages";
export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({ meta: [{ title: "Reset password — Apero" }, { name: "description", content: "Choose a new password for your Apero clinic account." }, { property: "og:title", content: "Reset password — Apero" }, { property: "og:description", content: "Choose a new password for your Apero clinic account." }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary_large_image" }] }),
  component: ResetPasswordPage,
});
