import assert from "node:assert/strict";
import test from "node:test";
import { buildWeeklyRows, STAFF_WEEK_DAYS } from "./staff-schedule.ts";
import type { StaffAvailabilityRow } from "./db-types.ts";

test("weekly editor represents Monday through Sunday without inventing missing hours", () => {
  const saved = [
    { day_of_week: 3, start_time: "11:00:00", end_time: "18:00:00", is_available: false },
    { day_of_week: 0, start_time: "09:30:00", end_time: "14:00:00", is_available: true },
  ] as StaffAvailabilityRow[];
  const rows = buildWeeklyRows(saved);
  assert.deepEqual(rows.map((row) => row.day_of_week), STAFF_WEEK_DAYS);
  assert.deepEqual(rows[2], { day_of_week: 3, start_time: "11:00", end_time: "18:00", is_available: false });
  assert.deepEqual(rows[6], { day_of_week: 0, start_time: "09:30", end_time: "14:00", is_available: true });
  assert.deepEqual(rows[5], { day_of_week: 6, start_time: "", end_time: "", is_available: false });
});

test("Add Staff sends only explicitly configured hours", async () => {
  const { schedulePayload } = await import("./staff-schedule.ts");
  const rows = buildWeeklyRows([]);
  assert.deepEqual(schedulePayload(rows), []);
  rows[0]!.is_available = true;
  assert.throws(() => schedulePayload(rows), /start and end/);
  rows[0]!.start_time = "09:00";
  rows[0]!.end_time = "17:00";
  assert.deepEqual(schedulePayload(rows), [rows[0]]);
  rows[0]!.is_available = false;
  assert.deepEqual(schedulePayload(rows), [rows[0]]);
});
