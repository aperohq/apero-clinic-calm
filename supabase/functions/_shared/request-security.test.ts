import assert from "node:assert/strict";
import test from "node:test";
import { readLimitedBody, RequestBodyTooLargeError } from "./request-security.ts";

test("accepts a request body within the byte limit", async () => {
  const req = new Request("https://example.test", { method: "POST", body: "مرحبا" });
  assert.equal(await readLimitedBody(req, 32), "مرحبا");
});

test("rejects a declared body larger than the limit", async () => {
  const req = new Request("https://example.test", {
    method: "POST",
    body: "small",
    headers: { "content-length": "1000" },
  });
  await assert.rejects(() => readLimitedBody(req, 16), RequestBodyTooLargeError);
});

test("rejects a streamed body larger than the limit", async () => {
  const req = new Request("https://example.test", { method: "POST", body: "123456789" });
  await assert.rejects(() => readLimitedBody(req, 8), RequestBodyTooLargeError);
});

test("aborts a stalled body using the total request signal", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const req = new Request("https://example.test", {
    method: "POST",
    duplex: "half",
    body: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  } as RequestInit);
  const reading = readLimitedBody(req, 32, controller.signal);
  controller.abort(new Error("deadline"));
  await assert.rejects(reading, /deadline/);
  assert.equal(cancelled, true);
});

test("bounds empty-chunk work and does not await a stalled cancellation", async () => {
  let reads = 0;
  const req = new Request("https://example.test", {
    method: "POST",
    duplex: "half",
    body: new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        return new Promise(() => {});
      },
    }),
  } as RequestInit);
  await assert.rejects(() => readLimitedBody(req, 8), RequestBodyTooLargeError);
  assert.ok(reads <= 11);
});
