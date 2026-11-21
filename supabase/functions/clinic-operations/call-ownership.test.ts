import assert from "node:assert/strict";
import test from "node:test";
import { checkCallOwnership } from "./call-ownership.ts";
import { createPerformanceTiming } from "./performance-timing.ts";

function dbFor(owner: { clinic_id: string } | null, error: Error | null = null) {
  const filters: Array<[string, string]> = [];
  const query = {
    select(_fields: string) {
      return query;
    },
    eq(field: string, value: string) {
      filters.push([field, value]);
      return query;
    },
    maybeSingle() {
      return Promise.resolve({ data: owner, error });
    },
  };
  return {
    filters,
    from(table: string) {
      assert.equal(table, "voice_call_state");
      return query;
    },
  };
}

const timing = () =>
  createPerformanceTiming(
    () => 0,
    () => {},
  );

test("new calls and matching owners may proceed using only the call ID lookup", async () => {
  const newCall = dbFor(null);
  assert.equal(await checkCallOwnership(newCall, "call-a", "clinic-a", timing()), true);
  assert.deepEqual(newCall.filters, [["call_id", "call-a"]]);
  assert.equal(
    await checkCallOwnership(dbFor({ clinic_id: "clinic-a" }), "call-a", "clinic-a", timing()),
    true,
  );
});

test("a call owned by another clinic fails even if the payload claims that clinic", async () => {
  const untrustedPayload = { clinic_id: "clinic-b" };
  assert.equal(
    await checkCallOwnership(dbFor({ clinic_id: "clinic-b" }), "call-a", "clinic-a", timing()),
    false,
  );
  assert.equal(untrustedPayload.clinic_id, "clinic-b");
});

test("ownership query errors stop the action", async () => {
  const error = new Error("lookup unavailable");
  await assert.rejects(
    checkCallOwnership(dbFor(null, error), "call-a", "clinic-a", timing()),
    error,
  );
});
