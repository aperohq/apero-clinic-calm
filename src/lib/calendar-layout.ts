import type { AppointmentRow } from "./db-types";
import { toClinicInput } from "./clinic-time";

export function clinicWeek(now: Date, timeZone: string, offset: number) {
  const start = new Date(`${toClinicInput(now.toISOString(), timeZone).slice(0, 10)}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay() + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + i);
    return date;
  });
}

export type CalendarSegment = {
  appointment: AppointmentRow;
  day: number;
  start: number;
  end: number;
  lane: number;
  lanes: number;
};
const minutesOf = (local: string) => Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));

// Split overnight records at clinic midnight and assign parallel columns to
// connected overlap groups so every existing appointment remains clickable.
export function calendarSegments(
  appointments: AppointmentRow[],
  week: Date[],
  timeZone: string,
  staffFilter: string,
) {
  const segments: CalendarSegment[] = [];
  for (const appointment of appointments) {
    if (
      appointment.status === "Cancelled" ||
      (staffFilter !== "all" && appointment.staff_id !== staffFilter)
    )
      continue;
    if (Date.parse(appointment.end_time) <= Date.parse(appointment.start_time)) continue;
    const start = toClinicInput(appointment.start_time, timeZone);
    const end = toClinicInput(appointment.end_time, timeZone);
    week.forEach((date, day) => {
      const key = date.toISOString().slice(0, 10);
      if (key < start.slice(0, 10) || key > end.slice(0, 10)) return;
      const from = key === start.slice(0, 10) ? minutesOf(start) : 0;
      const elapsed =
        (Date.parse(appointment.end_time) - Date.parse(appointment.start_time)) / 60_000;
      // The grid uses clinic wall-clock hours; card height represents elapsed
      // duration even when a DST clock change repeats or skips an hour.
      const to =
        start.slice(0, 10) === end.slice(0, 10)
          ? Math.min(1440, from + elapsed)
          : key === end.slice(0, 10)
            ? minutesOf(end)
            : 1440;
      if (to > from) segments.push({ appointment, day, start: from, end: to, lane: 0, lanes: 1 });
    });
  }
  for (let day = 0; day < 7; day++) {
    const sorted = segments
      .filter((s) => s.day === day)
      .sort(
        (a, b) =>
          a.start - b.start || a.end - b.end || a.appointment.id.localeCompare(b.appointment.id),
      );
    let group: CalendarSegment[] = [];
    let laneEnds: number[] = [];
    let groupEnd = -1;
    const finish = () => {
      group.forEach((s) => {
        s.lanes = laneEnds.length;
      });
    };
    for (const segment of sorted) {
      if (segment.start >= groupEnd) {
        finish();
        group = [];
        laneEnds = [];
      }
      const lane = laneEnds.findIndex((end) => end <= segment.start);
      segment.lane = lane < 0 ? laneEnds.length : lane;
      laneEnds[segment.lane] = Math.max(segment.end, segment.start + 24);
      groupEnd = Math.max(...laneEnds);
      group.push(segment);
    }
    finish();
  }
  return segments;
}
