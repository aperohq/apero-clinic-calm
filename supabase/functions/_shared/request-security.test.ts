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
