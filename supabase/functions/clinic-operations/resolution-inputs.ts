import type { Staff } from "./logic.ts";
import type { createPerformanceTiming } from "./performance-timing.ts";

// Both reads are scoped to the verified clinic and neither depends on the other.
// Keep their error checks before resolving a service or practitioner.
export async function loadResolutionInputs(
  // The Edge runtime supplies an untyped service-role client to this function.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  clinicId: string,
  timing: ReturnType<typeof createPerformanceTiming>,
): Promise<{
  staff: Staff[];
  aliases: Record<string, string[]>;
}> {
  const [staffRead, aliasRead] = await Promise.allSettled([
    timing.run<{ data: Staff[] | null; error: unknown }>(
      "staff_read",
      () =>
        db
          .from("staff")
          .select("id,full_name,specialty,services,aliases")
          .eq("clinic_id", clinicId)
          .eq("active", true),
      (result) => !result.error,
    ),
    timing.run<{ data: Array<{ service: string; alias: string }> | null; error: unknown }>(
      "alias_read",
      () => db.from("clinic_service_aliases").select("service,alias").eq("clinic_id", clinicId),
      (result) => !result.error,
    ),
  ]);
  // Retain the original staff-first error priority, including rejected requests.
  if (staffRead.status === "rejected") throw staffRead.reason;
  const staffResult = staffRead.value;
  if (staffResult.error) throw staffResult.error;
  if (aliasRead.status === "rejected") throw aliasRead.reason;
  const aliasResult = aliasRead.value;
  if (aliasResult.error) throw aliasResult.error;
  const aliases: Record<string, string[]> = {};
  for (const row of aliasResult.data ?? []) (aliases[row.service] ??= []).push(row.alias);
  return { staff: staffResult.data ?? [], aliases };
}
