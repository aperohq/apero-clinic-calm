# Bounded service clarification — published v22

Baseline: published v21, agent `agent_b84b2766efeb85afc809147d7a`, flow
`conversation_flow_43f53e5e8531`. Published v22 was read back and compared to the
candidate, including every flow field except server version/publication/timestamp
metadata. Agent settings were independently compared to v21.

## Cause and exact old loop

`Resolve Service` (`node_resolve`): response received, no system downtime, but
`resolve_success != true` → Else → `Clarify Service` (`node_service_clarify`).
Its “Caller clarifies the service” edge returned to `node_intake_name_capture`
→ `node_intake_name_gate_clear` → `node_intake_name_gate` → `node_service`
→ `node_capture_service` → `node_guard_service_clear_result`
→ `node_guard_service` → `node_downtime_prepare_node_resolve`
→ `node_resolve` → the same Else → Clarify Service, indefinitely.

There was no clarification count, cycle budget or exhausted branch. The service
extractor could reuse the original `fresh_request_summary` rather than prioritize
the clarification answer. Clarify Service's inherited instruction ended “If
unsure, re-clarify.” Its instruction did not interpolate `service_candidates`.
An unusable reply could also remain in the conversation node because there was
no unmatched-response edge. The initial service guard treated an empty query as
a reset error instead of a recoverable service-input problem.

Unresolved variable: `service_query` remained unsupported/ambiguous, so the
resolver could not establish canonical `service_name` and
`qualified_practitioners`, and returned `resolve_success=false`. The pre-resolver
receipt node cleared `resolve_success`, but did not clear canonical service or
candidates. Response mappings for absent fields could leave previous values
unchanged; there was no deliberate service-state clear in the old retry loop.
There is no separate service ID in this configured flow: the backend uses the
canonical service name against current staff service assignments.

`loop-audit.json` inventories the relevant nodes and their exact outgoing
conditions/destinations, code reads and mapped writes from published v21.

## New behavior

- Understand Service has a deterministic first edge for an already resolved
  canonical service with returned qualified practitioners. It skips service
  questioning, capture and resolution and continues to practitioner handling.
- Supplied natural wording is sent to the existing resolver before any service
  clarification. Resolver tools, backend matching, thresholds and alias mappings
  are unchanged. Only real unresolved results enter the new code gate.
- Successful resolution reaches practitioner handling immediately and resets
  `service_clarification_attempts` to zero.
- First unresolved/empty result consumes the budget **before** entering Clarify
  Service: attempts=1 and `service_clarification_used=true` for `reset_attempt`.
  Returned candidate names appear in its single question when available.
- Every unmatched clarification reply goes to extraction via a native Else edge;
  it cannot remain in Clarify Service asking again. Its reminder count is zero.
  Extraction gives this answer priority over the original request.
- Still unresolved → existing `node_human_prepare` → `node_human_collect`.
  That unchanged path explains that clinic staff assistance is needed, reuses
  known details, permits declining optional contact, and supports withdrawing the
  escalation. No automatic transfer, alternate service mapping or service retry
  was added.
- Explicit service changes retain the existing correction/invalidation path.
  Capture's existing clear-result node now clears old service resolution and
  service-dependent practitioner state before resolving the new phrase; attempts
  reset to zero when replacing a previously resolved service. Other corrections
  preserve service state.
- Counter reset cannot defeat the **one spoken clarification per booking cycle**
  limit: the separate used latch survives success and explicit changes within
  that cycle. A newly selected service can resolve normally, but cannot cause a
  second clarification question if the cycle has already used its question.
- State is keyed by the existing fresh `reset_attempt`. A different cycle sees
  zero attempts and an unused latch, regardless of old raw variable values; the
  existing Fresh Booking Reset code is untouched. No counter leaks across calls.

## Scope and offline evidence

99 passed, zero failed: 23 focused deterministic checks plus 76 existing safety
checks against this candidate. These execute configuration JavaScript and graph
predicates only. No conversational model, agent execution or production booking
operation is involved. The fixtures cover all nine requested cases, repeated
unresolved results, string serialization, failed-code routing, native unmatched
reply routing, disabled reminders, new cycles and intentional service changes.

The real resolver code accepts exact Dental Cleaning and configured seed aliases
`cleaning`/`scaling` without clarification. The published service guard's existing
approved Arabic mappings also pass. No new mappings were added. A read-only live
catalog query was attempted but the available Supabase management token returned
401; consequently these alias checks use the published flow and repository's
configured seed aliases, not a claim of a fresh live database catalog audit.
“Teeth cleaning” was not added as an invented alias.

Retell rejected larger candidate updates at its flow storage limit. To fit, the
final implementation adds only one code node, reuses the existing staff fallback
and clear-result node, and minifies only changed code. Unused calculations were
removed from service input and intake gates. A fixture matrix verifies identical
name/practitioner/contact intake decisions. No practitioner decision changed.
All other nodes, tools, global prompt, settings and existing default values match
v21. Name-first, contact, date/time, availability, slots, booking, Fresh Booking
Reset, cancellation, rescheduling, transfer and other fallbacks are preserved.

Reproduce:

```sh
node retell/service-clarification/build.mjs
node retell/service-clarification/test.mjs
node retell/service-clarification/regression.mjs
```

The baseline metadata retained in `candidate.json` identifies the build input;
actual publication is recorded in `release.json` as **v22**.

NO LIVE CALLS  
NO TRY A CALL  
NO SIMULATED CONVERSATIONS  
NO PAID TESTING
