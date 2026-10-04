# Failed booking fallback — local implementation, not deployed

## Existing behavior reused

The current master uses a signed Retell integration to resolve the trusted clinic,
checks call ownership, validates a clinic/call-bound checked slot and patient
identity, and creates the appointment through `voice_apply_appointment`.
Successful operations are transactionally recorded for idempotency. Existing
patient read-back consent, availability, duration, rescheduling and cancellation
rules are preserved. The Retell booking tool already had `max_retry: 0`, a
20-second tool timeout, a failure branch, and instructions not to invent success.

The `voice_requests` table and Requests/Home panels already support staff
follow-up. Current database policies and UI permission `requests.manage` restrict
requests to the same clinic's Owner and Manager. Staff role has no access under
these existing policies. No new table, migration, notification delivery or RLS
change is needed for this fallback.

## New behavior

Both the master `clinic-operations` book action and legacy `book-appointment`
creation path use `_shared/booking-fallback.ts`, after existing authentication and
validation. Main booking's creation/cache/state section has an eight-second
abortable deadline. Follow-up lookup and persistence each have a three-second
abortable deadline. Those limits cover the creation fallback section; earlier
integration, ownership and slot validation retain their existing behavior.

Success requires an object containing `success: true`,
`appointment_booked: true` and a valid UUID `appointment_id`. Existing valid
success results pass through unchanged. An error, throw, timeout, null/malformed
result or missing confirmation returns the failure contract below. No retry is
scheduled.

A terminal failure marker is the existing request row, keyed by trusted clinic
plus an opaque operation hash. It is checked before creation; replaying that
same failed operation never invokes creation, including after the request has
been marked Closed. A fresh booking with different checked-slot credentials is
a new operation; the AI may initiate it only after a new explicit patient request,
fresh availability and final consent. The main SQL RPC's existing idempotency is
unchanged. The legacy endpoint retains its existing insertion mechanism.

## Exact failure contract

Example for a saved request after timeout:

```json
{
  "success": false,
  "available": false,
  "appointment_booked": false,
  "appointment_confirmed": false,
  "appointment_id": null,
  "error_type": "booking_timeout",
  "message": "The booking could not be completed. Your appointment is NOT confirmed.",
  "follow_up_saved": true,
  "follow_up_request_id": "<saved-request-UUID>",
  "follow_up_status": "Open",
  "retry_allowed": false,
  "patient_instruction": "Your appointment is not confirmed. Your requested details were saved for clinic follow-up; clinic staff must check before confirming anything."
}
```

If saving fails, `follow_up_saved` is false, ID is null, status is `not_saved`,
and `patient_instruction` is exactly: "Your appointment is not confirmed. We
could not save the follow-up request. Please contact the clinic directly."
The AI must never say staff received an unsaved follow-up. If the whole tool
fails without a response, the flow also gives no confirmation or promise of
saved follow-up. The booking-result code node clears previous success/ID and
follow-up variables before each creation tool invocation. Failure to clear
routes to the failure node. Success additionally requires the booked flag,
backend success and appointment ID.

## Follow-up storage and display

An Open `voice_requests` message stores trusted `clinic_id`, `call_id`, patient
name and phone. Its existing `reason` field stores the requested service,
practitioner name if supplied (otherwise canonical staff ID), clinic-local
requested date/time, UTC failure timestamp, a fixed safe failure category, and
instructions to check existing appointments before confirming anything.
`request_key` contains a hash, not slot credentials or plaintext patient data.
The existing status field tracks follow-up. The Home requests panel and Requests
page show it as **Failed booking — follow-up**, with patient contact, requested
details, failure metadata and the existing **Mark handled** action. The call
identifier remains in the row's `call_id` column. Current role/clinic RLS and
status-only update restrictions remain unchanged.

## Logs

New failure logs contain only `event: booking_failed`, an allowlisted reason,
a saved/not-saved boolean and an opaque request UUID (or null). No patient
name/phone, transcript, signed slot token, request body, raw exception, API key,
workspace secret or authentication token is logged. Existing timing logs
contain fixed phase/action labels, duration and success/failure category.
Patient details are retained in the authorized request record rather than
copied into application error logs.

## Verification and limits before launch

Run `npm run test:booking-fallback` for success, errors, throws, timeout/abort,
malformed/missing confirmation, retention, replay prevention, storage failure,
actual PostgreSQL role/tenant isolation, credential-free logs, actual master
Edge handler contracts, stale-result clearing, and master/snapshot-generator
flow checks. Normal booking regression suites are `test:appointments` and
`test:appointment-conflicts`. All tests use local/synthetic data.

Nothing has been deployed or imported into Retell. A later approved rollout
must deploy the backend/frontend together, use the updated generated Retell
flow, and verify a real caller failure scenario before clinic launch. The existing
Requests schema/grants and current role policies must already be installed.
Historical Retell exports and generated drafts are not rewritten by this task;
regenerate using the updated master/acceptance builders for a later rollout.

An HTTP abort cannot prove that an already-dispatched PostgreSQL operation did
not commit. A lost/malformed response or timeout can therefore accompany an
appointment that actually exists. Patient wording deliberately says NOT
confirmed. Staff must reconcile the call and calendar before scheduling; no
automatic retry or delayed retry is added. If Supabase is entirely unavailable,
follow-up persistence cannot be guaranteed; the response directs the patient
to contact the clinic. A process termination or outer Retell/network timeout
before the handler saves a request can likewise prevent retention. Retell's
20-second timeout includes pre-creation work outside the fallback deadline;
real deployment latency and failure routing require live acceptance testing.
