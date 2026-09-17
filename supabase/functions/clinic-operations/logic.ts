export type Staff = { id: string; full_name: string; specialty: string; services: string[]; aliases: string[] };

export function norm(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u064b-\u065f\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/\b(?:dr|doctor|dentist)\.?\b|دكتور|دكتوره|دكتورة|الدكتور|الدكتوره|الدكتورة|(^|\s)د\.?(?=\s)/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
function distance(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b), row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (x[i - 1] === y[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return row[y.length];
}
function score(query: string, candidate: string): number {
  const a = norm(query), b = norm(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const words = b.split(" ");
  if (a.length >= 4 && words.includes(a)) return 0.91;
  if (a.length < 5 || b.length < 5) return 0;
  const d = distance(a.replace(/ /g, ""), b.replace(/ /g, ""));
  const similarity = 1 - d / Math.max(a.length, b.length);
  return similarity >= 0.82 && d <= 3 ? similarity * 0.88 : 0;
}
export function resolveStaff(staff: Staff[], requested: string): { status: string; practitioner?: Staff; candidates?: string[] } {
  const ranked = staff.map(s => ({ staff: s, value: Math.max(...[s.full_name, ...(s.aliases ?? [])].map(n => score(requested, n))) }))
    .filter(x => x.value >= 0.72).sort((a, b) => b.value - a.value);
  if (!ranked.length) return { status: "not_found" };
  if (ranked.length > 1 && ranked[0].value - ranked[1].value < (ranked[0].value === 1 ? 0.001 : 0.12))
    return { status: "ambiguous", candidates: ranked.slice(0, 3).map(x => x.staff.full_name) };
  return { status: "resolved", practitioner: ranked[0].staff };
}
export function resolveService(staff: Staff[], requested: string, serviceAliases: Record<string, string[]> = {}): { status: string; service?: string; candidates?: string[] } {
  const services = [...new Set(staff.flatMap(s => s.services))];
  const ranked = services.map(service => ({ service, value: Math.max(...[service, ...(serviceAliases[service] ?? [])].map(n => score(requested, n))) }))
    .filter(x => x.value >= 0.72).sort((a, b) => b.value - a.value);
  if (!ranked.length) return { status: "not_found" };
  if (ranked.length > 1 && ranked[0].value - ranked[1].value < (ranked[0].value === 1 ? 0.001 : 0.12))
    return { status: "ambiguous", candidates: ranked.slice(0, 3).map(x => x.service) };
  return { status: "resolved", service: ranked[0].service };
}
export function phone(value: unknown, prefix = "+965", localLength = 8): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  const code = prefix.replace(/\D/g, "");
  if (!/^[0-9]{1,4}$/.test(code) || localLength < 6 || localLength > 14) return null;
  if (digits.length === localLength) return "+" + code + digits;
  if (digits.startsWith(code) && digits.length === code.length + localLength) return "+" + digits;
  return null;
}
export function value(args: Record<string, unknown>, key: string): string { return typeof args[key] === "string" ? String(args[key]).trim() : ""; }

export type TimeRange = { start_time: string; end_time: string };
export type WeeklyShift = TimeRange & { is_available: boolean };

export function slotIsOpen(
  shift: WeeklyShift, localStart: string, localEnd: string,
  slotStart: string, slotEnd: string, appointments: TimeRange[], timeOff: TimeRange[],
): boolean {
  const start = Date.parse(slotStart), end = Date.parse(slotEnd);
  const overlap = (range: TimeRange) => Date.parse(range.start_time) < end && Date.parse(range.end_time) > start;
  return shift.is_available && localStart >= shift.start_time.slice(0, 5) &&
    localEnd <= shift.end_time.slice(0, 5) &&
    !appointments.some(overlap) && !timeOff.some(overlap);
}
