import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "@/components/legal-pages";
export const Route = createFileRoute("/privacy")({ head: () => ({ meta: [{ title: "Privacy Policy — Apero" }, { name: "description", content: "How Apero handles clinic and account information." }] }), component: PrivacyPage });
