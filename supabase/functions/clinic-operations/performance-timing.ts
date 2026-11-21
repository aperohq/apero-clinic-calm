const actions = new Set([
  "invalidate",
  "resolve",
  "availability",
  "book",
  "reschedule",
  "lookup",
  "cancel",
  "message",
  "callback",
  "urgent",
]);

export type TimingPhase =
  | "request_parse"
  | "integration_lookup"
  | "signature_verification"
  | "duplicate_secret_check"
  | "ownership_check"
  | "action_setup"
  | "staff_read"
  | "alias_read"
  | "service_resolution"
  | "practitioner_resolution"
  | "schedule_reads"
  | "slot_generation"
  | "checked_slot_write"
  | "booking_rpc"
  | "response_serialization"
  | "total";
type Category = "success" | "failure";

// Retain only fixed labels and durations. Never retain request or database values.
export function createPerformanceTiming(now = () => performance.now(), emit = console.info) {
  const start = now();
  const spans: Array<{ phase: TimingPhase; elapsed_ms: number; category: Category }> = [];
  let action = "unknown";
  let finished = false;
  return {
    setAction(value: unknown) {
      action = typeof value === "string" && actions.has(value) ? value : "unknown";
    },
    mark(phase: TimingPhase, elapsed: number, category: Category) {
      spans.push({ phase, elapsed_ms: Math.round(Math.max(0, elapsed) * 100) / 100, category });
    },
    async run<T>(
      phase: TimingPhase,
      work: () => PromiseLike<T>,
      isSuccessful: (result: T) => boolean = () => true,
    ): Promise<T> {
      const began = now();
      try {
        const result = await work();
        this.mark(phase, now() - began, isSuccessful(result) ? "success" : "failure");
        return result;
      } catch (error) {
        this.mark(phase, now() - began, "failure");
        throw error;
      }
    },
    runSync<T>(
      phase: TimingPhase,
      work: () => T,
      isSuccessful: (result: T) => boolean = () => true,
    ): T {
      const began = now();
      try {
        const result = work();
        this.mark(phase, now() - began, isSuccessful(result) ? "success" : "failure");
        return result;
      } catch (error) {
        this.mark(phase, now() - began, "failure");
        throw error;
      }
    },
    finish(category: Category) {
      if (finished) return;
      finished = true;
      this.mark("total", now() - start, category);
      for (const span of spans) {
        try {
          emit(JSON.stringify({ action, ...span }));
        } catch {
          /* Logging must never change the response. */
        }
      }
    },
  };
}
