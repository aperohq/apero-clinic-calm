# Full v17 flow audit findings

Audit scope: current published agent `agent_b84b2766efeb85afc809147d7a`, flow `conversation_flow_43f53e5e8531`, both **v17**; exact nodes/tools/global-prompt/defaults match commit `ce94de8`. Deployed `clinic-operations` is function version 17. Findings are static/source-derived unless explicitly marked as a deterministic code fixture. No operational tool or conversational agent was executed. Potential/model-mediated failures are distinguished from demonstrated code defects.

## CRITICAL C01 — Existing-appointment mutation target and approval are not bound to selected/read-back state

**Affected:** `node_select_existing → node_cancel_confirm → node_cancel_tool_wait_language_gate → node_downtime_prepare_node_cancel_tool[_arabic_wait] → node_cancel_tool[_arabic_wait]`; parallel reschedule final/tool chain.

The selection node says “Capture its appointment_id” but is a conversation node with no extraction/code output mapping. There is no deterministic selected-existing-appointment ID, selected-appointment membership guard, cancellation consent tuple, or reschedule consent tuple. All mutation argument IDs/identity/slot fields are model-generated strings, unlike the const-bound new-booking tool. `confirmed` on cancellation is a schema enum `[true]`; it constrains the submitted value, not proof the caller approved that particular appointment. Reschedule has no approval argument at all. Prompt-conditioned final edges are the only approval barrier.

The deployed RPC validates clinic, patient name/phone and target appointment ownership. It does **not** know which of that same patient's appointments the caller selected or read back. Thus selection/readback of A followed by model-supplied ID B for the same verified patient is not rejected on selection/approval grounds. For reschedule the signed slot protects slot validity, not the old appointment ID approved by the caller. This is an architectural safety gap and a conditional wrong-target path, **not** an observed incorrect live mutation. No database mutation was attempted to demonstrate it.

**Recommendation only:** Persist the exact lookup-selected appointment ID and current patient association; verify membership in current lookup results; bind mutation arguments and explicit action-specific approval to an exact old/new tuple before entry. Do not reuse booking consent for these actions.

## CRITICAL C02 — Cancellation/reschedule can announce success from malformed current success plus an old result ID

**Affected:** `node_cancel_tool`, `node_cancel_tool_arabic_wait`, `node_reschedule_tool`, `node_reschedule_tool_arabic_wait`, their downtime preparation nodes, `cancel_appointment` and `reschedule_appointment` response mappings.

Success transitions test only `cancel_success/reschedule_success == true` and result ID `exists`. Preparation clears the success flag but **not** `cancelled_id/rescheduled_id`. Neither transition checks the operation-specific `appointment_cancelled/appointment_rescheduled` flag, ID type, UUID format, identity with the selected target, or current-result provenance. The deployed handler returns cancellation/reschedule RPC data directly; `downtimeBoundary` accepts any nonempty object and adds a receipt. New booking has a stricter `confirmedBooking` validator; these actions do not.

**Deterministic condition fixture:** prior nonempty result ID → execute actual preparation code → map current `{success:true}` with no appointment ID → current receipt true/system flag false. Both success conditions match with the old result ID retained. No agent/API call was used. Mapping an omitted response path must be confirmed against platform behavior; even independently, operation-specific success/selected-ID validation is absent. The current deployed RPC normally emits complete valid success, so this is a **fault/malformed-response vulnerability**, not a claim ordinary valid RPC results are wrong.

**Recommendation only:** Clear current result IDs, validate operation-specific success schemas and target IDs in the backend, and require current verified results in graph conditions.

## CRITICAL C03 — An uncertain booking failure can enter a fresh write cycle despite no-retry output

**Affected:** `node_book_failed → edge_book_failed_retry → node_invalidate_booking_clear_ack → … → node_change_booking → … → new availability → … → node_book[_arabic_wait]`.

The backend failed-booking helper returns `retry_allowed:false` and says staff must check existing appointments before scheduling/confirming anything. The Retell tool does not map `retry_allowed`, follow-up-saved state, or uncertain-outcome state. The failure node offers a fresh check for any caller wanting availability/corrections; its edge is not restricted to safe definitive rejection such as slot conflict.

A fresh availability token changes the operation key, so per-operation idempotency cannot prevent a **second different booking** after an earlier timed-out request committed or its outcome is unknown. Aborting the client request does not constitute proof of database rollback. The existing same-slot conflict protection prevents conflicting slot acquisition; it does not prevent the same patient receiving another appointment at another slot after an uncertain first write.

This is a conditional uncertainty/duplicate-action hazard demonstrated by graph and key construction, **not** a demonstrated duplicate in production. Backend helper timeout handling and durable follow-up are real protections, but the graph does not honor their no-retry instruction.

**Recommendation only:** Separate definite validation/slot rejection from uncertain creation; uncertain outcomes must stop automated creation and use the existing retained follow-up/direct-verification path.

## HIGH H01 — Published matcher rejects normal multi-slot availability

**Affected:** `node_match_slot` and `node_correction_guard`; entry from `node_offer → node_capture_slot`.

Both compare `check !== token.q` and assign `check = token.q`. The deployed `tokenFor` defines **i = shared availability check ID; q = unique checked-slot row ID**. The backend returns up to 12 slots with different q values. Consequently:
- `node_match_slot` returns `block/invalid_state` for a normal array containing two distinct rows, before considering the caller's selected time; its else edge goes to `node_reset_failed`.
- A same-request clarification with several valid rows returns `refresh/expired_or_mismatched_check`, causing unnecessary invalidation and another check.

**Deterministic actual-code fixtures:** one slot → matched; two distinct q values with the same i → block; same-query correction → refresh. Tokens were inert offline placeholders with deployed payload shape, never submitted to any service. This is a definite code defect, not a model-quality hypothesis.

The repository's untracked `retell/acceptance/v7/static-audit.mjs` already explicitly forbids `check!==token.q` and expects comparison of token.i; those candidate artifacts are **not** the current published source of truth. The v17 tests bypass the matcher in their final booking-chain fixture by seeding a slot and calling `node_guard_slot` directly. Their passing result does not establish multi-slot selection.

**Recommendation only:** Compare shared check IDs using i, retain per-slot q for membership, and validate realistic multi-slot payloads through the complete matcher/guard chain before manual acceptance.

## HIGH H02 — Name/contact-only corrections have no complete routing path

**Affected:** `node_final`, `node_offer`, `node_patient`, `node_clear_correction`, `node_change_booking`, `node_correction_clarify`.

At final readback “Caller corrects a detail” invalidates the booking; correction clearing intentionally preserves `client_name/client_phone/patient_confirmed/patient_evidence`. `node_change_booking` then has only service, doctor, incomplete date/time, and complete date/time/doctor edges. There is no name-only or contact-only branch to update patient fields, rebuild evidence/readback, and obtain new consent. A caller saying “the phone number is wrong” can be stranded or rerouted by model inference.

At `node_offer`, the change condition explicitly excludes patient/contact detail, but no other edge handles a patient/contact correction. `node_correction_clarify` similarly excludes it. The pre-time patient collection node can collect identity, but the post-slot correction chain does not deterministically return there.

**Recommendation only:** Add explicit patient/contact correction routing that updates association/evidence, clears dependent readback/consent and returns to final approval without silently preserving wrong identity. Distinguish identity-only changes from scheduling changes.

## HIGH H03 — Booking guards do not independently require nonempty practitioner_id

**Affected:** `node_guard_book`, `node_intake_entry_node_book`, `node_intake_entry_node_book_arabic_wait`.

With mode `any`, the first doctorOK disjunct permits both practitioner ID and name to be empty. The creation-entry condition explicitly requires slot/date/time but never explicitly requires a nonempty canonical practitioner ID. An isolated, otherwise internally consistent readback/consent fixture with `practitioner_id:''` passes both actual code guards.

**Limit of finding:** The normal published path also traverses `node_match_slot → node_guard_slot`; valid deployed availability results include a practitioner ID, and the signed backend tuple comparison/RPC reject a missing ID. No complete normal-backend path persisting an appointment without a practitioner was found. This is a **definite incomplete entry contract**, not proof of a missing-ID appointment in production. It prevents an unconditional claim that the tool-entry guard itself guarantees every required field.

**Recommendation only:** Explicitly validate every required creation field at entry; preserve upstream membership/backend checks.

## HIGH H04 — Advertised reschedule changes conflict with linked-appointment availability

**Affected:** `node_reschedule_details`, `node_reschedule_no_slots`, `check_availability` and deployed availability handler.

Prompts allow changing doctor/service and offer another qualified practitioner. When availability correctly includes `appointment_id`, the backend rejects `existing.service !== service` and filters selected practitioners to `existing.staff_id`. A different doctor or service cannot pass that linked availability check. Omitting appointment_id avoids these restrictions but also loses the existing-appointment exclusion/validation. Thus behavior depends on optional model-generated arguments rather than one coherent supported contract.

**Recommendation only:** Decide the supported reschedule scope and align prompts, required linked availability arguments, and backend constraints. Retain atomic update, never substitute create.

## MEDIUM findings

### M01 — Early-known-field retention is semantic, not a deterministic merge

`node_fresh_request` explicitly lists service/doctor/date/time/patient but does not require preservation of supplied phone; name/service/practitioner/contact/search are extracted again in separate stages. Extraction descriptions prohibit prior-cycle inference but do not form a validated immutable field store. A later extractor can clear/replace a previously supplied ID/name or omit early contact. A valid specific name without canonical ID fails complete-intake guards even though the backend can resolve names. Missing-field guards fail closed; they do not necessarily choose a helpful recovery question. No assertion about actual speech recognition was made.

Recommendation: validate and merge explicit current-cycle fields with provenance; treat invalid/uncertain fields as missing, and ask the specific missing question.

### M02 — Informational interruption/unknown-follow-up can lose the unfinished task

`node_global_faq` has a dynamic go-back rule for the interrupted node. Unknown follow-up instead goes `node_unknown_prepare → collect → save → saved/failed → node_anything_else`, despite its prompt saying preserve the prior task. Human follow-up intentionally stops the escalated task, but unknown-information follow-up need not. The FAQ activation whitelist omits the new `Patient name first` node, so a factual interruption during name collection has no equivalent explicit resume route.

Recommendation: define explicit return context for informational follow-up; extend allowed FAQ contexts intentionally.

### M03 — Name-cycle proof is not tied to the actual name value

`intake_name_cycle` stamps a cycle, not a name fingerprint. `node_intake_contact_capture` and `node_capture_patient` can overwrite client_name afterward. The cycle marker is not cleared by the old reset map (it becomes mismatched after a new reset, which is a real protection). Current patient/evidence/consent checks reduce risk, but “name established” does not mechanically mean the exact currently stored name was the value originally checked. Evidence is extracted model text, not a trusted caller-event record.

Recommendation: bind provenance to value plus cycle; explicitly handle identity changes.

### M04 — Overlapping failure predicates and transport fallback precedence

Availability function edges allow both downtime receipt failure and calendar/domain/success predicates to match for inconsistent state; the success predicates do not require current receipt/system availability. Normal preparation clears flags and the backend usually supplies coherent responses. On no receipt, the downtime edge matches; the same function also has an else edge to Calendar Unavailable. Runtime timeout-vs-else semantics are not proved by static array order. Similar OR-receipt/success overlaps occur on operational tools. Reset language gate also overlaps “known language + first cycle” with “known language”; first-cycle extraction overlaps analogous branches. `node_new_cycle_readback` “does not clearly confirm” overlaps decline.

Recommendation: make branch predicates disjoint, and specify platform error routing separately from domain-failure routing. Preserve specific fallback priority.

### M05 — Failed-booking follow-up result is not exposed to its conversation node

The backend may already have saved a failed-booking request, but tool mappings discard `follow_up_saved`, `follow_up_request_id`, `patient_instruction` and `retry_allowed`. `node_book_failed` generically offers a durable callback and says “NOT booked.” This can omit the already-saved outcome, create a second generic follow-up, or overstate failure when the remote write is uncertain. C03 covers the more serious retry consequence.

Recommendation: map the specific failed-booking result and use distinct saved/unsaved/uncertain wording.

### M06 — Correction invalidation leaves several stale local result values

`node_clear_correction` clears slot/slots/selection/patient-cycle/consent/readback but leaves availability_success, available, query signature, old resolve flags and selected_practitioner_* values. Backend invalidation clears the current check. Matcher phase/signature and backend token checks usually prevent stale booking; the stale values can still influence prompt reasoning. For any-practitioner preference, selected practitioner ID/name are cleared for a recheck, which is correct. Service-change inputs are recaptured semantically; no deterministic service-change reset clears all dependent practitioner fields before that capture.

Recommendation: define phase-specific stale/result-field resets, preserving only intentionally unaffected identity/preference.

### M07 — Availability-only callers are forced through booking identity/contact intake

Greeting and reset conditions combine “new appointment” with “only wants to check availability.” Both enter name → service/practitioner → confirmed contact before date. The offer node recognizes availability-only intent later, but no earlier mode bypasses patient/contact collection. Standalone clinic FAQs remain separate.

Recommendation: decide whether pure slot inquiry should require personal details and encode the chosen distinction explicitly.

### M08 — Existing-appointment inquiry has incomplete entry/completion

Greeting's existing-appointment edge says change/cancel, not lookup-only; there is no greeting else edge. Anything Else/FAQ support lookup, but `node_select_existing` only exits to reschedule or cancel. A caller wanting only appointment information, or rejecting both actions, has no local done/return edge. Unmatched conversation conditions may wait/reprompt rather than terminate.

Recommendation: add explicit read-only appointment inquiry entry and done route.

### M09 — Calendar result received during booking/reschedule creation selects the wrong family

The deployed handler can return `calendar_unavailable` before book/reschedule via `calendarBlocked`. Booking maps that only as booking_error_type; reschedule maps it as reschedule_error_type. Neither creation node tests it to go to `node_calendar_unavailable`; their else paths use generic booking/reschedule failure and can offer retry. The backend's persisted calendar latch generally prevents further creation, but the graph violates the specific terminal-calendar policy.

Recommendation: handle the specific calendar result before generic mutation failure and preserve no-retry behavior.

### M10 — Several ordinary caller exits have no explicit local transition

Examples: declining booking during `node_intake_name`/service/doctor/date collection; “I am done” at `node_book_failed`, existing-not-found, reschedule-failed, or cancel-failed; “keep it” at existing selection; withdrawing contact during legacy urgent/message/callback collection. These are conditional conversational dead ends, not zero-edge nodes. Global human/urgent interrupts do not supply a normal polite-decline exit.

Recommendation: add explicit stop/change-task routes where intended; distinguish waiting for a requested answer from inability to handle a valid user exit.

### M11 — Unknown/unsupported service has only a clarification loop locally

Resolver errors go to `node_service_clarify`, which asks using returned candidates. Unsupported service may return an empty candidate list; there is no explicit local “unsupported/decline/staff help” edge. Global escalation for repeated failures exists but is model-mediated and can lose the specific unsupported-service context.

Recommendation: distinguish ambiguity from unsupported service and provide a concrete local exit without fabricating services.

### M12 — Urgent handling and terminal calendar isolation rely on global semantic priority

The urgent global rule can activate broadly except downtime, including terminal-calendar handling; its request-save route returns to Anything Else and can structurally re-enter scheduling. The backend calendar latch generally blocks creation, so this is not a demonstrated successful calendar-failure bypass. Conversely, initial urgent intent can route directly to urgent collection without passing the global urgent node containing explicit emergency guidance. Other prompts may supply the guidance, but graph traversal does not guarantee it.

Recommendation: define allowed interruption/return domains and emergency wording independent of which urgent entry was selected. Do not introduce AI clinical triage.

### M13 — Arabic alias compensation is limited to new-booking service resolution

Read-only clinic configuration shows 30 service-alias rows across eight active services, with zero valid Arabic-script aliases. The published new-booking service guard compensates with 14 exact approved Arabic mappings, then calls the authoritative resolver. Generic reschedule availability does not traverse that guard; a raw Arabic service argument must be translated by the model or it will not match those corrupted alias rows. Existing canonical service names returned by lookup still work. This is a contract/localization dependency, not evidence that every Arabic reschedule fails.

Recommendation: align authoritative alias configuration and all service-resolution paths in a separately authorized fix. No database data was changed during this audit.

## LOW findings

- **L01 — Duplicate helper names obscure review.** English/Arabic operational nodes are intentionally parallel, and receipt/calendar/guard-clear nodes share names. They are reachable utility nodes, not proven obsolete. Preserve IDs and make audit/release tooling display them distinctly.
- **L02 — Mode vocabulary is only partially formalized.** New booking extraction/guard uses earliest/exact/window; generic reschedule schema exposes date/earliest; backend treats every non-earliest request as a dated search. This currently works by backend interpretation, but makes stale or invalid enum strings harder to detect. `any_qualified` is absent from published code/extraction descriptions; mode `any` is correct.
- **L03 — Prior passing tests did not establish end-to-end deterministic graph behavior.** The 17 v17 intake tests inspect several edges and guard functions, but seed selected slot state instead of passing a realistic multi-slot result through the matcher. Existing v7 candidates contain stronger, unpublished invariants. Audit inspected those files without executing them, modifying them or treating their configuration as published.

## INFO / verified protections and limits

- **I01:** 180 unique nodes; 438 unique explicit edge IDs with valid target nodes; no structurally unreachable nodes after four global entries. Exactly four nodes require implicit global activation to be initial reachability roots: global FAQ, urgent, human, unknown-follow-up.
- **I02:** 76 code nodes compile. 26 backend function nodes reference 16 defined tools. Every defined tool has a calling node. No missing-target, orphaned tool, or zero-outgoing nonterminal node was found.
- **I03:** All explicit new-booking routes to English/Arabic creation are dominated by reset verification, name gate, complete non-time router, resolver, search guard, matcher, slot guard, patient guard, final readback, consent extraction and booking guard. This is a structural proof, not a proof of semantic extraction truth.
- **I04:** No actual deployed-backend path to false **new-booking** confirmation was found: signed slot/current-check/RPC checks and `confirmedBooking` require actual verified creation success, booked=true and UUID. Graph success alone is weaker (nonempty ID), so the guarantee depends on that backend validator. H03 prevents claiming the entry code independently validates every field.
- **I05:** Signed raw-body integration routing supplies clinic identity; arbitrary caller clinic IDs and arbitrary caller transfer destinations are not trusted. Backend enforces same-clinic patient/appointment and signed-slot ownership. This audit did not access any patient records or recordings.
- **I06:** Transfer is currently disabled, and no fallback destination is configured. Trusted backend config, hours, phone-call type, one-attempt atomic reservation, provider bridge events and no-downgrade transfer state protect the path if later enabled. No activation/configuration change was made.
- **I07:** Calendar dependency failures are validated, retained where possible, and made terminal by explicit local nodes. Normal domain validation errors use correction paths. System Downtime clears operational success/IDs and ends automation; unknown/human save failures use safe unsaved wording.
- **I08:** No direct edge from FAQ/unknown/human to booking success or creation was found. Those features can return to Anything Else and later enter an explicitly requested new feature. Cancellation/reschedule have distinct mutation tools; no explicit reschedule-to-create edge exists. Shared mutable identity/results and model-generated arguments remain the cross-feature risks in C01/C02/M02/M06.

## Booking hazard checklist

| Question | Finding |
|---|---|
| Date/time without name | No normal booking route: only date entry is complete-intake router requiring a current name stamp and contact. |
| Availability without resolved service or practitioner state | New-booking search and tool entry reject it; reschedule has model-generated schema/backend validation, not equivalent guards. |
| Selection without real returned availability | New booking uses matcher + membership + backend token; H01 blocks many valid results. Reschedule selection is prompt-mediated; mutation backend still checks signed slot/current check. |
| Final consent without selected slot | Only booking readback entry is patient guard after membership; semantic/malformed state limits noted. |
| Creation missing name/phone/service/date/time | Guards reject normal missing state; backend rejects invalid arguments. |
| Creation missing practitioner ID | Guard-only fixture passes in any mode (H03); valid returned-slot chain/backend normally supplies/requires ID. |
| Stale or arbitrary slot persisted | Backend HMAC, call/clinic, expiry, current-check and checked-row verification reject it. Guards do not revalidate age immediately before calling creation; stale attempts can reach tool and fail. |
| Confirmation without successful new creation | No current deployed-backend witness found. C02 concerns cancellation/reschedule success. |
| User consent mechanically proved | New booking tuple equality and flags are enforced, but actual utterance interpretation is model-mediated. Existing mutations lack equivalent binding (C01). |
| Booking/cancel/reschedule/FAQ cross-jumps | No unconditional mutation cross-jump; explicit task-switch routers are shared. Unbound mutation IDs/arguments can cross logical selections; informational return context can be lost. |

## Outcome

**AUDIT RESULT: FIXES REQUIRED BEFORE MANUAL ACCEPTANCE TEST**

Recommendations above are documentation only. None were implemented. The earlier v17 release's passing offline counts do not override these audit findings.

NO RUNTIME CHANGES MADE  
NO RETELL CONFIG CHANGES MADE  
NO PUBLISH PERFORMED  
NO LIVE CALLS PERFORMED  
NO TRY-A-CALL USED  
NO SIMULATED CONVERSATIONS PERFORMED  
NO PAID TESTING PERFORMED

