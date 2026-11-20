import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { operationalLog } from "./operational-log.ts";
// Used only after the existing signed integration and call ownership checks.
export const UNKNOWN_MESSAGE =
  "I don’t have that information available, and I don’t want to give you the wrong answer. I can take your details so the clinic can follow up with you.";
export const UNKNOWN_SAVE_FAILED =
  "I couldn’t save your follow-up request. Please contact the clinic directly. I still don’t have that information available, and I don’t want to give you the wrong answer.";
export function unknownAnswerResult(
  saved = false,
  id: string | null = null,
  status = "not_requested",
) {
  return {
    success: saved,
    answer_known: false,
    answer: null,
    category: "unknown_answer",
    message: status === "not_saved" ? UNKNOWN_SAVE_FAILED : UNKNOWN_MESSAGE,
    follow_up_saved: saved,
    follow_up_request_id: id,
    follow_up_status: status,
    patient_instruction: saved
      ? "Your question was saved for clinic follow-up. Do not invent an answer or promise a response time."
      : status === "not_requested"
        ? "Collect no patient details unless the patient requests clinic follow-up."
        : "Do not claim the clinic received this request. Use only configured clinic contact information.",
  };
}
const clean = (value: string, max: number) =>
  value
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, max);
export async function unknownAnswerFollowUp(
  db: SupabaseClient,
  details: {
    clinicId: string;
    callId: string;
    requested: boolean;
    question: string;
    name: string;
    phone: string;
  },
  timeoutMs = 3000,
) {
  if (!details.requested) return unknownAnswerResult();
  let saved = false,
    id: string | null = null,
    status = "not_saved";
  const question = clean(details.question, 1000);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!question) throw new Error();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(question));
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const key = `unknown-answer:${details.clinicId}:${details.callId}:${hash}`;
    const result = await Promise.race([
      (async () => {
        const prior = await db
          .from("voice_requests")
          .select("id,status")
          .eq("clinic_id", details.clinicId)
          .eq("request_key", key)
          .maybeSingle()
          .abortSignal(controller.signal);
        if (prior.error || prior.data) return prior;
        const row = await db
          .from("voice_requests")
          .insert({
            clinic_id: details.clinicId,
            call_id: details.callId,
            request_key: key,
            kind: "message",
            patient_name: clean(details.name, 200) || null,
            phone: clean(details.phone, 32),
            reason:
              "AI couldn’t answer — follow-up\nCategory: unknown_answer\nQuestion: " + question,
            status: "Open",
          })
          .select("id,status")
          .single()
          .abortSignal(controller.signal);
        if (row.error?.code === "23505")
          return db
            .from("voice_requests")
            .select("id,status")
            .eq("clinic_id", details.clinicId)
            .eq("request_key", key)
            .single()
            .abortSignal(controller.signal);
        return row;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error());
        }, timeoutMs);
      }),
    ]);
    if (
      !result.error &&
      typeof result.data?.id === "string" &&
      ["Open", "In Progress", "Closed"].includes(result.data.status)
    ) {
      saved = true;
      id = result.data.id;
      status = result.data.status;
    }
  } catch {
    /* Never log raw dependency errors, questions or contact details. */
  } finally {
    clearTimeout(timer);
  }
  operationalLog(
    saved ? "unknown_answer_saved" : "unknown_answer_followup_failed",
    "clinic-operations",
    {
      clinic_id: details.clinicId,
      call_id: details.callId,
      state: saved ? "success" : "failure",
      dependency_category: saved ? undefined : "database_error",
      follow_up_saved: saved,
    },
  );
  return unknownAnswerResult(saved, id, status);
}
