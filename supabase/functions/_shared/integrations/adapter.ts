/** Provider-neutral contract. Apero owns appointments; external events contribute busy intervals.
 * Adapters must use stable external IDs and never accept arbitrary network destinations from users.
 * Register a provider in code only after tenant credential/authentication and contract tests exist. */
export type BusyInterval = { id: string; start: string; end: string };
export type IntegrationAppointment = {
  id: string;
  staff_id: string | null;
  status: string;
  start_time: string;
  end_time: string;
};
export interface ClinicSystemAdapter {
  readonly provider: string;
  calendars(): Promise<Array<{ id: string; name: string }>>;
  busy(calendar: string, from: string, until: string): Promise<BusyInterval[]>;
  upsert(calendar: string, appointment: IntegrationAppointment, externalId?: string): Promise<void>;
  cancel(calendar: string, appointmentId: string, externalId?: string): Promise<void>;
}
export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfter = 0,
  ) {
    super(code);
  }
}
export function retryDelay(attempt: number, retryAfter = 0, random = Math.random): number {
  return Math.min(
    3600,
    Math.max(
      retryAfter,
      Math.round(Math.min(1800, 2 ** Math.min(attempt, 11)) * (0.75 + random() * 0.5)),
    ),
  );
}
export function externalEventId(appointmentId: string): string {
  // Google accepts base32hex a-v and 0-9; UUID hex plus this prefix is valid.
  return "apero" + appointmentId.replaceAll("-", "");
}
