import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "@/components/legal-pages";
export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — Apero" },
      { name: "description", content: "Launch draft terms for Apero clinic operations." },
    ],
  }),
  component: TermsPage,
});
