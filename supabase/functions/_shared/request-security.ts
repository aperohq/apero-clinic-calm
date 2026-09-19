export class RequestBodyTooLargeError extends Error {}

/** Read a request body without allowing an unbounded allocation. */
export async function readLimitedBody(req: Request, maxBytes: number): Promise<string> {
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
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
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "unknown")
    : "unknown";
  console.error(`${operation} failed (code: ${code})`);
}
