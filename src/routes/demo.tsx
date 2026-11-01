import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DemoAccess } from "@/components/demo-access";
export const Route = createFileRoute("/demo")({
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  component: () => (
    <DemoAccess>
      <Navigate to="/voice-demo" replace />
    </DemoAccess>
  ),
});
