# Name-first booking intake release

Published agent `agent_b84b2766efeb85afc809147d7a` and flow
`conversation_flow_43f53e5e8531`: **version 17**, based on a fresh management-API
capture of published version 16. Publication and complete flow read-back verified.
Agent voice, recording security, signed URL expiration, webhook and analysis
settings were compared against version 16 and preserved.

## Cause and sequence

Version 16 explicitly instructed “Service first” in the global prompt. Both fresh
booking entry routes entered `node_service`; `node_guard_slot` sent the patient to
`node_patient` only after availability and slot selection. This was structural.

Old: greeting → booking intent → service resolution → doctor preference → date/time
→ availability → slot choice → patient name/contact → final consent → creation.

New: greeting → booking intent → patient name → missing service/resolution → missing
qualified practitioner preference → missing confirmed patient contact → preferred
date/time → real availability → returned slot choice → exact tuple readback/consent
→ guarded creation → verified success confirmation. Already supplied current-cycle
details are retained; sole qualified practitioners need no preference question.
“Any qualified” is supported and encoded as `any`, as required by the live backend.
Standalone FAQ callers retain their original route.

## Actual deployed requirements

The published tools call **clinic-operations**, deployed function version 17, not
the legacy standalone book-appointment/check-availability functions.

Creation requires `action=book`, `slot_id`, `client_name`, `client_phone`,
`service_name`, `practitioner_id`, `appointment_date`, `appointment_time`.
The backend verifies the signed current-call slot token, exact tuple, current
availability check, valid patient/contact and atomic booking result. Caller name
and caller phone are optional separate fields. No service ID or patient ID input
exists in this tool schema.

Availability requires service, practitioner mode (`specific`/`any`), search mode,
a date unless earliest search, and practitioner ID/name for a specific preference.
The existing extractor uses `earliest`/`exact`/`window`; the deployed backend treats
non-earliest as a dated search and validates optional exact time/window values.

* Trusted/automatic: signed call identity, verified clinic integration, clinic
  timezone; qualified IDs from resolver and slot tuple/token from availability.
* Before date/time: patient name, resolved service, qualified practitioner
  preference/sole practitioner, and established usable patient phone. This clinic
  uses +965 and eight local digits, verified by a read-only integration query.
* Time/selection: preferred date/time or earliest request; selected returned slot
  token, canonical practitioner ID and exact date/time; final tuple consent.

There is no deployed trusted automatic current-patient phone mapping. Existing
product behavior requires explicit patient contact association; arbitrary metadata
and old patient contact are never used as current patient defaults.

## Architecture and directly related cleanup

18 nodes added: name extraction/question/guard, pre-time practitioner/contact
extraction and missing-field router, five tool-entry guards, and seven guard result
clearers. Existing service/date entry edges, patient node and selected-slot edge
were rewired. Search/booking guards enforce intake; patient verification and final
consent remain after selection. Every new guard fails closed and clears its prior
acknowledgement before execution. Missing code results cannot reuse a previous pass.

Removed contradictory service-first guidance and added natural Arabic/English name
and service questions. Corrected `any_qualified` versus deployed `any`. Scheduling
corrections retain patient identity/contact while clearing slot/readback/consent;
an any-practitioner selected ID is cleared before a fresh search. Booking success
now requires explicit success, explicit booked flag and a nonempty appointment ID.

Live Arabic service aliases were corrupted. The prepared database repair could not
run: the connector is read-only and the separate management token returned 401.
No database data changed. Instead, the guarded resolver input normalizes 14 exact
Arabic aliases already approved in db/05_voice_integrations.sql to the eight
existing service names. The real resolver still validates each service against
current clinic staff. Unsupported and ambiguous requests retain clarification.
The former broad substring service rewrites were removed.

## Validation

Run only:

```sh
python3 retell/booking-intake/build.py
node retell/booking-intake/test.mjs
```

17 intake/graph/code/schema-binding fixtures cover all 12 requested cases, Arabic
alias mapping, ambiguous/unsupported service handling, missing acknowledgements,
sole practitioner, no preference, stale cycle/contact, correction retention,
exact consent and missing-field rejection. All passed. Every code node compiles;
edge destinations and IDs are valid; service/date/tool guard bypasses are checked.
The current Retell update schema also validated the candidate with zero errors.
Builder generation is local only; it always patches the pinned fresh v16 capture.
For a later release, capture/review the current published flow before rebasing
this narrowly scoped patch; do not overwrite newer published safety changes.

120 existing offline regression tests also passed: booking fallback 15, real
handler/clinic isolation 32, calendar fallback 17, unknown answer 10, human
escalation 16, call transfer 18, system downtime 12. Total: **137 passing tests**.
Specific fallback nodes/tools and failure routing were compared with the actual
published baseline. New-booking tool-entry wrappers and success guards are the
intentional changes; no backend handler or unrelated application file was edited.

These fixtures execute deterministic code and evaluate graph conditions. They do
not run the agent or prove probabilistic speech recognition/extraction quality.
Manual acceptance is reserved for the user.

## User's manual Try a Call acceptance

Use published version 17. Say “I want to book an appointment.” Expect the first
intake question to ask the patient's name. Answer with your test patient's name;
then request Dental Cleaning, choose any qualified practitioner, and provide your
usable contact number if needed. Date/time must come after those fields. Request
the next available appointment, choose only a returned offered time, and explicitly
approve the final patient/service/practitioner/date/time readback. Confirmation
must follow verified creation. This final affirmative step creates a real booking;
use a clinic-approved test patient/contact and remove it through normal clinic
operations after acceptance.

Additional starts: “I want a cleaning” must ask name next and retain cleaning;
“I'm Ahmed and I want a cleaning” must skip name/service; include practitioner,
contact and a preferred date/time together to check retention. Ask opening hours
alone to confirm no booking intake is forced. Repeat the normal path in Arabic.

NO LIVE CALLS PERFORMED. NO RETELL TRY-A-CALL USED.
NO AI SIMULATED CONVERSATIONS PERFORMED. NO MANUAL CALLS PERFORMED.
NO PAID TESTING PERFORMED.
