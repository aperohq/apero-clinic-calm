# System downtime fallback

Scope: live conversation/tool outages only. Booking, calendar, unknown-answer, Human Escalation, call transfer, recording security, clinic ownership, RLS and roles keep their existing contracts. No new provider, Requests category, outage table, disaster recovery service or live-call test.

## Existing behavior

Specific booking/calendar failures already have safe retained-or-unsaved follow-up results. Unknown-answer, Human Escalation and transfer helpers also report actual persistence outcomes. Signed integration routing and call ownership determine the clinic. Retell custom functions already use bounded timeouts and zero retries. Webhook persistence reports non-2xx on failure; provider webhook retries are separate from live patient recovery.

Missing: generic early configuration/database/runtime errors could return only a tool error; transport failure could retain earlier success variables, and there was no terminal conversation-level downtime response.

## Triggers and priority

The clinic-operations boundary marks each nonempty JSON result with a current response receipt. It provides system_unavailable for uncaught runtime/bootstrap failures, empty/malformed critical output, early ownership/database exceptions outside specific helpers, unavailable timezone configuration before booking handling, unexpected internal exceptions, and generic operational persistence/RPC failures without a specific recovery path.

Returned booking, calendar, unknown-answer, Human Escalation and transfer-failure results retain their specific edges and wording, including unsuccessful follow-up saves. They are not converted into generic downtime. Availability errors inside its existing calendar boundary continue to use calendar follow-up first.

Each critical Retell function entry clears its current response receipt, message and confirmation outputs. Function results check missing receipt or system_unavailable before domain transitions; only those wider failures go to downtime. Success and all original domain edges remain after that guard. A function's unconditional success exit is evaluated after the guard. The terminal downtime code clears all operational confirmation outputs, IDs and appointment/slot lists. Global nodes cannot restart automation there. There are no retries or extra dependency calls from this path. Tool HTTP failures, unreachable backend, authentication/config-routing failure and timeout all have missing current receipt; the native flow handles them without needing the backend to recover.

## Patient wording and direct contact

In the established caller language:

> I’m sorry, the clinic’s automated system is temporarily unavailable right now. Please contact the clinic directly.

When a current signed and owner-validated backend error can safely read clinic configuration, append:

> You can reach the clinic at [configured number].

Use clinics.fallback_phone first, then clinics.phone; accept only bounded numeric telephone formats, removing spaces/parentheses/hyphens. No caller args, extracted phone variables, old tool messages or knowledge-base numbers are used. The single clinic-scoped read is capped at 500ms and happens only for unexpected internal errors, never after known database/configuration failure. Missing/invalid/unreadable contact produces the generic message.

Do not claim the interrupted operation succeeded or failed if its outcome is uncertain (a network timeout may occur after commit). Do not claim an appointment or follow-up exists without confirmation. Previously confirmed operations stay confirmed. Do not retry, save a second request, offer a transfer or promise callback timing. End the automated handling after speaking the message.

## Operational logging and persistence

Existing Edge operational logging is the minimal outage-event mechanism. Log only clinic_id/call_id when verified and known, category system_unavailable, dependency_category from the fixed enum, and fallback_response_returned. The boolean means the handler constructed/returned the response, not proven audio delivery. No additional database outage writes or Requests entries are attempted; no persistence/retention is claimed. Logs exclude patient contacts, names, reasons, transcripts, tokens, provider payloads and raw database errors.

If the backend itself cannot execute, it cannot log or return a response; Retell still takes the missing-receipt timeout path. No false logging/persistence claim is made. Retell's existing provider tool-error records are not copied into application logs.

## Native Retell capabilities inspected

- [Function nodes](https://docs.retellai.com/build/conversation-flow/function-node): wait for results and transition based on the result; a conversation node speaks the result.
- [Custom functions](https://docs.retellai.com/build/conversation-flow/custom-function): timeout/error information reaches the flow; JSON populates response variables; max_retry=0 disables retries. Supported equation edges compare variables in order. No invented failure-event/telephony feature is used.
- [Webhooks](https://docs.retellai.com/features/webhook-overview): up to three retries on non-2xx/10-second timeout. Existing idempotent post-call handling is preserved and cannot provide live audio recovery when Retell is fully down.

## Acceptance and launch dependencies

Tests execute real handlers, shared helper contracts and actual generated code nodes. They cover bootstrap/database/configuration/internal outages, generic persistence failure, uncertain cancellation outcome, no false booking/follow-up, trusted contact scoping, caller/foreign-clinic rejection, stale flags, bounded single contact read, zero retry/terminal flow, specific fallback preservation, and log redaction. Existing SQL/RLS and reliability suites remain required.

If Retell's conversation/audio service is fully unavailable, no Apero-controlled code can guarantee the spoken response. Provider-level inbound downtime routing is **blocked and unconfigured** until the final SIP provider is selected. Required then: verified Dental Zone direct destination, provider-native unavailable/no-answer/error routing and timeout policy, independent outage message/routing, and real inbound telephony acceptance for backend failure, Retell failure, uncertain in-flight write and audio return. No number or provider is invented. Live transfer remains disabled as previously configured. No paid live call is required for this release.

No frontend UI changes are needed. Backend and Retell publication implement this behavior independently of Lovable site publication. Source commits may sync to Lovable; there is no new public-site publication requirement from this release.
