# Calendar unavailable fallback

This release changes only schedule-access failure handling. The release is built
from production `clinic-operations` v9 and Git `04e0ac7`, separately from the
unrelated working-tree routing, performance, mobile, account and permissions edits.
Normal service/practitioner/date validation and successful availability results
retain their existing behavior. Recording and failed-booking source files are
unchanged.

## Existing structures and gap

Apero already had signed clinic integration resolution, call ownership checks,
appointment availability RPCs, checked slots, booking validation, and an
Owner/Manager Requests queue backed by `voice_requests` with existing clinic RLS.
Schedule errors previously became generic tool failures; null/malformed scheduling
responses were not explicitly validated, and calendar failures did not produce a
specific retained follow-up or persistent no-retry state.

## Behavior

Errors, exceptions, unreachable dependencies, timeouts and invalid scheduling
responses return `error_type`/`failure_category: calendar_unavailable`, no slots,
`availability_checked: false`, `appointment_booked: false`,
`appointment_confirmed: false`, no appointment ID, and `retry_allowed: false`.
The exact representative response is in `calendar-unavailable-response.json`.
Valid empty schedules remain successful checks with `error_type: no_slots`.
Expected caller-input validation failures retain the existing clarification paths.

Patient wording:

> I’m sorry, I can’t access the clinic’s availability right now. I can take your preferred date and time so the clinic can follow up with you.

The response also explicitly states that no appointment is confirmed. Retell
clears old availability evidence before checking, handles transport/missing-result
failure, collects missing preferences one question at a time, and only promises
retention when `follow_up_saved` is true. Failed retention directs the caller to
the clinic without promising receipt.

## Retention, display and recovery

Complete patient name, normalized phone, service and preferred date/time are
saved once per verified clinic/call to existing `voice_requests`, kind `message`,
status `Open`. Clinic ID, call ID, patient name and phone use existing columns;
service, preferred date/time, optional practitioner, `calendar_unavailable`, a
failure timestamp and staff verification instructions use the existing `reason`
field. The row also has its normal database creation timestamp.

The request key is `calendar-unavailable:<clinic-id>:<call-id>`. A closed request
is not silently reopened or duplicated. The Requests card title is
**Calendar unavailable — follow-up**. The same label starts the stored reason,
so existing published Requests views also show it in the body.

A single additive `calendar_unavailable` boolean on existing `voice_call_state`
prevents further availability checks or booking/rescheduling for that call.
Ordinary invalidation does not clear this flag. Staff must verify the real
schedule before confirming anything. A complete database outage can prevent
both state and request writes; the AI still receives a no-retry, unconfirmed
response and the Retell failure path does not return to scheduling.

## Logging

Calendar failure logs contain only `clinic_id`, `call_id`, fixed failure category,
safe dependency category, and `follow_up_saved`. No patient/contact details,
transcripts, slot tokens, secrets, exception messages or raw provider responses
are logged. Retention failure does not introduce raw-error logging.

## Local validation

All checks passed on the isolated release before deployment:

- `npm run test:calendar-unavailable`: 17 fallback/database tests, 17 actual
  signed Edge handler tests and 5 flow/display tests.
- The same 5 flow checks against the actual published Retell v7 export.
- `npm run test:booking-fallback`: 15 booking helper tests, 17 Edge tests and
  16 existing Retell master tests.
- `npm run test:appointments`: 18 appointment and 19 calendar tests.
- `npm run test:appointment-conflicts`: 12 tests.
- Frontend TypeScript, calendar helper TypeScript, production build and diff check.

Coverage includes successful and valid-empty availability, backend/database
errors, exceptions, timeouts, malformed data, no invented slots, blocked booking,
request retention, retention failure, late aborted work, replay blocking,
cross-clinic RLS/handler denial and sensitive log-value exclusion.

## Production

The function compiled through the existing Supabase multipart Management API
workflow and deployed as `clinic-operations` v10. The migration was installed
through Supabase's documented migration endpoint after the SQL query endpoint
rejected writes as read-only. No other schema migration was replayed.

Signed synthetic production acceptance passed normal availability, retained
Open request/label, ignored caller-supplied clinic spoofing, no repeated schedule
check after failure, no booking after failure and unchanged appointment counts.
Only the exact disposable request, checked-slot and call-state IDs were removed
using administrative cleanup; existing service-role grants were not broadened.
Read-back confirmed no remaining acceptance rows. No appointment or paid Retell
call was created.

The Retell patch is reproducible without rebuilding the approved clinic graph:

```sh
python3 retell/calendar-fallback.py current-flow.json patched-flow.json
```

Retell's cloning API omitted the original explicit recording URL expiry. The final
calendar draft restores that exact existing value before publishing; no recording
policy change is included. Published v7 and unrelated drafts are preserved.
Final read-back confirms published Retell agent/flow v11, active clinic-operations v10, the new state column, unchanged recording settings and unchanged unrelated Edge functions. Final evidence is in the adjacent evidence JSON.

## Remaining acceptance

Lovable frontend publishing is separate from Git synchronization. Its integration
is not installed in this session. The header change needs that publishing step;
the retained reason already displays the requested label in the existing queue.
Authenticated browser acceptance and verification of the real telephony binding
remain pending. No paid live-call acceptance was attempted or required; no Retell
billing failure is claimed without an actual billing rejection.

## Files in the scoped release

- `package.json`
- `supabase/functions/clinic-operations/index.ts`
- `supabase/functions/_shared/calendar-fallback.ts`
- `supabase/migrations/20261004180000_calendar_unavailable.sql`
- `src/components/requests.tsx`
- `retell/calendar-fallback.py`
- `retell/master/tests/edge-isolation.test.mjs`
- `tests/calendar-fallback.test.mjs`
- `tests/test_calendar_flow.py`
- `docs/security/calendar-unavailable-deployment.md`
- `docs/security/calendar-unavailable-evidence.json`
- `docs/security/calendar-unavailable-response.json`
