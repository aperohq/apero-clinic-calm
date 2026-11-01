# Focused remediation release — published v19

**SAFE FOR MANUAL ACCEPTANCE TEST**

Published agent `agent_b84b2766efeb85afc809147d7a` and flow
`conversation_flow_43f53e5e8531` are version **19**. Full published configuration
read-back matches the tested candidate. The original published v17 baseline matched
`ce94de8`. The original [v17 audit](../flow-audit-v17/README.md) is preserved unchanged.

All **3 CRITICAL and 4 HIGH findings are RESOLVED**. See
[findings-resolution.md](findings-resolution.md) for exact code/node evidence and
test coverage. This is a focused resolution audit, not a claim that the v17 medium
and low findings were comprehensively remediated.

## Final behavior

- Booking retains name → missing service → practitioner preference → confirmed
  contact → date/time → real availability → returned slot → final approval →
  guarded creation → verified success. Valid known fields remain skippable.
- Current slots use shared token `i` and distinct slot-row `q`, with a stored latest
  response snapshot. Any actual returned choice can be matched by local time/date,
  explicit ordinal, or returned practitioner name when times repeat.
- Name/phone-only edits keep service/practitioner/availability/selected slot, update
  patient fields, erase prior consent and return to the appropriate stage. A
  corrected selected tuple requires fresh final approval.
- Any-practitioner availability uses the backend's actual scope sentinel:
  `practitioner_mode="any"`, with an explicitly empty practitioner filter. It never
  sends a fabricated ID sentinel. Creation requires a concrete UUID from the
  selected returned slot, including when preference was any.
- Existing appointment selection stores the exact row/ID from current lookup
  results. Mutations use bound stored arguments and exact action-specific approval
  tuples. A fresh lookup immediately before mutation detects an observed changed
  or removed target and returns to selection; the existing backend still checks
  current ownership/status and performs atomic mutation.
- Reschedule is **date/time only**: original service and practitioner are fixed.
  Different service/practitioner requests use existing staff assistance. No backend
  scheduling functionality was expanded.
- Every attempted booking reserves a call-level reconciliation lock. Only verified
  current success releases it. Failure, malformed result, timeout or uncertainty
  retains it across task changes/resets, blocking another creation with any slot.
  Current backend failure policy never explicitly permits an automatic retry, so
  none is offered. Existing Failed Booking/staff reconciliation handles the result.

No identity-verification feature was added. Existing patient name/contact
identification is reused; there is no OTP, DOB, PIN, SMS or additional factor.
Backend code, database schema/data, transfer activation, environment settings and
unrelated application files were not changed by this remediation.

## Validation

| Check | Result |
|---|---:|
| New generated-code/contract/graph fixtures | 76 passed |
| Existing targeted fallback/security regressions | 120 passed |
| Original intake fixture regression | 17 passed |
| Total | **213 passed, 0 failed** |
| Final graph | 238 nodes; 602 explicit transitions |
| Code nodes compiled / reachable nodes | 125 / 238 |
| Retell update-schema validation | PASS |
| Published flow read-back vs candidate | Exact match |
| Agent voice/security/webhook settings vs v17 | Preserved |

The original 17 intake fixtures target the preserved v17 artifact; they are counted
as baseline regressions, not proof of the new matcher. The 76 new fixtures execute
the actual generated v19 code, including realistic multi-slot payloads, all required
creation fields, target reselection/freshness and both mutation language variants.

Offline commands:

```sh
node retell/remediation-v19/build.mjs
node retell/remediation-v19/test.mjs
node retell/remediation-v19/static-audit.mjs
```

These scripts have no network or agent SDK dependency. Build patches the pinned
fresh v17 snapshot locally; it is not a deployment command. For a future release,
inspect the latest published flow before carrying this patch forward.

The static proof combines unavoidable entry/result validators from all explicit
and global entry roots, restricted producers of trusted target/provenance/latch
state, const-bound mutation arguments, and deterministic code fixtures. Identity
correction intentionally skips completed scheduling stages; a raw graph walk that
ignores phase predicates is not treated as a feasible runtime conversation.
Natural-language understanding/ASR is not proved by these offline tests. The
reconciliation lock belongs to the current call; no new cross-call identity or
reconciliation product was introduced. Existing backend atomic checks remain the
authority if availability/status changes between reads and mutation.

## Exact user-performed manual scenarios

Perform these yourself after reviewing this release. None was executed by the
agent performing this task. Final approval creates/changes real appointments;
use clinic-approved test patient/contact/appointments and normal cleanup.

1. **Normal multi-slot booking, English then Arabic:** “I want to book an
   appointment.” Expect name first. Give the approved test patient name, request
   Dental Cleaning, accept any qualified practitioner, provide contact, then ask
   for the next available date/time. Choose the **second offered option**. Check
   exact readback and explicitly approve. Confirmation must follow verified success.
2. **Known fields:** start with “I’m Ahmed and I want a cleaning with Dr. Ahmed
   Qandil tomorrow afternoon; my contact is [approved test number].” Missing fields
   only should be asked; no repeated name/service/contact questions.
3. **Identity correction:** after a slot is selected and read back, correct name
   only, phone only, then both in separate authorized scenarios. Service/doctor/slot
   must remain unchanged. The corrected tuple must be read back and approved anew.
4. **Existing target binding:** use two authorized appointments for one test
   patient. Select A for cancellation, then say “Actually, the other appointment.”
   It must return to selection and require new approval. Declining must not cancel.
   Only approve a destructive mutation if clinic-authorized.
5. **Date/time-only reschedule:** select an approved existing appointment, choose
   a returned replacement time and approve. Original service/practitioner must stay
   fixed. Separately request another practitioner/service: expect explanation and
   staff assistance, with no silent cancellation/new booking or unsupported change.
6. **Information/regression:** ask opening hours without booking; ask an unknown
   fact and decline/accept follow-up; request staff while transfer remains disabled.
   These must retain their existing specific behavior.

Timeout/malformed/stale-result/uncertain-commit tests were performed offline.
Do not deliberately create uncertain real operations to test failure handling.

NO LIVE CALLS PERFORMED
NO RETELL TRY-A-CALL USED
NO AI SIMULATED CONVERSATIONS PERFORMED
NO MANUAL CALLS PERFORMED
NO PAID TESTING PERFORMED
