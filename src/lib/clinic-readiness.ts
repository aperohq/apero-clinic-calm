import { z } from "zod";
import { db } from "@/lib/db";

const readinessSchema = z.object({
  clinic_id: z.string().uuid(),
  state: z.enum([
    "onboarding_incomplete",
    "configuration_complete",
    "technically_activation_ready",
    "awaiting_external_dependencies",
    "activated",
  ]),
  configuration_complete: z.boolean(),
  failures: z.array(z.string().min(1)),
  consent_revision: z.string().nullable(),
  activated_at: z.string().nullable(),
  external_dependencies: z.array(z.object({ name: z.string().min(1), status: z.string().min(1) })),
});

export type ClinicReadiness = z.infer<typeof readinessSchema>;

export async function loadClinicReadiness(clinicId: string): Promise<ClinicReadiness> {
  const { data, error } = await db.rpc("clinic_activation_readiness", { p_clinic_id: clinicId });
  if (error) throw new Error("Clinic readiness could not be verified.");
  const parsed = readinessSchema.safeParse(data);
  if (!parsed.success || parsed.data.clinic_id !== clinicId)
    throw new Error("Clinic readiness could not be verified.");
  const result = parsed.data;
  if (
    result.configuration_complete !== (result.failures.length === 0) ||
    (!["onboarding_incomplete", "activated"].includes(result.state) &&
      !result.configuration_complete) ||
    (result.state === "activated" && !result.activated_at)
  )
    throw new Error("Clinic readiness could not be verified.");
  return result;
}
