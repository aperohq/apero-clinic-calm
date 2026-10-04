import type { ClinicRow } from "./db-types";

export const SETTINGS_FIELDS = [
  "name",
  "localized_name",
  "clinic_type",
  "email",
  "website",
  "phone",
  "fallback_phone",
  "address",
  "city",
  "country",
  "directions",
  "parking_information",
  "timezone",
  "receptionist_name",
  "receptionist_localized_name",
  "opening_hours",
] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];
export type HoursPeriod = { start: string; end: string };
export type ClinicHours = { days: { day: number; periods: HoursPeriod[] }[] };
export type ClinicSettings = Pick<ClinicRow, SettingsField>;
export type SettingsDraft = Record<Exclude<SettingsField, "opening_hours">, string> & {
  opening_hours: ClinicHours | null;
};
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export const TEXT_LIMITS = {
  name: 200,
  localized_name: 200,
  clinic_type: 100,
  email: 254,
  website: 2048,
  phone: 50,
  fallback_phone: 50,
  address: 1000,
  city: 100,
  country: 100,
  directions: 4000,
  parking_information: 4000,
  timezone: 100,
  receptionist_name: 100,
  receptionist_localized_name: 100,
} as const;
export class SettingsValidationError extends Error {}

export function validTimeZone(value: string): boolean {
  if (value !== "UTC" && !/^[A-Za-z_+-]+\/[A-Za-z0-9_/+-]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function validateHours(value: unknown): ClinicHours | null {
  if (value === null) return null;
  const invalid = () => {
    throw new SettingsValidationError(
      "Enter valid clinic hours, with up to four non-overlapping periods per day.",
    );
  };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "days"
  )
    return invalid();
  const days = Reflect.get(value, "days") as unknown;
  if (!Array.isArray(days) || days.length !== 7) return invalid();
  const seen = new Set<number>();
  const normalized = days
    .map((item: unknown) => {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).sort().join() !== "day,periods"
      )
        return invalid();
      const day = Reflect.get(item, "day") as unknown,
        periods = Reflect.get(item, "periods") as unknown;
      if (
        typeof day !== "number" ||
        !Number.isInteger(day) ||
        day < 0 ||
        day > 6 ||
        seen.has(day) ||
        !Array.isArray(periods) ||
        periods.length > 4
      )
        return invalid();
      seen.add(day);
      const parsed = periods
        .map((period: unknown) => {
          if (
            !period ||
            typeof period !== "object" ||
            Array.isArray(period) ||
            Object.keys(period).sort().join() !== "end,start"
          )
            return invalid();
          const start = Reflect.get(period, "start"),
            end = Reflect.get(period, "end");
          if (
            typeof start !== "string" ||
            typeof end !== "string" ||
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) ||
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) ||
            start >= end
          )
            return invalid();
          return { start, end };
        })
        .sort((a, b) => a.start.localeCompare(b.start));
      for (let i = 1; i < parsed.length; i++)
        if (parsed[i]!.start < parsed[i - 1]!.end) return invalid();
      return { day, periods: parsed };
    })
    .sort((a, b) => a.day - b.day);
  return { days: normalized };
}

export function settingsDraft(row: ClinicSettings): SettingsDraft {
  return Object.fromEntries(
    SETTINGS_FIELDS.map((key) => [
      key,
      key === "opening_hours" ? structuredClone(row[key] ?? null) : (row[key] ?? ""),
    ]),
  ) as SettingsDraft;
}
export function emptyHours(): ClinicHours {
  return { days: WEEKDAYS.map((_, day) => ({ day, periods: [] })) };
}
export function normalizeSettings(draft: SettingsDraft, original?: ClinicSettings): ClinicSettings {
  const row = {} as ClinicSettings;
  for (const key of SETTINGS_FIELDS) {
    if (original && JSON.stringify(draft[key]) === JSON.stringify(settingsDraft(original)[key])) {
      Object.assign(row, { [key]: original[key] ?? null });
      continue;
    }
    if (key === "opening_hours") {
      row[key] = validateHours(draft[key]);
      continue;
    }
    const value = draft[key].trim();
    if (value.length > TEXT_LIMITS[key])
      throw new SettingsValidationError(
        "One of the settings is too long. Shorten it and try again.",
      );
    if (key === "name" && !value) throw new SettingsValidationError("Enter the clinic name.");
    if (key === "timezone" && !validTimeZone(value))
      throw new SettingsValidationError(
        "Choose a valid IANA timezone, such as Europe/London or UTC.",
      );
    if (key === "email" && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw new SettingsValidationError("Enter a valid clinic email address.");
    if (
      (key === "phone" || key === "fallback_phone") &&
      value &&
      (!/^\+?[0-9 ().-]+$/.test(value) ||
        value.replace(/\D/g, "").length < 6 ||
        value.replace(/\D/g, "").length > 15)
    )
      throw new SettingsValidationError("Enter a valid phone number with 6–15 digits.");
    if (key === "website" && value) {
      try {
        const url = new URL(value);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          !url.hostname ||
          url.username ||
          url.password ||
          !/^https?:\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?([/?#][^\s]*)?$/.test(
            value,
          )
        )
          throw new Error();
      } catch {
        throw new SettingsValidationError(
          "Enter a complete website URL starting with https:// or http://.",
        );
      }
    }
    Object.assign(row, { [key]: value || null });
  }
  return row;
}
export function changedSettings(
  original: ClinicSettings,
  next: ClinicSettings,
): Partial<ClinicSettings> {
  return Object.fromEntries(
    SETTINGS_FIELDS.filter(
      (key) => JSON.stringify(original[key] ?? null) !== JSON.stringify(next[key]),
    ).map((key) => [key, next[key]]),
  );
}
