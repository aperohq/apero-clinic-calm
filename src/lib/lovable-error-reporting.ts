type LovableErrorOptions = {
  mechanism?: "manual" | "onerror" | "unhandledrejection" | "react_error_boundary";
  handled?: boolean;
  severity?: "error" | "warning" | "info";
};

type LovableEvents = {
  track?: (event: string, properties?: Record<string, unknown>) => string | null;
  captureException?: (
    error: unknown,
    context?: Record<string, unknown>,
    options?: LovableErrorOptions,
  ) => void;
};

declare global {
  interface Window {
    __lovableEvents?: LovableEvents;
    __lovableReportRuntimeError?: (payload: {
      message: string;
      stack?: string;
      filename?: string;
    }) => void;
  }
}

export function reportLovableError(_error: unknown, _context: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  // Hooks may forward data to telemetry: send no route, URL, raw exception or context.
  const error = new Error("Unexpected application error");
  error.stack = undefined;
  try {
    window.__lovableEvents?.captureException?.(error, {source: "react_error_boundary"}, {
      mechanism: "react_error_boundary", handled: false, severity: "error",
    });
    window.__lovableReportRuntimeError?.({message: "Unexpected application error"});
  } catch { /* Error reporting must not interrupt the error UI. */ }
}
