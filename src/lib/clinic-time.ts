const partsFor = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return [get("year"), get("month"), get("day"), get("hour"), get("minute")] as const;
};

export function toClinicInput(iso: string, timeZone: string): string {
  const [year, month, day, hour, minute] = partsFor(new Date(iso), timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function fromClinicInput(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter a valid date and time.");
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(desired)) throw new Error("Enter a valid date and time.");
  let instant = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const [y, m, d, h, min] = partsFor(new Date(instant), timeZone);
    const difference = desired - Date.UTC(y, m - 1, d, h, min);
    if (difference === 0 && toClinicInput(new Date(instant).toISOString(), timeZone) === value) return new Date(instant).toISOString();
    instant += difference;
  }
  throw new Error("This local time is not valid in the clinic timezone.");
}

export function appointmentRange(date: string, time: string, minutes: number, timeZone: string) {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new Error("Enter a valid appointment duration.");
  const start = fromClinicInput(`${date}T${time}`, timeZone);
  return { start, end: new Date(Date.parse(start) + minutes * 60_000).toISOString() };
}
