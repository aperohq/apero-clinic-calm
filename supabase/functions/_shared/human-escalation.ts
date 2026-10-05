import { operationalLog } from "./operational-log.ts";
export const HUMAN_CATEGORIES = ["explicit_human_request", "unsafe_to_complete", "clinic_judgment", "repeated_failure", "appointment_dispute", "unsupported_operation"] as const;
export function isHumanCategory(category: string) { return (HUMAN_CATEGORIES as readonly string[]).includes(category); }
// Used only after the existing signed integration and call ownership checks.
export const HUMAN_MESSAGE = "This request needs clinic staff assistance. I’ll pass this to the clinic team so they can help you directly.";
export const HUMAN_SAVE_FAILED = "I couldn’t pass your request to the clinic team. Please contact the clinic directly.";
export function humanEscalationResult(saved = false, id: string | null = null, status = "not_requested") {
  return { success: saved, resolved: false, category: "human_assistance",
    message: saved ? "Your request was passed to the clinic team so they can help you directly." : status === "not_saved" ? HUMAN_SAVE_FAILED : "No human assistance request was saved.",
    follow_up_saved: saved, follow_up_request_id: id, follow_up_status: status,
    patient_instruction: saved ? "Staff assistance is still required; the issue is not resolved. Do not promise a callback time. If no phone was supplied, advise contacting the clinic directly using only configured contact details."
      : status === "not_requested" ? "No escalation was saved. Continue supported requests normally; use the specific booking, calendar or unknown-answer fallback when applicable."
      : "Do not claim the clinic received this request. Use only configured clinic contact information." };
}
const clean = (value: string, max: number) => value.replace(/\p{Cc}/gu, " ").trim().slice(0, max);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function humanEscalationFollowUp(db: any, details: {
  clinicId: string; callId: string; requested: boolean; category: string; reason: string; name: string; phone: string;
}, timeoutMs = 3000) {
  if (!details.requested || !isHumanCategory(details.category)) return humanEscalationResult();
  let saved = false, id: string | null = null, status = "not_saved";
  const reason = clean(details.reason, 1000);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!reason) throw new Error();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(details.category + ":" + reason));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    const key = `human-assistance:${details.clinicId}:${details.callId}:${hash}`;
    const result = await Promise.race([
      (async () => {
        const prior = await db.from("voice_requests").select("id,status").eq("clinic_id", details.clinicId)
          .eq("request_key", key).maybeSingle().abortSignal(controller.signal);
        if (prior.error || prior.data) return prior;
        const row = await db.from("voice_requests").insert({ clinic_id: details.clinicId, call_id: details.callId,
          request_key: key, kind: "message", patient_name: clean(details.name, 200) || null,
          phone: clean(details.phone, 32), reason: "Human assistance required\nCategory: " + details.category + "\nRequest: " + reason,
          status: "Open" }).select("id,status").single().abortSignal(controller.signal);
        if (row.error?.code === "23505") return db.from("voice_requests").select("id,status").eq("clinic_id", details.clinicId)
          .eq("request_key", key).single().abortSignal(controller.signal);
        return row;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs); }),
    ]);
    if (!result.error && typeof result.data?.id === "string" && ["Open", "In Progress", "Closed"].includes(result.data.status)) {
      saved = true; id = result.data.id; status = result.data.status;
    }
  } catch { /* Never log raw dependency errors, reasons or contact details. */ }
  finally { clearTimeout(timer); }
  operationalLog(saved ? "human_escalation_saved" : "human_escalation_failed", "clinic-operations", {clinic_id: details.clinicId, call_id: details.callId, state: saved ? "success" : "failure", dependency_category: saved ? undefined : "database_error", follow_up_saved: saved});
  return humanEscalationResult(saved, id, status);
}
