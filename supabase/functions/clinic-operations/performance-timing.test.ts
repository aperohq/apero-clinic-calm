import assert from "node:assert/strict";
import test from "node:test";
import { createPerformanceTiming } from "./performance-timing.ts";

test("timing output contains only fixed action and phase labels, duration, and category", async () => {
  let clock = 10;
  const logs: string[] = [];
  const timing = createPerformanceTiming(
    () => clock,
    (line) => logs.push(line),
  );
  timing.setAction("book");
  assert.equal(
    await timing.run("booking_rpc", async () => {
      clock += 7;
      return "private result";
    }),
    "private result",
  );
  timing.finish("success");
  timing.finish("failure");
  assert.deepEqual(
    logs.map((line) => JSON.parse(line)),
    [
      { action: "book", phase: "booking_rpc", elapsed_ms: 7, category: "success" },
      { action: "book", phase: "total", elapsed_ms: 7, category: "success" },
    ],
  );
});

test("untrusted action text is not logged and rejected work is classified as failure", async () => {
  const logs: string[] = [];
  const timing = createPerformanceTiming(
    () => 1,
    (line) => logs.push(line),
  );
  timing.setAction("patient name or phone");
  await assert.rejects(
    timing.run("ownership_check", async () => {
      throw new Error("secret error text");
    }),
  );
  timing.finish("failure");
  assert.equal(
    logs.some((line) => line.includes("patient name") || line.includes("secret error text")),
    false,
  );
  assert.deepEqual(
    logs.map((line) => JSON.parse(line).category),
    ["failure", "failure"],
  );
});

test("a logging failure cannot change the caller response", () => {
  const timing = createPerformanceTiming(
    () => 1,
    () => {
      throw new Error("logger unavailable");
    },
  );
  timing.setAction("resolve");
  assert.equal(
    timing.runSync("service_resolution", () => "resolved"),
    "resolved",
  );
  assert.doesNotThrow(() => timing.finish("success"));
});
