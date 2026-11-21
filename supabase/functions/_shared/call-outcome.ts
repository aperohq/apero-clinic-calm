type Operation = { action: string; result: { appointment_id?: string; success?: boolean } };
// Operations arrive newest first. Keep the latest action per appointment;
// cancellation of one booking must not hide another booking in the same call.
export function hasLiveBooking(operations: Operation[]): boolean {
  const seen = new Set<string>();
  for (const operation of operations) {
    const id = operation.result?.appointment_id;
    if (operation.result?.success !== true || !id || seen.has(id)) continue;
    seen.add(id);
    if (operation.action === "book" || operation.action === "reschedule") return true;
  }
  return false;
}
