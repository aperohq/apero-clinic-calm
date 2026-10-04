import { toClinicInput } from "./clinic-time";

export type Analytics = {
  timezone: string;
  startDate: string;
  endDate: string;
  totalCalls: number;
  totalAppointments: number;
  bookedAppointments: number;
  cancelledAppointments: number;
  otherAppointments: number;
  trend: { date: string; calls: number; appointments: number }[];
  practitioners: { id: string | null; label: string; count: number }[];
  services: { label: string; count: number }[];
  otherPractitionerAppointments: number;
  otherServiceAppointments: number;
};

// Calendar subtraction, not elapsed hours: includes today in the clinic zone.
export function analyticsRange(days: 7 | 30 | 90, timezone: string, now = new Date()) {
  const end = toClinicInput(now.toISOString(), timezone).slice(0, 10);
  const start = new Date(`${end}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: start.toISOString().slice(0, 10), end };
}
