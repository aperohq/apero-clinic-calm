import type { BusyInterval, ClinicSystemAdapter, IntegrationAppointment } from "./adapter.ts";
import { externalEventId, ProviderError } from "./adapter.ts";
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];
export type GoogleTokens = { access_token: string; refresh_token: string; expires_at: number };
export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };
export function oauthUrl(config: GoogleConfig, state: string, challenge: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return u.href;
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const header = response.headers.get("retry-after");
    const seconds = Number(header);
    const retryAfter =
      header && !Number.isFinite(seconds)
        ? Math.max(0, (Date.parse(header) - Date.now()) / 1000)
        : seconds;
    let reason = "";
    try {
      const details = await response.json();
      reason =
        typeof details.error === "string"
          ? details.error
          : (details.error?.errors?.[0]?.reason ?? "");
    } catch {
      /* No provider body is required for retry classification. */
    }
    const authorization = response.status === 401 || reason === "invalid_grant";
    const limited = ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(
      reason,
    );
    throw new ProviderError(
      authorization
        ? "google_reauthorization_required"
        : response.status === 410
          ? "google_event_deleted"
          : `google_http_${response.status}`,
      limited || response.status === 429 || response.status >= 500,
      Number.isFinite(retryAfter) ? retryAfter : 0,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}
export async function exchangeToken(
  config: GoogleConfig,
  params: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<GoogleTokens> {
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      ...params,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const body = await responseJson(response);
  if (
    typeof body["access_token"] !== "string" ||
    typeof body["expires_in"] !== "number" ||
    body["expires_in"] <= 0
  )
    throw new ProviderError("google_invalid_token_response", false);
  const refresh =
    typeof body["refresh_token"] === "string" ? body["refresh_token"] : params["refresh_token"];
  if (!refresh) throw new ProviderError("google_refresh_token_missing", false);
  // Google may omit scope on refresh. On first exchange require the full granted scope set.
  if (
    params["grant_type"] === "authorization_code" &&
    (typeof body["scope"] !== "string" ||
      GOOGLE_SCOPES.some((s) => !(body["scope"] as string).split(" ").includes(s)))
  )
    throw new ProviderError("google_missing_permissions", false);
  return {
    access_token: body["access_token"],
    refresh_token: refresh,
    expires_at: Date.now() + body["expires_in"] * 1000,
  };
}
export function dayBoundary(date: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ProviderError("google_invalid_event", false);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const day = (seconds: number) => {
    const parts = formatter.formatToParts(new Date(seconds * 1000));
    return ["year", "month", "day"]
      .map((key) => parts.find((p) => p.type === key)!.value)
      .join("-");
  };
  const center = Date.parse(date + "T00:00:00Z") / 1000;
  if (!Number.isFinite(center)) throw new ProviderError("google_invalid_event", false);
  let lo = center - 36 * 3600,
    hi = center + 36 * 3600;
  // First instant of this local date, including midnight offset transitions.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (day(mid) < date) lo = mid;
    else hi = mid;
  }
  return new Date(hi * 1000).toISOString();
}
export class GoogleCalendarAdapter implements ClinicSystemAdapter {
  readonly provider = "google";
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string, init: RequestInit = {}) {
    return this.fetcher("https://www.googleapis.com/calendar/v3/" + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  }
  async calendars() {
    const result: Array<{ id: string; name: string }> = [];
    let page = "";
    for (let n = 0; n < 20; n++) {
      const data = await responseJson(
        await this.request(
          "users/me/calendarList?" +
            new URLSearchParams({
              fields: "items(id,summary),nextPageToken",
              minAccessRole: "writer",
              maxResults: "250",
              ...(page ? { pageToken: page } : {}),
            }),
        ),
      );
      if (!Array.isArray(data["items"])) throw new ProviderError("google_invalid_response", false);
      for (const c of data["items"] as Array<Record<string, unknown>>)
        if (typeof c["id"] === "string")
          result.push({
            id: c["id"],
            name: typeof c["summary"] === "string" ? c["summary"] : c["id"],
          });
      page = typeof data["nextPageToken"] === "string" ? data["nextPageToken"] : "";
      if (!page) return result;
    }
    throw new ProviderError("google_page_limit", false);
  }
  async busy(calendar: string, from: string, until: string): Promise<BusyInterval[]> {
    const result: BusyInterval[] = [];
    let page = "";
    for (let n = 0; n < 40; n++) {
      const data = await responseJson(
        await this.request(
          `calendars/${encodeURIComponent(calendar)}/events?` +
            new URLSearchParams({
              fields: "items(id,status,transparency,eventType,start,end),nextPageToken,timeZone",
              timeMin: from,
              timeMax: until,
              singleEvents: "true",
              showDeleted: "false",
              maxResults: "2500",
              ...(page ? { pageToken: page } : {}),
            }),
        ),
      );
      if (!Array.isArray(data["items"])) throw new ProviderError("google_invalid_response", false);
      for (const e of data["items"] as Array<Record<string, unknown>>) {
        if (
          e["status"] === "cancelled" ||
          e["transparency"] === "transparent" ||
          e["eventType"] === "workingLocation"
        )
          continue;
        const start = e["start"] as
          { dateTime?: string; date?: string; timeZone?: string } | undefined;
        const end = e["end"] as { dateTime?: string; date?: string; timeZone?: string } | undefined;
        const zone = typeof data["timeZone"] === "string" ? data["timeZone"] : "UTC";
        const s =
          start?.dateTime ??
          (start?.date ? dayBoundary(start.date, start.timeZone ?? zone) : undefined);
        const t =
          end?.dateTime ?? (end?.date ? dayBoundary(end.date, end.timeZone ?? zone) : undefined);
        if (
          typeof e["id"] !== "string" ||
          !s ||
          !t ||
          !Number.isFinite(Date.parse(s)) ||
          !Number.isFinite(Date.parse(t)) ||
          Date.parse(t) <= Date.parse(s)
        )
          throw new ProviderError("google_invalid_event", false);
        result.push({ id: e["id"], start: s, end: t });
        if (result.length > 10000) throw new ProviderError("google_event_limit", false);
      }
      page = typeof data["nextPageToken"] === "string" ? data["nextPageToken"] : "";
      if (!page) return result;
    }
    throw new ProviderError("google_page_limit", false);
  }
  async upsert(calendar: string, a: IntegrationAppointment, eventId = externalEventId(a.id)) {
    const path = `calendars/${encodeURIComponent(calendar)}/events`,
      id = eventId;
    // No patient names, phone, notes, attendees or service data leave Apero.
    const body = {
      id,
      summary: "Reserved appointment",
      start: { dateTime: a.start_time },
      end: { dateTime: a.end_time },
      transparency: "opaque",
    };
    const response = await this.request(`${path}/${id}?sendUpdates=none`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (response.status === 410) throw new ProviderError("google_event_deleted", false);
    if (response.status === 404) {
      const insert = await this.request(path + "?sendUpdates=none", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (insert.status === 409) {
        await responseJson(
          await this.request(`${path}/${id}?sendUpdates=none`, {
            method: "PUT",
            body: JSON.stringify(body),
          }),
        );
        return;
      }
      await responseJson(insert);
      return;
    }
    await responseJson(response);
  }
  async cancel(calendar: string, appointmentId: string, eventId = externalEventId(appointmentId)) {
    const response = await this.request(
      `calendars/${encodeURIComponent(calendar)}/events/${eventId}?sendUpdates=none`,
      { method: "DELETE" },
    );
    if (![204, 404, 410].includes(response.status)) await responseJson(response);
  }
}
