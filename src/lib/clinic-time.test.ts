import assert from "node:assert/strict";
import test from "node:test";
import { fromClinicInput, toClinicInput } from "./clinic-time.ts";

test("clinic time off uses the clinic timezone instead of browser time", () => {
  assert.equal(fromClinicInput("2026-10-14T14:00", "Asia/Kuwait"), "2026-10-14T11:00:00.000Z");
  assert.equal(toClinicInput("2026-10-14T14:00:00.000Z", "Asia/Kuwait"), "2026-10-14T17:00");
});

test("invalid calendar date does not silently become another day", () => {
  assert.throws(() => fromClinicInput("2026-02-30T14:00", "Asia/Kuwait"));
});
