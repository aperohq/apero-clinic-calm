# Resolution of the seven v17 CRITICAL/HIGH findings

Final published version: **19**. Original audit: [v17 findings](../flow-audit-v17/findings.md).
Candidate, builder and executable offline evidence:
[remediation-v19](../remediation-v19/). Internal `r18` node IDs are stable identifiers
from this remediation; the final deployed version is 19.

## C01 — Existing-appointment target/approval binding: RESOLVED

`node_r18_lookup_snapshot` stores current successful lookup results, current lookup
cycle and the existing patient name/contact. `node_r18_existing_choice` extracts
only a local ordinal/action, never a target ID. `node_r18_existing_select` copies
the exact selected backend row, canonical ID, service, practitioner and original
date/time into stored target state. Invalid/ambiguous choices clear the target.

`node_r18_existing_readback` produces an exact cancellation/reschedule tuple.
`node_r18_existing_approval` captures approval only for that just-read tuple.
`node_r18_existing_entry` checks target membership, patient association, action,
current approval and tuple equality before preparing an attempt.

`verify_selected_appointment` is an additional bound **lookup**, using the same
existing name/contact, not a new identity feature. The flow calls it immediately
before mutation. `node_r18_existing_fresh_guard` compares the current selected row
with the reviewed row; changed/removed targets clear selection/approval and return
to current selection or existing not-found handling. A valid recheck stamps the
current prepared attempt. Each English/Arabic mutation entry gate requires that
stamp plus the unchanged target/approval tuple.

Both mutation schemas const-bind appointment_id to `existing_selected_id`, patient
fields to the stored lookup association, and replacement fields to selected current
slots. A newly model-generated `appointment_id` cannot substitute B for reviewed A.
Reselection clears the prior readback/consent/attempt. Completion/abandonment clears
target/action/attempt state. Existing backend ownership/status checks remain intact.

Evidence: `selectExisting`, `selectedTargetValid`, `existingTuple`,
`existingReadback`, `existingEntry`, `revalidateExistingTarget` in runtime/common;
tests named `C1 ... selected target`, `... reselecting B`, `... stale/removed ...`,
and `operation-kind mismatch`. Staleness fixtures include moved date, removed row,
changed service and changed practitioner for cancellation and reschedule.

No OTP, DOB, PIN, SMS or additional patient-identification factor was introduced.

## C02 — Stale/malformed cancellation/reschedule success: RESOLVED

Every operation preparation and every actual English/Arabic tool entry clears both
success flags, both result IDs, both error fields, operation-specific result flags,
returned service/staff/start fields, verified-result flag and current receipt state.
An omitted response field therefore cannot borrow a prior result value.

`node_r18_existing_result` is the only route to cancellation/reschedule success.
`existingResult` requires a current received non-system response, prepared attempt,
current target-freshness stamp, exact request tuple, success=true, the correct
operation-specific flag, and a UUID result ID equal to the selected target. A
reschedule additionally requires returned service/staff/start matching the original
service/staff and selected replacement token. Incorrect or incomplete results use
the existing operation failure nodes. Actual transport/system failure keeps the
existing downtime path; the received-response predicate excludes system-unavailable.

Evidence: 32 English/Arabic cancel/reschedule result fixtures cover previous
success/current failure, previous ID/current success-only, explicit failure,
timeout, malformed response, valid success, wrong target and wrong operation.
Only valid current success passes. Cross-feature success fixtures also reject
booking-as-cancel and cancel-as-reschedule responses.

## C03 — Uncertain booking must not re-create: RESOLVED

`bookingEntry` sets `booking_reconciliation_required=true` **before** invoking
creation, bound to the current attempt tuple/cycle. The only result writer that
can release it is `node_r18_booking_result`, after current receipt, success,
booked flag, UUID and attempt-tuple verification. Failure, no response, malformed
result or uncertainty cannot release it.

The lock is never reset by new booking reset, identity correction, cancellation,
reschedule, shared task changes or the existing-operation boundary. A new-booking
gate and both creation entry variants enforce it. Only these two reservation nodes
and the verified-success result node can write it; no model extractor can.

The existing backend currently emits no automatic retry permission on failure.
Accordingly, the Failed Booking node has no fresh-check/create retry exit after an
attempt. It exposes backend no-retry/follow-up state, says **not confirmed**, reuses
already-saved follow-up and requires staff reconciliation. It does not claim a
timed-out remote write definitively failed. A different slot/new operation key is
blocked while the same call has an unresolved creation. No cross-call product or
new backend retry policy was added.

Evidence: `C3 reserve before creation`, `malformed/failed booking cannot unlock`,
`transport timeout cannot unlock`, different-slot and reset/operation-switch probes;
valid current success still unlocks and confirms. Creation IDs/result fields are
also cleared before both language variants. Existing backend idempotency and
durable Failed Booking retention remain unchanged.

## H01 — Multi-slot matcher/provenance: RESOLVED

`validateSlots` uses **i** as the shared current availability-check UUID and **q**
as a distinct per-slot row UUID. It validates call, practitioner/service, expiry,
unique row IDs and consistent shared check. Successful current availability stores
the exact returned array plus query signature/check. `matchBookingSlot` accepts
only that snapshot/check/signature and copies the exact returned token.

The same-request correction guard also compares i, not q. Invalid/ambiguous choices
do not construct a token. Explicit ordinals and exact returned practitioner names
can distinguish same-time options. Reschedule uses the same provenance validation
with fixed original service/practitioner.

Evidence: 1/2/5 returned slots; first/middle/last; #2/#3/last ordinals; same-time
different-practitioner choice; invented time/ordinal; mixed-check, expired and old
request slots; same-query multi-slot clarification. All pass offline.

## H02 — Name/phone correction exits: RESOLVED

Explicit patient/contact correction edges cover booking name, service, practitioner,
contact, date/time, offer, slot clarification, correction and final review stages.
`node_r18_identity_prepare` clears prior edit candidates. Capture extracts only
explicit new patient name/contact and current evidence.

`identityCorrection` validates the changes and preserves unaffected fields. A
selected slot returns through patient/readback validation with consent erased;
an availability offer returns to the existing offer without a new check; earlier
intake returns to the next missing-field router. Only an explicitly simultaneous
scheduling change uses scheduling invalidation. Invalid correction has a dedicated
clarification exit. Unresolved booking attempts remain locked.

Evidence: name-only, phone-only, both; exact unchanged service/practitioner/slot/check;
old consent rejection; revised final approval/creation arguments; intake/search
exits; cleared stale edit candidates; fully known intake returns directly to time.

## H03 — Practitioner-state/creation-ID guard: RESOLVED

The actual backend accepts any-qualified availability as **mode `any` with no
practitioner filter**; it rejects a fabricated practitioner-ID sentinel. The flow
therefore resolves `practitioner_scope="any"` explicitly, validates qualified
current practitioners and requires intentionally empty string filters for that
mode. Null/undefined/invalid filters are rejected. Specific mode requires a valid
qualified canonical UUID.

After slot selection, both booking guards and both English/Arabic creation entry
variants independently require a **nonempty concrete UUID**, matched to the current
returned slot. Any preference is not an exception at creation. All required
creation fields are validated, including phone/date/time/slot/current consent.

Evidence: backend-supported any scope; rejected null/undefined/fake sentinel;
specific-practitioner complete success; empty/null/undefined practitioner IDs;
all seven required creation fields individually missing/empty/null for both language
variants. The deployed backend contract and behavior were not expanded.

## H04 — Date/time-only reschedule scope: RESOLVED

Reschedule detail/offer/no-slot/final prompts and correction conditions now describe
**date/time-only** moves. The availability and mutation tool schemas const-bind
original appointment ID, original service and original staff ID. Replacement
capture extracts only date/time/window/search inputs plus unsupported-change flags.

`rescheduleSearch` rejects explicit service/practitioner changes. All relevant
reschedule stages and interrupted-reschedule FAQ routing have an unsupported-scope
exit: explain the limitation, preserve the original appointment, offer existing
staff assistance or allow a date/time-only continuation. They never silently cancel
or create a substitute appointment. The mutation validator verifies returned
service/staff remain the originals.

Evidence: supported date/time move through returned replacement/readback/approval
and coherent success; both unsupported-change flags; immutable original service/
staff bindings even when unrelated model variables differ. No backend scheduling
functionality was changed.

## State boundaries and focused static re-audit

New existing-operation entry clears selected target, slots/check provenance,
operation/attempt IDs, approval/readback, booking/cancel/reschedule result IDs and
success/error state, without erasing the already-required patient name/contact or
the unresolved-booking lock. New booking reset clears existing-operation state;
selection/reselection and completion/abandonment clear their dependent state.
Action is fixed per tool, with a separate guarded operation_kind/action tuple.

`static-audit.mjs` passes for 238 nodes, 602 explicit edges and 125 compiled code
nodes. Every mutation path requires its hard entry guards; every success path
requires its current-result validator. Existing mutations also require fresh target
lookup/revalidation. Model extractors cannot write trusted target IDs, current
availability provenance or the booking lock. All nodes are structurally reachable;
all edge IDs/targets/tool references are valid.

Phase-aware data invariants accompany the structural audit: identity corrections
may legitimately skip already-completed service/search stages, but cannot invent
the retained current slot/check/selection state. Final creation entry validates
every required field against current snapshot, token, cycle and exact consent.
This is not a claim to prove speech recognition or model interpretation of consent.

## Regression and publication evidence

- New remediation suite: **76 passed, 0 failed**.
- Existing regressions: booking fallback 15; real handler/clinic isolation 32;
  calendar fallback 17; unknown answer 10; human escalation 16; call transfer 18;
  system downtime 12; original intake fixtures 17. **137 passed, 0 failed**.
- Total: **213 passing tests**. Retell update-schema validation: PASS.
- Specific fallback nodes/tools were compared against v17. Backend code and
  database were not changed. Agent voice, webhook, recording-security and signed
  URL expiration settings were compared with v17 and preserved.
- Final published v19 nodes/tools/global prompt/defaults match the tested candidate
  exactly. Metadata and counts are in `remediation-v19/release.json`.

**Remaining CRITICAL/HIGH findings among these seven: none identified.**
The original medium/low findings remain outside this focused remediation unless
directly required by one of these fixes.

**SAFE FOR MANUAL ACCEPTANCE TEST**

NO LIVE CALLS PERFORMED
NO RETELL TRY-A-CALL USED
NO AI SIMULATED CONVERSATIONS PERFORMED
NO MANUAL CALLS PERFORMED
NO PAID TESTING PERFORMED
