import { safeOperationalEvent } from "./operational-log";

let lastCapturedError: { error: unknown; at: number } | undefined;
function record(error: unknown) { lastCapturedError = {error, at: Date.now()}; }

// Error text, stacks and causes may contain patient data or credentials.
export function describeError(_error: unknown): string { return "Unexpected application error"; }
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  try {
    let input: Record<string, unknown> = {};
    for (const arg of args) if (arg instanceof Error) record(arg);
    if (args.length === 1 && typeof args[0] === "string") {
      try { const parsed = JSON.parse(args[0]); if (parsed && typeof parsed === "object") input = parsed; } catch { /* Discard free text. */ }
    }
    originalConsoleError(JSON.stringify(safeOperationalEvent(
      typeof input["category"] === "string" ? input["category"] : "internal_error",
      typeof input["component"] === "string" ? input["component"] : "portal-server", input,
    )));
  } catch { /* Logging cannot break the response. */ }
};
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("error", (event) => record((event as ErrorEvent).error));
  globalThis.addEventListener("unhandledrejection", (event) => record((event as PromiseRejectionEvent).reason));
}
export function consumeLastCapturedError(): unknown {
  const captured = lastCapturedError;
  lastCapturedError = undefined;
  return captured && Date.now() - captured.at <= 5000 ? captured.error : undefined;
}
