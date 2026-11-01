# Fresh booking initialization — published v21

Agent `agent_b84b2766efeb85afc809147d7a`, flow
`conversation_flow_43f53e5e8531`. Published baseline verified as v19; the
independent draft v20 was left untouched. v21 was created from published v19.

## Exact observed cause

Read-only inspection of two **existing** web-call traces (versions 13 and 20)
showed `node_reset_prepare` (**Clear Active Booking Cycle**) succeeded, followed
by `node_reset_verify` (**Verify Fresh Booking State**) succeeding. The failure
was subsequently `node_guard_search` (**Verify Fresh Availability Inputs**):

`reset_error=date_missing`, `reset_ready=false`
→ its default `edge_node_guard_search_failure`
→ `node_reset_failed` (**Fresh Booking Reset Failed**).

Thus the fallback's name misidentified a missing scheduling field as an
initialization failure. A retry in the v13 trace then encountered
`fresh_request_present=false` in **Capture New Request Only** and returned to
the same fallback. Published v19 contained the same missing-date failure branch.
These observations do not establish how the model failed to extract a date;
the deterministic defect is the guard's treatment/routing of missing input.
No new call, agent execution, recording access, or conversational test occurred.

Caller metadata was **not** the cause in these traces: first-cycle proof and
initialization both succeeded. Separately, the old proof required `call_id` and
exact default values. Failing that proof forced an external invalidate action,
even with nothing to clear. `clinic-operations`' invalidate action requires a
trusted call ID and writes `voice_call_state.current_check_id=null`; its receipt
requires `success=true` plus `availability_invalidated=true`. This unnecessary
dependency has been removed from fresh initialization only. Correction and
reschedule invalidation and backend call/clinic security checks are unchanged.

## Focused changes

Seven existing nodes changed; none added/deleted/moved:

- `node_reset_prepare`: canonical local operation-state clearing, absent/null/
  empty history normalized to `[]`; preserve completed history and call context.
  Unresolved booking latch routes to Failed Booking **before clearing anything**.
  Map a current-cycle clear-set snapshot and record actual code execution status.
- `node_reset_verify`: independently verify mapped runtime fields against that
  initializer-owned snapshot, execution success, current cycle, unchanged history/
  caller/language context, and no reconciliation latch. No deletion acknowledgment
  or model-generated intent-enrichment flag required. Success enters Name capture.
- `node_fresh_request`: retain latest explicit request enrichment without making
  a missing enrichment/intent flag a reset failure. Old summary is always cleared.
- `node_reset_language_gate`, `node_reset_language_capture`: preserve/establish
  language and go directly to local verification; no external reset prerequisite.
- `node_guard_search`: missing date/search preference returns to Date/Time;
  missing required intake returns to the existing intake gate. Neither invalidates
  a verified cycle; actual broken-cycle state still fails closed.
- `node_guard_search_clear_result`: clear old error as well as old stage result,
  preventing a failed code execution from reusing a stale recovery decision.

Normal path:

Booking intent → existing no-retry gate → Clear Active Booking Cycle → current
request enrichment → preserve language → Verify Fresh Booking State → Name capture
→ Name if missing. Subsequent Name → Service → Practitioner → Contact → Date/Time
intake and known-field handling are unchanged.

`Fresh Booking Reset Failed` remains reachable for actual code execution failure,
corrupt nonempty completed history, failed mapped-state/cycle/context verification,
or unrecoverable language initialization. Other pre-existing integrity guard
fallbacks remain unchanged. There is **no reset backend operation** on this path
whose outage can prevent an otherwise clean booking from starting.

## Cleared/preserved state

The exact clear-set is generated in `build.mjs` from the previous initializer plus
an explicit v19 operation-state allowlist. It includes action; patient inputs;
service/resolver/qualification/practitioner state; scheduling fields; slots and
availability provenance; selection/patient/consent tuples; booking operation,
result and follow-up flags/IDs; cancellation/reschedule selections, targets,
approvals, attempts, fresh-lookup and result state; and pending corrections.

Preserved: language, clinic identity/configuration, call identity, trusted caller
context, completed history, and **booking_reconciliation_required**. An unresolved
operation preserves its original reconciliation arguments and cannot obtain a
new cycle. No identity-verification feature or backend functionality was added.
Missing call/phone metadata is allowed for initialization; later operational
tools still enforce the original trusted call/clinic contracts.

`failure-incoming.json` inventories all 54 pre-fix incoming reset-failure edges,
including source IDs/names, conditions, source reads and default behavior. All
are fallback/Else edges, selected when their source's normal routes do not match.

## Offline evidence

- 14 focused deterministic fixtures pass: absent/null state, completed/safely
  failed state, unresolved latch, stale mutation targets, absent caller metadata,
  actual failed-code/corrupt-history fallback, stale field/cycle detection,
  generic retry, preserved request enrichment/language, observed missing-date
  recovery, missing intake, and stale routing-result prevention.
- All 76 existing v19 tests pass **against the v21 candidate**, including
  unavoidable creation/consent/result guards, returned-slot provenance, existing
  target binding, malformed results and uncertain/no-retry duplicate prevention.
- Existing backend fallback suites pass: booking 15, calendar 17, unknown answer
  10, human escalation 16, transfer 18, system downtime 12. All use local fixtures/
  databases, with no production operations.
- Total: **178 passed, 0 failed**. All graph references/code compile; all 125 code
  nodes validate against the current Retell code-node schema.
- Diff assertion: every other node, tool, global prompt and configuration setting
  is identical to baseline. Published v21 read-back matches the candidate's nodes
  after normalizing object-key order; agent voice/security/webhook settings match.

Reproduce locally (no API or conversational execution):

```sh
node retell/fresh-booking-reset/build.mjs
node retell/fresh-booking-reset/test.mjs
node retell/fresh-booking-reset/regression.mjs
```

`candidate.json` is the deterministic configuration build, retaining the input
export's metadata; actual server publication/version is recorded in `release.json`.
Retell initially rejected the larger draft update at its storage-size limit; the
final reset stores its clear-set once instead of duplicating it across two code
nodes. The accepted smaller configuration passed the tests again before publication.

## User's manual acceptance

Select **v21** in Try a Call yourself. Start “I want to book an appointment.”
Expect Name first. Complete the existing intake. Give an ambiguous date/time and
then clarify it: expect a scheduling clarification, never Fresh Booking Reset
Failed. Separately, after a confirmed booking, request another booking: expect
fresh intake without previous patient/service/slot/consent reuse. Do not provoke
uncertain real operations; that lock was checked offline.

NO LIVE CALLS
NO TRY A CALL
NO SIMULATED CONVERSATIONS
NO PAID TESTING
