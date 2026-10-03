export class RequestBodyTooLargeError extends Error {}

/** Read a request body without allowing an unbounded allocation. */
export async function readLimitedBody(
  req: Request,
  maxBytes: number,
  signal: AbortSignal = req.signal,
): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new RequestBodyTooLargeError("Request body is too large");
    }
  }

  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reads = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      if (++reads > maxBytes + 1) {
        void reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError("Too many body chunks");
      }
      const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>(
        (resolve, reject) => {
          const abort = () => {
            void reader.cancel().catch(() => {});
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          reader
            .read()
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
          if (signal.aborted) abort();
        },
      );
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError("Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Log only a stable operation label and database error code. */
export function logDatabaseFailure(operation: string, error: unknown): void {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "unknown")
      : "unknown";
  console.error(`${operation} failed (code: ${code})`);
}
