import type { createPerformanceTiming } from "./performance-timing.ts";

// The clinic comes only from the verified integration, never from the payload.
export async function checkCallOwnership(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  callId: string,
  verifiedClinicId: string,
  timing: ReturnType<typeof createPerformanceTiming>,
): Promise<boolean> {
  const { data: owner, error } = await timing.run<{
    data: { clinic_id: string } | null;
    error: unknown;
  }>(
    "ownership_check",
    () => db.from("voice_call_state").select("clinic_id").eq("call_id", callId).maybeSingle(),
    (result) => !result.error,
  );
  if (error) throw error;
  return !owner || owner.clinic_id === verifiedClinicId;
}
