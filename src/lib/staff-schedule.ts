import type { StaffAvailabilityRow } from "./db-types";

export const STAFF_WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

export function buildWeeklyRows(availability: StaffAvailabilityRow[]) {
  return STAFF_WEEK_DAYS.map((day) => {
    const saved = availability.find((row) => row.day_of_week === day);
    return {
      day_of_week: day,
      start_time: saved?.start_time.slice(0, 5) ?? "",
      end_time: saved?.end_time.slice(0, 5) ?? "",
      is_available: saved?.is_available ?? false,
    };
  });
}

export type WeeklyScheduleRow = ReturnType<typeof buildWeeklyRows>[number];

export function schedulePayload(rows: WeeklyScheduleRow[]) {
  if (rows.length !== 7 || new Set(rows.map((row) => row.day_of_week)).size !== 7)
    throw new Error("Choose a valid seven-day schedule.");
  for (const row of rows) {
    if (row.is_available && (!row.start_time || !row.end_time))
      throw new Error("Set start and end times for each working day.");
    if ((row.start_time || row.end_time) && (!row.start_time || !row.end_time || row.end_time <= row.start_time))
      throw new Error("End time must be after start time for each day with hours.");
  }
  return rows.filter((row) => row.start_time && row.end_time);
}
