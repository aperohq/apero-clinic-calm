import assert from "node:assert/strict";
import { test } from "node:test";
import { hasLiveBooking } from "../supabase/functions/_shared/call-outcome.ts";
import { phone } from "../supabase/functions/clinic-operations/logic.ts";
const op = (action, id, success = true) => ({ action, result: { appointment_id: id, success } });
test("final outcome follows latest successful action for each appointment", () => {
  assert.equal(hasLiveBooking([op("cancel", "a"), op("book", "a")]), false);
  assert.equal(hasLiveBooking([op("reschedule", "a"), op("book", "a")]), true);
  assert.equal(hasLiveBooking([op("cancel", "a"), op("book", "b"), op("book", "a")]), true);
  assert.equal(hasLiveBooking([op("book", "a", false)]), false);
  assert.equal(hasLiveBooking([]), false);
});
test("Kuwait phone formats normalize consistently, invalid inputs fail closed", () => {
  for (const v of ["12345678", "+96512345678", "965 1234 5678", "0096512345678"])
    assert.equal(phone(v), "+96512345678");
  assert.equal(phone("123"), null);
  assert.equal(phone("+97112345678"), null);
  assert.equal(phone("501234567", "+971", 9), "+971501234567");
});
