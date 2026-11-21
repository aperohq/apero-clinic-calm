import { operationalLog } from "./operational-log.ts";
// Call only for appointment INSERT/reschedule UPDATE errors, never queries,
// cancellation, client writes, or unrelated database operations.
export const appointmentSlotConflictMessage = "That time is unavailable. Refresh available slots.";

export function appointmentWriteError(error: unknown): unknown {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code !== "23P01" && code !== "40P01") return error;
  operationalLog("booking_failed", "portal", { database_code: code, reason: "slot_conflict" });
  return new Error(appointmentSlotConflictMessage, { cause: error });
}
