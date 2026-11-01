# Apero receptionist — full published v17 read-only flow audit

**AUDIT RESULT: FIXES REQUIRED BEFORE MANUAL ACCEPTANCE TEST**

This inspection found a definite normal-booking blocker and conditional operational-safety gaps. No fix was applied. The prior release's 137 passing offline checks did not cover the real multi-slot matcher chain and do not establish that v17 is safe.

## Sources and scope

- Current published agent: `agent_b84b2766efeb85afc809147d7a`, **version 17**, published.
- Attached published flow: `conversation_flow_43f53e5e8531`, **version 17**, published.
- Fresh management-API read-back exactly matches commit `ce94de8` for nodes, tools, global prompt and default dynamic variables. No published-version discrepancy found.
- Active backend: deployed `clinic-operations`, function version 17; actual deployed handler and all bundled reliability/identity helpers inspected. Legacy standalone booking functions are not the published tool targets.
- Read-only database inspection: definitions of `voice_apply_appointment`, `voice_claim_transfer`, `voice_record_transfer`; clinic transfer activation/destination presence, integration phone/slot settings, active staff/service assignments and aggregate service-alias configuration. No operational patient/appointment records or recordings were read.
- Current transfer settings: disabled; no configured fallback destination. No activation, mutation, environment change, deployment, publication, commit or push.
- Existing intake fixtures and older untracked v7 candidates were inspected as evidence of coverage gaps, not executed as conversations or treated as published configuration.
- The workspace already contained many unrelated modifications. Only these four documentation files were created.

Read-back and analysis date: 2026-11-01 UTC. API configuration/schema reads and SQL metadata SELECTs were the only remote operations. No operational tool endpoint, voice SDK, Retell playground, simulation or call-creation endpoint was invoked.

## Audit documents

- [Complete node, transition, variable and tool inventory](node-inventory.md): all 180 nodes, 438 explicit transitions with exact predicates/annotations, 136 declared/referenced variable entries, 16 tool contracts and 320 cyclic-edge witnesses.
- [Complete path catalog](path-catalog.md): 131 named meaningful families, exact helper expansion, complete 443-rule graph grammar and every operational result branch.
- [Findings and booking guarantee checklist](findings.md): evidence, severity, impact, qualifications and recommendations only.

## Counts and graph interpretation

| Measure | Result |
|---|---:|
| Nodes | 180 |
| Conversation / function / code / extraction / native transfer / end | 64 / 26 / 76 / 12 / 1 / 1 |
| Explicit transitions, including default/always/native failure edges | 438 |
| Global activation rules / dynamic FAQ return rules | 4 / 1 |
| Configured transition rules including implicit rules | 443 |
| Reachable via greeting and explicit edges | 176 |
| Reachable including legitimate global roots | 180 |
| Structurally unreachable nodes | 0 |
| Missing targets / orphan tools / undefined tool references | 0 / 0 / 0 |
| Declared custom tools / operational function nodes | 16 / 26 |
| Named meaningful path families | 131 |
| Nontrivial strongly connected components | 1 (162 nodes) |
| Edges participating in any explicit graph cycle | 320 |
| Reachable nonterminal nodes with literally no outgoing edge | 0 |
| Findings: CRITICAL / HIGH / MEDIUM / LOW / INFO | 3 / 4 / 13 / 3 / 8 |

The four globally activated nodes are `node_global_faq`, `node_global_urgent`, `node_global_human`, and `node_unknown_follow_up`. They are not orphaned just because the greeting's explicit-edge traversal does not visit them. Successful native transfer is an external provider handoff, not a missing success destination. Global interrupts are conditional implicit rules, not unconditional edges from every node.

Structural reachability does not prove that input/data conditions enable a particular walk. Cycles create infinitely many possible repeated walks; the report therefore gives a complete transition grammar and cyclic-edge coverage, plus named meaningful families. It does not falsely claim to enumerate every unbounded conversational sequence.

## Path counts

| Category | Named families | Coverage |
|---|---:|---|
| Booking/availability inquiry B | 32 | Intake/skips/corrections/selection/consent/new cycles |
| Cancellation C | 9 | Identity/selection/approval/rejection/failure/fault targets |
| Reschedule R | 15 | Original identification/replacement/checks/approval/failures |
| FAQ/information F | 12 | Hours/location/service/practitioner/pricing/insurance/parking and task switches |
| Unknown-answer U | 6 | Explicit opt-in, optional contact, withdrawal, saved/unsaved/outage |
| Human escalation H | 9 | Actual supported categories and retention outcomes |
| Transfer T | 15 | Config/hours/attempt/provider/fallback/prior-state outcomes |
| Domain/failure fallback D | 15 | Calendar/booking/input/token/cleanup outcomes |
| System failure S | 8 | Every operation family and terminal downtime |
| General/requests/loops G | 10 | Message/callback/urgent/shared-router/new-cycle behavior |

These are families, not a claim of 131 pairwise disjoint finite walks. English/Arabic/silent variants and every outgoing utility/failure edge are expanded separately in the inventories.

## Every critical finding

1. **C01 — Cancellation/reschedule mutation IDs and caller approval are not bound to stored selected/read-back state.** Same-patient appointment B can satisfy backend ownership checks even if A was selected/read back; mutation arguments are model-generated. This is a conditional model-error safety gap, not an observed incorrect mutation.
2. **C02 — Cancellation/reschedule malformed-success false confirmation.** Preparation clears flags but leaves old result IDs; success checks only success=true and ID exists. A current nonempty malformed success can combine with an old ID. Operation-specific flags/current selected target are not validated. Deterministic condition fixtures confirm the gap; deployed RPC normally emits complete valid results.
3. **C03 — Uncertain failed booking can be retried under a new slot/key.** Backend no-retry/uncertainty information is not mapped; the failure graph offers a fresh check and write. A timeout does not prove rollback; changing the operation key defeats identical-operation idempotency for a second appointment at a different slot. No actual duplicate was created.

## Every high finding

1. **H01 — Wrong token field blocks normal multi-slot booking.** `node_match_slot` and `node_correction_guard` compare unique per-slot q across results; backend uses shared i. One valid slot matches; two valid rows from one check block/reset or cause unnecessary refresh. Definite code defect.
2. **H02 — Name/phone-only corrections have no complete route.** Final correction invalidates scheduling but preserves identity; Collect Correction has no patient-only exit. Offer/correction clarification also exclude patient details without an alternative branch.
3. **H03 — Entry code does not independently enforce nonempty practitioner_id.** An any-preference consistent fixture with empty ID passes both booking guards. Normal valid-slot provenance/backend validation supply/reject that field, so this is not proof of a normal persisted missing-ID appointment.
4. **H04 — Reschedule doctor/service scope contradicts linked availability.** Prompts allow changes, while a properly linked availability request requires the original service/staff; omitting the optional original ID changes behavior and loses linked validation.

## Medium/low summary, dead ends and obsolete nodes

Thirteen medium findings cover semantic known-field retention, loss of interrupted task after unknown follow-up, unbound name-value stamp, overlapping predicates/error precedence, unmapped failed-booking retention, stale correction results, mandatory personal data for availability-only inquiries, incomplete read-only appointment inquiry, wrong calendar fallback at mutation entry, missing polite-stop/correction exits, unsupported-service looping, urgent/global terminal-path priority and Arabic alias compensation limited to new-booking resolution.

Three low findings cover duplicate helper display names, mixed search-mode vocabulary and insufficient previous fixture coverage. No node/tool was proved orphaned, obsolete or safely deletable. English/Arabic/silent variants and receipt/acknowledgement wrappers are intentional structurally reachable duplicates. Existing v16 utility nodes remain active, not dead artifacts. With current transfer disabled and no destination, the allowed native-transfer branch is operationally gated off despite structural reachability.

There are no zero-edge nonterminal nodes, but valid name/contact corrections, information-only existing-appointment completion and polite declines can have no matching local transition. This means possible waiting/reprompting/stranding, not proof the platform terminates the call. The complete node inventory identifies every node without a default.

## Variable lifecycle and cross-feature risks

New-booking reset clears scheduling, patient, selection, consent and result state; correction intentionally keeps identity while clearing slot/readback/consent. New name-cycle fields are not in the old reset map, but old stamps fail the new-cycle equality check. The stamp is not bound to the name value, and later patient extractors may replace that value. Some stale availability/resolve/selected-doctor fields survive corrections. Cancellation/reschedule target IDs and approval are not persisted with comparable provenance. Their old result IDs survive per-attempt preparation.

No direct unconditional FAQ/unknown/human → creation/success edge was found. Shared Anything Else and FAQ exits permit explicit task changes; complete new-booking guards remain structurally on all creation paths. Existing mutation free arguments and shared context are the major cross-selection risks. No explicit reschedule → new-booking mutation edge exists; the actual reschedule tool performs an atomic update. Calendar/downtime paths are locally terminal; global urgent interruption can escape calendar handling structurally, with the backend calendar latch usually still blocking creation.

Prompt/flow contradictions include name/contact correction support without routing, preserved informational task without a return edge after unknown follow-up, no-retry booking helper output versus retry offer, allowed reschedule doctor/service changes versus linked backend restrictions, terminal-calendar policy versus generic mutation failure routing, and FAQ coverage missing the new name node.

## Booking guarantees and tool-contract conclusion

**Every explicit new-booking route** to either creation-language variant is structurally dominated by reset verification, name gate, complete non-time router, service resolver, search guard, slot matcher, membership guard, patient guard, final readback, consent extraction and exact-tuple booking guard. Date/time has only one explicit incoming gate, requiring current name/service/practitioner preference/contact. Missing name/phone/service/date/time is rejected on normal guarded state.

However, **an unconditional independent proof that every required argument is checked immediately before invocation is not available**: H03 allows empty practitioner ID in the entry guard, and semantic extraction/provenance assumptions remain. Valid deployed slot results normally fill the ID, and the backend validates the exact signed tuple plus required fields before persisting. A stale slot can reach a creation attempt if it expires after selection, but backend token/check/row validation rejects it. Required JSON keys alone do not guarantee nonempty values.

**No current deployed-backend path to falsely confirmed new booking was found.** `confirmedBooking` requires success=true, booked=true and a UUID, then the graph additionally requires the mapped success/flag/nonempty ID. This depends on backend validation, not just the conversation prompt. Cancellation/reschedule have the separate false-success vulnerability C02. C03 can create uncertainty/duplicate-action risk without falsely setting a success flag.

All 16 contracts, required argument sources, invoking nodes, response mappings and validation gaps are documented individually. No tool was executed. Missing-field protection on cancellation/reschedule and legacy request tools is schema/prompt/backend based, not equivalent to new-booking deterministic guards. Receipt means nonempty response object, not complete operation-specific success.

## Read-only validation actually performed

- Fresh published agent/flow read-back and exact canonical comparison of nodes/tools/global prompt/defaults against `ce94de8`.
- Complete graph traversal, target/reference/ID validation, reachability and strongly connected component analysis; all 438 explicit edges accounted for.
- Static compilation of all 76 published JavaScript code nodes.
- Inspection of all 180 nodes, all prompts/extractors/defaults/output mappings and all 16 tool contracts.
- Deployed handler/helper and relevant RPC definition inspection; read-only transfer settings verification.
- Seven deterministic code/condition probes: single-slot matcher, multi-slot matcher, same-query multi-slot correction, empty practitioner-ID guard, cancellation malformed-success stale-ID condition, reschedule malformed-success stale-ID condition, and no-retry-output/retry-edge mismatch.
- Existing offline fixture inspection only. The previous release's 137 checks were not rerun or claimed as new audit evidence. No agent/conversation/simulation execution occurred.

The matcher probes used inert synthetic payloads matching deployed token structure, with placeholder signatures and no network destination. They do not manufacture a caller conversation or invoke the agent.

## Future manual checks after a fix decision

The detailed proposed scenarios and stable path IDs are in [path-catalog.md](path-catalog.md#future-manual-acceptance-priorities--not-performed). Priorities are: normal multi-slot booking in English/Arabic; early-field/skipping combinations; any/sole practitioner; ambiguous/changed slots; rejection and name/phone-only corrections; second booking isolation; authorized existing-appointment target selection/approval; coherent reschedule scope; known/unknown FAQ task resume; disabled transfer and safe retained follow-up.

Malformed/timeout/uncertain mutation outcomes should first be validated offline, not by inducing uncertain real appointments. No future testing is authorized by this document.

NO RUNTIME CHANGES MADE  
NO RETELL CONFIG CHANGES MADE  
NO PUBLISH PERFORMED  
NO LIVE CALLS PERFORMED  
NO TRY-A-CALL USED  
NO SIMULATED CONVERSATIONS PERFORMED  
NO PAID TESTING PERFORMED

**AUDIT RESULT: FIXES REQUIRED BEFORE MANUAL ACCEPTANCE TEST**

