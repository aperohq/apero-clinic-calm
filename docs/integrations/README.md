# Apero integration system

Local code and synthetic evidence are separate from Google authorization and production acceptance. Start with [execution state](EXECUTION_STATE.md), [tracker](EXECUTION_TRACKER.md), [approvals](APPROVALS_REQUIRED.md) and [release runbook](RELEASE_RUNBOOK.md). The comprehensive resumable Codex instruction is [CODEX_EXECUTION_PROMPT.md](CODEX_EXECUTION_PROMPT.md).

## API and authority

The API base is `<SUPABASE_URL>/functions/v1/integration-api`. API clients send `Authorization: Bearer <clinic API key>`. Some Supabase gateway configurations also require the public project `apikey` header; that header never grants clinic authority. Keys contain 256 random bits; only SHA-256 digests are persisted. Owners create, rotate and revoke keys from Account → Integrations. Raw keys appear once in component memory and never in query caches or persistent storage. Keys expire after 90 days. Rotation atomically revokes the previous key. Each key has a 60 request/minute budget; denied scopes never authorize an operation.

| Endpoint                                                                 | Permission           | Contract                                                                                                                              |
| ------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/appointments?from=<ISO instant>&until=<ISO instant>`            | `appointments:read`  | Half-open interval, at most 31 days and 200 records; narrow the date range on HTTP 422. No patient/contact/notes fields are returned. |
| `GET /v1/availability?staff_id=<uuid>&service=<service>&date=YYYY-MM-DD` | `availability:read`  | Existing shared clinic-local scheduling rules, selected calendar busy intervals and freshness/horizon gate.                           |
| `POST /v1/appointments`                                                  | `appointments:write` | Requires `Idempotency-Key` with 8–128 characters. See bodies below.                                                                   |

Booking requires an **existing clinic client ID**; patient creation and broad patient export are intentionally outside these permissions. The clinic always comes from the authenticated key. Supplying `clinic_id` or unknown mutation fields is rejected. Staff and client relationships are checked by shared database rules. Rescheduling preserves patient, practitioner, service and duration, matching the existing portal/Retell contract.

```json
{
  "action": "book",
  "client_id": "<existing clinic client UUID>",
  "staff_id": "<clinic practitioner UUID>",
  "service": "Consultation",
  "start_time": "2027-01-05T09:00:00Z",
  "end_time": "2027-01-05T09:45:00Z"
}
```

```json
{ "action": "cancel", "appointment_id": "<clinic appointment UUID>" }
```

```json
{
  "action": "reschedule",
  "appointment_id": "<clinic appointment UUID>",
  "start_time": "2027-01-05T10:00:00Z",
  "end_time": "2027-01-05T10:45:00Z"
}
```

Replaying an identical mutation with the same key and idempotency value returns the committed result. A different body returns 409. The appointment, result, audit and synchronization outbox commit together. Keep idempotency keys unique permanently: the configured operation retention policy can eventually expire saved results (default 30 days only after retention is separately enabled). Never retry old operations beyond that window as if they were new. Slot conflicts return 409, invalid/forbidden appointment data returns a generic rejection, unavailable dependencies return 503, and rate limits return 429 with `Retry-After: 60`.

## Calendar synchronization

Apero is authoritative for appointment records. Google contributes external busy events and receives a generic **Reserved appointment** event for each Apero booking. Names, phones, services, notes, attendees and invitations are never exported. Cancellation removes the owned event; rescheduling updates it. External calendar edits do not silently change patient appointments in Apero. Missing or edited owned events are queued for reconciliation; conflicts require attention. This avoids treating untrusted calendar titles as patient scheduling instructions.

One active writable Google calendar maps to one practitioner per clinic; neither calendar nor practitioner can change after selection. Disconnect before replacing. Selection queues existing future bookings. Google OAuth uses offline consent, PKCE, expiring single-use server state, browser session state, and the initiating owner's authenticated completion request. The callback relays only the short-lived code to Account and the UI immediately removes it from the URL. No token exchange occurs until both browser state and current owner membership match. Tokens are AES-256-GCM encrypted with clinic/connection authenticated context; refresh is serialized with worker leases and compare-and-swap persistence. Owner management never relies on user-editable JWT metadata.

Availability snapshots use full, paginated, expanded events in a bounded rolling window (yesterday through 90 days ahead). This implementation deliberately uses full snapshots rather than incremental sync tokens, avoiding partial-page/token-reset state. Transparent, cancelled and working-location events do not block time; all-day events respect the calendar timezone and daylight-saving boundaries. Partial responses omit descriptions and other unnecessary event fields. Snapshot replacement is atomic; a failed page never publishes partial availability. More than 10,000 busy intervals fails closed. Slots beyond the snapshot horizon, with a snapshot older than five minutes, or with a connection requiring attention are unavailable.

Google push messages contain no event body. The webhook verifies the random channel token hash, channel ID, resource ID, expiration and message number before durable queueing. Replays/out-of-order messages are acknowledged without repeating work. Initial `sync` notifications are supported before `watch` returns. Watches renew before expiry; periodic polling recovers missed notifications. Channel loss never disables polling.

Google does not offer a transaction with Apero or enforce appointment exclusivity. Local appointment writers and busy importers serialize on connection rows, and the existing GiST exclusion constraint prevents competing local bookings. A fresh provider check precedes each outbound booking. A Google user can still create an overlapping event between that check and the write; the next notification/poll detects the conflict, marks the connection for attention and pauses new bookings. Do not claim distributed, real-time double-booking prevention against arbitrary concurrent Google edits.

## Recovery and observability

The scheduled worker drains at most 20 jobs per invocation with bounded networking. Work is serialized per connection, leased for 180 seconds and fenced by lease IDs. Job generations preserve mutations that arrive during processing. Missing local appointments and staff reassignment remove their prior owned events. Stable event IDs make retry after an uncertain provider response safe. HTTP 429/Google quota failures and 5xx use bounded exponential jitter and `Retry-After`; permanent failures back off for an hour. Eight failed attempts dead-letter a generation. Owner **Retry synchronization** resets budgets and requeues a pull; polling never resets failed push budgets.

Dashboard metadata shows connection state, last synchronization, errors and failed jobs. Structured worker logs contain IDs, a fixed failure code and elapsed time; no provider response, query string, token or patient data. API key lifecycle, OAuth connection, calendar selection, manual retry and appointment changes produce restricted audit records. Audit/idempotency cleanup respects the existing approved retention mode, clinic overrides, pause and legal hold. Approved clinic offboarding revokes keys, removes credentials/states and clears queued work immediately; clinic deletion cascades internal rows.

Operational alerts should cover: snapshot lag >2 minutes, any dead-letter job, `external_calendar_conflict`, Google authorization failures, worker HTTP 503s and absent scheduled invocations. The dashboard's five-minute booking gate is the final safety mechanism, not the alert threshold.

Permanent errors require an operator: `google_reauthorization_required` → disconnect and reconnect; `google_missing_permissions` → repeat consent with both scopes; `external_calendar_conflict` → reconcile the conflicting external event or Apero appointment and retry; persistent 409/410 → inspect provider access and retry. A deleted owned event receives a new durable identity revision under its worker lease before retry, so Google tombstones do not cause endless reuse of a deleted ID. Disconnect removes local credentials and stops work; it leaves Google events and the account-level Google grant intact. The clinic must review remaining events and revoke Apero from Google account permissions if desired. An already in-flight Google request can finish while disconnection is occurring.

## Provider adapter contract

`ClinicSystemAdapter` defines calendar discovery, bounded busy reads, stable-ID upsert and retry-safe cancellation. Google is the registered implementation. A future clinic-system adapter must use reviewed fixed provider hosts, tenant-isolated encrypted credentials, idempotent external identity, bounded pagination, sanitized failures and synthetic contract tests. No provider endpoint or arbitrary webhook target is accepted from an API key. A real clinic-software connector remains externally blocked until a provider and account contract are identified.

## References

Implementation follows Google's [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [push notifications](https://developers.google.com/workspace/calendar/api/guides/push), [event insertion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) and [sync guidance](https://developers.google.com/workspace/calendar/api/guides/sync). This implementation uses the documented full-list option rather than incremental tokens.
