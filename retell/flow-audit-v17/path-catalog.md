# Complete path catalog and graph grammar

This catalog describes **131 named meaningful path families**, plus a complete finite grammar for all **438 explicit transitions**, four global entry rules and one dynamic return rule. Repeated cycles and choices generate infinitely many conversation walks. The grammar and exact predicates account for every configured transition; they do not pretend every structural walk is semantically feasible. These are inspected paths, not executed transcripts or simulated conversations.

Category counts: B=32, C=9, R=15, F=12, U=6, H=9, T=15, D=15, S=8, G=10. B=booking/inquiry, C=cancellation, R=reschedule, F=information, U=unknown, H=human, T=transfer, D=domain fallback, S=system, G=general. Categories count families, not every English/Arabic/loop combination.

## Exact macro expansion

Macros are segments, not added nodes. Repeated endpoints across adjacent segments are collapsed. Bracket variants select the exact English/Arabic/silent nodes in the inventory. TASK/BOOKING_STATE/router/SPECIFIC_SAVE denote the stated source family, not invented runtime nodes. Macro slash alternatives are resolved by the exact graph edges; names in parentheses are explanatory state, not nodes.

- **START:** node_greeting → node_initial_language → node_first_booking_provenance.
- **RESET:** node_reset_prepare → node_fresh_request → node_reset_language_gate → [first-cycle node_reset_verify OR node_reset_invalidate_clear_ack → node_downtime_prepare_node_reset_invalidate → node_reset_invalidate → node_reset_verify].
- **RESET_SECOND:** node_reset_prepare → node_fresh_request → node_reset_language_gate → node_reset_invalidate_clear_ack → node_downtime_prepare_node_reset_invalidate → node_reset_invalidate → node_reset_verify → node_new_cycle_readback.
- **NAME:** node_intake_name_capture → node_intake_name_gate_clear → node_intake_name_gate → [missing: node_intake_name → repeat capture; present: node_service].
- **SERVICE:** node_service → node_capture_service → node_guard_service_clear_result → node_guard_service → node_downtime_prepare_node_resolve → node_resolve.
- **DOCTOR:** node_doctor_preference → node_intake_doctor_capture → node_intake_before_time_clear → node_intake_before_time.
- **CONTACT:** node_intake_before_time → node_patient → node_intake_contact_capture → node_intake_before_time_clear → node_intake_before_time.
- **TIME:** node_intake_before_time → node_date_time → node_capture_search → node_guard_search_clear_result → node_guard_search.
- **CHECK:** node_check_wait_language_gate → node_calendar_prepare_node_check[English/_arabic_wait/_silent] → node_intake_entry_node_check[variant]_clear → node_intake_entry_node_check[variant] → node_downtime_prepare_node_check[variant] → node_check[variant].
- **OFFER:** node_offer.
- **SELECT:** node_capture_slot → node_match_slot → node_guard_slot_clear_result → node_guard_slot → node_capture_patient → node_guard_patient_clear_result → node_guard_patient.
- **READBACK:** node_final.
- **CREATE:** node_capture_consent → node_guard_book_clear_result → node_guard_book → node_book_wait_language_gate → node_intake_entry_node_book[English/_arabic_wait]_clear → node_intake_entry_node_book[variant] → node_downtime_prepare_node_book[variant] → node_book[variant].
- **BOOKED:** node_booked → node_downtime_prepare_node_invalidate_after_book → node_invalidate_after_book → node_anything_else.
- **AFTER_SUCCESS:** node_downtime_prepare_node_invalidate_after_book → node_invalidate_after_book → node_anything_else.
- **INVALIDATE_BOOK:** node_invalidate_booking_clear_ack → node_downtime_prepare_node_invalidate_booking → node_invalidate_booking → node_clear_correction.
- **CORRECT:** node_change_booking.
- **CANDIDATE:** node_correction_clear_candidate → node_correction_capture → node_correction_guard.
- **START_EXISTING:** node_greeting → node_initial_language → node_existing_identity, or supported FAQ/Anything Else → node_existing_identity.
- **LOOKUP:** node_lookup_wait_language_gate → node_downtime_prepare_node_lookup[English/_arabic_wait] → node_lookup[variant].
- **CANCEL:** node_cancel_tool_wait_language_gate → node_downtime_prepare_node_cancel_tool[English/_arabic_wait] → node_cancel_tool[variant].
- **RESCHEDULE_CHECK:** node_reschedule_check_wait_language_gate → node_calendar_prepare_node_reschedule_check[English/_arabic_wait] → node_downtime_prepare_node_reschedule_check[variant] → node_reschedule_check[variant].
- **RESCHEDULE:** node_reschedule_tool_wait_language_gate → node_downtime_prepare_node_reschedule_tool[English/_arabic_wait] → node_reschedule_tool[variant].
- **INVALIDATE_RESCHEDULE:** node_invalidate_reschedule_clear_ack → node_downtime_prepare_node_invalidate_reschedule → node_invalidate_reschedule.
- **START_FAQ:** node_greeting → node_initial_language → node_initial_faq.
- **START_HUMAN:** node_greeting → node_initial_language → node_transfer_prepare.
- **START_MESSAGE:** node_greeting → node_initial_language → node_message_collect.
- **START_URGENT:** node_greeting → node_initial_language → node_urgent_collect.
- **GLOBAL_HUMAN:** implicit activation of node_global_human.
- **GLOBAL_UNKNOWN:** implicit activation of node_unknown_follow_up → node_unknown_prepare.
- **GLOBAL_URGENT:** implicit activation of node_global_urgent → node_urgent_collect.
- **TRANSFER_GATE:** node_transfer_prepare → node_downtime_prepare_node_transfer_gate → node_transfer_gate.
- **TRANSFER_SAVE:** node_downtime_prepare_node_transfer_fallback → node_transfer_fallback.
- **HUMAN:** node_human_prepare → node_human_collect → node_downtime_prepare_node_human_save → node_human_save.
- **UNKNOWN:** node_unknown_prepare → node_unknown_collect → node_downtime_prepare_node_unknown_save → node_unknown_save → node_unknown_saved/node_unknown_failed → node_anything_else.
- **CALENDAR:** node_calendar_unavailable.
- **MESSAGE:** node_downtime_prepare_node_message_tool → node_message_tool.
- **CALLBACK:** node_downtime_prepare_node_callback_tool → node_callback_tool.
- **URGENT:** node_downtime_prepare_node_urgent_tool → node_urgent_tool.
- **DOWNTIME:** node_downtime_clear → node_system_downtime → node_end.

## Named path families

### PATH B01 — Normal booking

Trigger: Only intent supplied.

`START → RESET → NAME → SERVICE → DOCTOR → CONTACT → TIME → CHECK → OFFER → SELECT → READBACK → CREATE → BOOKED`

### PATH B02 — Service supplied before name

Trigger: Cleaning known, name missing.

`START → RESET → NAME → SERVICE(skip question) → DOCTOR → CONTACT → TIME → CHECK → OFFER → SELECT → READBACK → CREATE`

### PATH B03 — Name and service supplied

Trigger: Name/service known.

`START → RESET → NAME(skip) → SERVICE(resolve) → DOCTOR → CONTACT → TIME → CHECK → OFFER → SELECT → READBACK → CREATE`

### PATH B04 — Practitioner supplied early

Trigger: Doctor named before service resolved.

`NAME → SERVICE → DOCTOR(validate known preference) → CONTACT → TIME → CHECK`

### PATH B05 — Date/time supplied early

Trigger: Earlier required intake incomplete.

`NAME → SERVICE → DOCTOR → CONTACT → TIME(skip question) → CHECK`

### PATH B06 — All information supplied

Trigger: Name/service/doctor/contact/time known.

`NAME(skip) → SERVICE(resolve) → DOCTOR(skip) → CONTACT(skip/extract) → TIME(skip) → CHECK → OFFER → SELECT → READBACK → CREATE`

### PATH B07 — Any qualified practitioner

Trigger: Explicit no preference.

`DOCTOR → node_intake_doctor_capture → node_intake_before_time_clear → node_intake_before_time → CONTACT → TIME → CHECK`

### PATH B08 — Sole practitioner

Trigger: One qualified resolver result.

`SERVICE → DOCTOR(skip) → node_intake_doctor_capture → node_intake_before_time_clear → node_intake_before_time(auto-select) → CONTACT → TIME → CHECK`

### PATH B09 — Missing-name clarification

Trigger: No usable patient name/evidence.

`node_intake_name_gate → node_intake_name → node_intake_name_capture → node_intake_name_gate_clear → node_intake_name_gate`

### PATH B10 — Missing-contact clarification

Trigger: Phone/evidence incomplete.

`node_intake_before_time → node_patient → node_intake_contact_capture → node_intake_before_time_clear → node_intake_before_time`

### PATH B11 — Missing-practitioner clarification

Trigger: Several qualify, preference missing.

`node_intake_before_time → node_doctor_preference → node_intake_doctor_capture → node_intake_before_time_clear → node_intake_before_time`

### PATH B12 — Ambiguous service

Trigger: Resolver returns ambiguity/candidates.

`SERVICE → node_resolve → node_service_clarify → NAME → SERVICE`

### PATH B13 — Unsupported service

Trigger: Resolver returns no matching service.

`SERVICE → node_resolve → node_service_clarify → NAME → SERVICE; local unsupported/stop exit missing (M11)`

### PATH B14 — No available slots

Trigger: Successful empty result.

`CHECK → node_no_slots → INVALIDATE_BOOK → CORRECT → TIME → CHECK`

### PATH B15 — Availability domain correction

Trigger: Invalid date/service/practitioner.

`CHECK → node_check_error → INVALIDATE_BOOK → CORRECT → SERVICE/DOCTOR/TIME → CHECK`

### PATH B16 — Offer rejected

Trigger: Caller declines offered booking.

`CHECK → OFFER → node_anything_else → node_end`

### PATH B17 — Exact returned slot selected

Trigger: Current local time chosen.

`OFFER → SELECT → READBACK; normal multi-row result blocks before matching (H01)`

### PATH B18 — Ambiguous or invalid local choice

Trigger: No unique returned date/time match.

`SELECT → node_slot_clarify → node_capture_slot → SELECT`

### PATH B19 — Expired returned choice

Trigger: Token expires within safety margin.

`SELECT → INVALIDATE_BOOK → CORRECT → TIME → CHECK`

### PATH B20 — Same-query clarification

Trigger: Current scheduling fields repeated.

`OFFER → CANDIDATE → node_correction_guard(same) → OFFER; multi-row result refreshes instead (H01)`

### PATH B21 — Changed query

Trigger: Actual scheduling change.

`OFFER → CANDIDATE → node_correction_guard(changed) → INVALIDATE_BOOK → CORRECT → CHECK`

### PATH B22 — Ambiguous correction

Trigger: No explicit change established.

`OFFER → CANDIDATE → node_correction_guard(clarify) → node_correction_clarify → CANDIDATE`

### PATH B23 — Final approval

Trigger: Affirm exact current tuple.

`READBACK → CREATE → BOOKED`

### PATH B24 — Final rejection

Trigger: Decline exact tuple.

`READBACK → node_anything_else → node_end`

### PATH B25 — Final scheduling correction

Trigger: Change service/doctor/date/time/slot.

`READBACK → INVALIDATE_BOOK → CORRECT → CHECK → OFFER → SELECT → READBACK`

### PATH B26 — Final name/phone correction

Trigger: Only patient identity/contact wrong.

`READBACK → INVALIDATE_BOOK → CORRECT; no complete identity-only edge (H02)`

### PATH B27 — Second appointment after success

Trigger: Current tuple approved plus new task.

`READBACK → CREATE → BOOKED → RESET_SECOND → NAME → SERVICE → DOCTOR → CONTACT → TIME → CHECK`

### PATH B28 — Abandon offer for separate task

Trigger: Explicit different new appointment.

`OFFER → RESET_SECOND → NAME → SERVICE → DOCTOR → CONTACT → TIME → CHECK`

### PATH B29 — Extraction/guard failure

Trigger: No trustworthy current result.

`NAME/SERVICE/SELECT/CREATE → node_reset_failed → node_end`

### PATH B30 — Reset retry

Trigger: Caller restates complete request.

`node_reset_failed → RESET_SECOND → node_new_cycle_readback → NAME`

### PATH B31 — Availability-only inquiry

Trigger: Caller only asks for times.

`START → RESET → NAME → SERVICE → DOCTOR → CONTACT → TIME → CHECK → OFFER → node_anything_else; personal data still forced (M07)`

### PATH B32 — Unknown fact during booking

Trigger: Unknown factual follow-up accepted.

`BOOKING_STATE → node_global_faq → UNKNOWN → node_anything_else; no explicit original-task return (M02)`

### PATH C01 — Cancel selected appointment

Trigger: Identify patient, select original, approve cancel.

`START_EXISTING → LOOKUP → node_select_existing → node_cancel_confirm → CANCEL → node_cancelled → node_anything_else`

### PATH C02 — Decline cancellation

Trigger: Caller refuses cancellation.

`node_cancel_confirm → node_anything_else → node_end`

### PATH C03 — No matching appointment

Trigger: Lookup count zero.

`LOOKUP → node_existing_not_found → node_existing_identity → LOOKUP`

### PATH C04 — Lookup failure

Trigger: Unreliable lookup.

`LOOKUP → node_tool_failure → node_callback_collect → CALLBACK`

### PATH C05 — Correct patient details

Trigger: Cancel rejected and identity corrected.

`CANCEL → node_cancel_failed → node_existing_identity → LOOKUP`

### PATH C06 — Cancel failure staff help

Trigger: Caller requests follow-up.

`CANCEL → node_cancel_failed → node_callback_collect → CALLBACK`

### PATH C07 — Cancel uncertain/system failure

Trigger: Receipt absent/system unavailable.

`CANCEL → DOWNTIME`

### PATH C08 — Cancel malformed success

Trigger: Success true, old ID retained, no current ID.

`CANCEL → node_cancelled; conditional fault (C02)`

### PATH C09 — Wrong selected cancel target

Trigger: Model sends same patient's B after readback A.

`node_select_existing → node_cancel_confirm → CANCEL(ID B) → backend patient check → node_cancelled; conditional risk C01`

### PATH R01 — Move identified appointment

Trigger: Real replacement slot and approval.

`START_EXISTING → LOOKUP → node_select_existing → node_reschedule_details → RESCHEDULE_CHECK → node_reschedule_offer → node_reschedule_final → RESCHEDULE → node_rescheduled → AFTER_SUCCESS`

### PATH R02 — No replacement slots

Trigger: Valid empty availability.

`RESCHEDULE_CHECK → node_reschedule_no_slots → INVALIDATE_RESCHEDULE → node_reschedule_details → RESCHEDULE_CHECK`

### PATH R03 — Keep original after no slots

Trigger: Caller retains appointment.

`node_reschedule_no_slots → node_anything_else`

### PATH R04 — Invalid reschedule inputs

Trigger: Domain validation fails.

`RESCHEDULE_CHECK → node_reschedule_check_error → INVALIDATE_RESCHEDULE → node_reschedule_details`

### PATH R05 — Select replacement slot

Trigger: One returned option chosen.

`node_reschedule_offer → node_reschedule_final → RESCHEDULE; selection/approval prompt-mediated (C01)`

### PATH R06 — Correct replacement

Trigger: Service/doctor/date/time/window/slot changes.

`node_reschedule_offer/node_reschedule_final → INVALIDATE_RESCHEDULE → node_reschedule_details → RESCHEDULE_CHECK`

### PATH R07 — Reject replacement offer

Trigger: Caller keeps original.

`node_reschedule_offer → node_anything_else`

### PATH R08 — Reject final move

Trigger: Caller declines tuple.

`node_reschedule_final → node_anything_else`

### PATH R09 — Retry rejected move

Trigger: Caller asks another replacement.

`RESCHEDULE → node_reschedule_failed → INVALIDATE_RESCHEDULE → node_reschedule_details → RESCHEDULE_CHECK`

### PATH R10 — Reschedule staff help

Trigger: Caller requests follow-up.

`node_reschedule_check_error/node_reschedule_failed → node_callback_collect → CALLBACK`

### PATH R11 — Reschedule calendar failure

Trigger: Dependency/malformed availability.

`RESCHEDULE_CHECK → CALENDAR`

### PATH R12 — Reschedule system failure

Trigger: Mutation receipt/exception failure.

`RESCHEDULE → DOWNTIME`

### PATH R13 — Reschedule malformed success

Trigger: Success true, previous ID retained.

`RESCHEDULE → node_rescheduled → AFTER_SUCCESS; conditional fault C02`

### PATH R14 — Change original doctor/service

Trigger: Linked appointment_id supplied.

`node_reschedule_details → RESCHEDULE_CHECK → node_reschedule_check_error; backend original-service/staff restriction H04`

### PATH R15 — Wrong original move target

Trigger: Model old appointment ID differs from approved ID.

`node_select_existing → node_reschedule_details → RESCHEDULE_CHECK → node_reschedule_final → RESCHEDULE(ID B); C01`

### PATH F01 — Opening hours

Trigger: Standalone configured fact.

`START_FAQ → node_initial_faq → node_anything_else`

### PATH F02 — Location/directions

Trigger: Configured address/fact.

`START_FAQ → node_initial_faq → node_anything_else`

### PATH F03 — Parking unknown

Trigger: No approved parking evidence.

`START_FAQ → node_initial_faq → unknown wording → UNKNOWN only on opt-in`

### PATH F04 — Price question

Trigger: Treatment pricing restricted/unknown.

`START_FAQ → node_initial_faq → configured pricing policy/unknown wording → UNKNOWN only on opt-in`

### PATH F05 — Insurance question

Trigger: Conflicting insurer evidence.

`START_FAQ → node_initial_faq → no acceptance claim → UNKNOWN only on opt-in`

### PATH F06 — Service/practitioner fact

Trigger: Approved evidence only.

`START_FAQ → node_initial_faq → supported answer or unknown wording → node_anything_else/UNKNOWN`

### PATH F07 — Fact interrupts active task

Trigger: Whitelisted unfinished state.

`TASK → node_global_faq → dynamic go-back → actual previous TASK`

### PATH F08 — FAQ to booking

Trigger: Explicit new booking/availability request.

`node_faq/node_initial_faq → RESET/first provenance → NAME → SERVICE → DOCTOR → CONTACT → TIME → CHECK`

### PATH F09 — FAQ to existing operation

Trigger: Explicit lookup/change/cancel request.

`node_faq/node_initial_faq/node_global_faq → node_existing_identity → LOOKUP`

### PATH F10 — FAQ to human

Trigger: Direct staff request.

`node_faq/node_initial_faq → node_transfer_prepare → TRANSFER_GATE`

### PATH F11 — FAQ to message/callback

Trigger: Explicit durable request.

`node_faq/node_initial_faq/node_global_faq → node_message_collect/node_callback_collect → MESSAGE/CALLBACK`

### PATH F12 — Own appointment inquiry only

Trigger: Caller wants information and no change.

`LOOKUP → node_select_existing; no local information-only done edge (M08)`

### PATH U01 — Unknown follow-up accepted

Trigger: Explicit unknown-question opt-in.

`GLOBAL_UNKNOWN/node_faq → UNKNOWN → node_anything_else`

### PATH U02 — Unknown contact declined

Trigger: Known question; optional name/phone declined.

`node_unknown_collect → node_unknown_save → node_unknown_saved → node_anything_else`

### PATH U03 — Unknown follow-up withdrawn

Trigger: Caller withdraws consent.

`node_unknown_collect → node_anything_else`

### PATH U04 — Unknown save false

Trigger: follow_up_saved not true.

`node_unknown_save → node_unknown_failed → node_anything_else`

### PATH U05 — Unknown no opt-in

Trigger: Caller declines offered follow-up.

`node_initial_faq/node_faq/node_global_faq → answer/resume/return; no save or required personal data`

### PATH U06 — Unknown save outage

Trigger: Current receipt absent/system unavailable.

`node_unknown_save → DOWNTIME`

### PATH H01 — Explicit human request

Trigger: Staff requested at greeting/router/global.

`START_HUMAN/GLOBAL_HUMAN → TRANSFER_GATE → node_transfer_unavailable → HUMAN`

### PATH H02 — Unsupported operation

Trigger: Unsupported operational request.

`GLOBAL_HUMAN → TRANSFER_GATE(not_requested) → HUMAN`

### PATH H03 — Clinic judgment

Trigger: Supported nonclinical escalation category.

`GLOBAL_HUMAN → TRANSFER_GATE(not_requested) → HUMAN`

### PATH H04 — Repeated failure

Trigger: Not a specific booking/calendar/unknown fallback.

`GLOBAL_HUMAN → TRANSFER_GATE → HUMAN`

### PATH H05 — Appointment dispute

Trigger: Staff assistance required.

`GLOBAL_HUMAN → TRANSFER_GATE → HUMAN`

### PATH H06 — Human retention saved

Trigger: Reason known; optional contact supplied/declined.

`HUMAN → node_human_save → node_human_saved → node_anything_else`

### PATH H07 — Human retention rejected

Trigger: follow_up_saved false.

`HUMAN → node_human_save → node_human_failed → node_anything_else`

### PATH H08 — Human request withdrawn

Trigger: Withdrawal before save.

`node_human_collect → node_anything_else`

### PATH H09 — Human save outage

Trigger: No receipt/system unavailable.

`node_human_save → DOWNTIME`

### PATH T01 — Disabled or no destination

Trigger: Current actual production settings.

`TRANSFER_GATE → node_transfer_unavailable → HUMAN`

### PATH T02 — Outside configured hours

Trigger: Trusted hours gate returns after_hours.

`TRANSFER_GATE → node_transfer_after_hours → HUMAN`

### PATH T03 — After-hours declined

Trigger: Caller declines follow-up.

`node_transfer_after_hours → node_anything_else`

### PATH T04 — Eligible single attempt

Trigger: Trusted settings/hours/phone call/atomic claim.

`TRANSFER_GATE → node_transfer_native → provider bridge; currently disabled/unconfigured`

### PATH T05 — Native busy

Trigger: Provider failure.

`node_transfer_native → node_transfer_failed → TRANSFER_SAVE → node_transfer_follow_up_saved → node_anything_else`

### PATH T06 — Native no-answer

Trigger: Provider failure.

`node_transfer_native → node_transfer_failed → TRANSFER_SAVE → node_transfer_follow_up_saved → node_anything_else`

### PATH T07 — Native timeout

Trigger: Provider failure.

`node_transfer_native → node_transfer_failed → TRANSFER_SAVE → node_transfer_follow_up_saved → node_anything_else`

### PATH T08 — Provider technical failure

Trigger: Dial/provider failure.

`node_transfer_native → node_transfer_failed → TRANSFER_SAVE → node_transfer_follow_up_failed → node_anything_else`

### PATH T09 — Prior failure

Trigger: Backend previous_failure, no retry.

`TRANSFER_GATE → TRANSFER_SAVE → node_transfer_follow_up_saved/node_transfer_follow_up_failed`

### PATH T10 — Already attempted pending

Trigger: Reserved attempt without verified bridge.

`TRANSFER_GATE → node_transfer_done → node_end; pending wording`

### PATH T11 — Prior verified bridge

Trigger: Backend recorded success.

`TRANSFER_GATE → node_transfer_done → node_end`

### PATH T12 — Late verified bridge

Trigger: Bridge recorded during fallback decision.

`TRANSFER_SAVE → node_transfer_done → node_end`

### PATH T13 — Follow-up sufficient

Trigger: No direct transfer needed/requested.

`TRANSFER_GATE(not_requested) → HUMAN`

### PATH T14 — Fallback save failed

Trigger: No durable request receipt.

`TRANSFER_SAVE → node_transfer_follow_up_failed → node_anything_else`

### PATH T15 — Transfer wider outage

Trigger: Current receipt absent/system unavailable.

`TRANSFER_GATE/TRANSFER_SAVE → DOWNTIME`

### PATH D01 — Availability dependency failure

Trigger: Calendar retrieval error.

`CHECK/RESCHEDULE_CHECK → CALENDAR`

### PATH D02 — Availability malformed

Trigger: Invalid slots/boolean/ranges.

`CHECK/RESCHEDULE_CHECK → CALENDAR`

### PATH D03 — Availability bounded timeout

Trigger: Backend availability deadline.

`CHECK/RESCHEDULE_CHECK → CALENDAR`

### PATH D04 — Availability transport failure

Trigger: Function no-response/error dispatch.

`CHECK/RESCHEDULE_CHECK → DOWNTIME or CALENDAR; overlapping routing semantics M04`

### PATH D05 — Calendar already retained

Trigger: follow_up_saved true.

`CALENDAR → node_end`

### PATH D06 — Calendar collect and save

Trigger: Caller accepts missing preference collection.

`CALENDAR → node_calendar_collect → node_downtime_prepare_node_calendar_save → node_calendar_save → node_calendar_saved → node_end`

### PATH D07 — Calendar save rejected

Trigger: Retention false.

`node_calendar_save → node_calendar_save_failed → node_end`

### PATH D08 — Calendar declined

Trigger: Caller declines/is finished.

`CALENDAR/node_calendar_collect → node_end`

### PATH D09 — Booking definite rejection

Trigger: Slot/validation/helper failure.

`CREATE → node_book_failed → node_callback_collect → CALLBACK`

### PATH D10 — Booking uncertain failure retried

Trigger: Timeout/exception, outcome not established.

`CREATE → node_book_failed → INVALIDATE_BOOK → fresh CHECK → CREATE; conditional dangerous retry C03`

### PATH D11 — Booking no receipt

Trigger: Current transport result absent.

`CREATE → DOWNTIME`

### PATH D12 — Calendar latch at mutation

Trigger: Backend calendarBlocked response.

`CREATE/RESCHEDULE → node_book_failed/node_reschedule_failed; wrong fallback M09`

### PATH D13 — Creation incomplete fields

Trigger: Invalid intake/tuple at guard.

`node_guard_book/node_intake_entry_node_book → node_reset_failed; empty practitioner-ID guard exception H03`

### PATH D14 — Backend rejects stale token

Trigger: Bad signature/call/clinic/check/expiry/tuple.

`CREATE/RESCHEDULE → node_book_failed/node_reschedule_failed; no successful invalid-token mutation`

### PATH D15 — Post-success cleanup unavailable

Trigger: Verified write then invalidation failure.

`BOOKED/AFTER_SUCCESS → DOWNTIME; prior confirmed operation remains confirmed`

### PATH S01 — Resolver outage

Trigger: No receipt/system unavailable.

`node_resolve → DOWNTIME`

### PATH S02 — Lookup outage

Trigger: No receipt/system unavailable.

`node_lookup/node_lookup_arabic_wait → DOWNTIME`

### PATH S03 — Cancel outage

Trigger: No receipt/system unavailable.

`CANCEL → DOWNTIME`

### PATH S04 — Move outage

Trigger: No receipt/system unavailable.

`RESCHEDULE → DOWNTIME`

### PATH S05 — Legacy save outage

Trigger: Message/callback/urgent receipt missing.

`MESSAGE/CALLBACK/URGENT → DOWNTIME`

### PATH S06 — Specific save outage

Trigger: Calendar/unknown/human/transfer receipt missing.

`SPECIFIC_SAVE → DOWNTIME`

### PATH S07 — Invalidation outage

Trigger: Reset/correction service unavailable.

`INVALIDATE_BOOK/INVALIDATE_RESCHEDULE/RESET → DOWNTIME`

### PATH S08 — Downtime terminal

Trigger: Clear success/IDs, safe unavailable wording.

`node_downtime_clear → node_system_downtime → node_end`

### PATH G01 — Message saved

Trigger: Confirmed message/contact.

`START_MESSAGE/router → node_message_collect → MESSAGE → node_message_saved → node_anything_else`

### PATH G02 — Callback saved

Trigger: Explicit callback request.

`router → node_callback_collect → CALLBACK → node_callback_saved → node_anything_else`

### PATH G03 — Urgent saved

Trigger: Urgent follow-up contact confirmed.

`START_URGENT/GLOBAL_URGENT → node_urgent_collect → URGENT → node_urgent_saved → node_anything_else`

### PATH G04 — Legacy save false

Trigger: Backend success false.

`MESSAGE/CALLBACK/URGENT → node_request_failed → node_anything_else`

### PATH G05 — Legacy contact missing

Trigger: No usable contact/reason.

`node_message_collect/node_callback_collect/node_urgent_collect → wait/reprompt; declined-contact local exit absent M10`

### PATH G06 — Explicit new task at router

Trigger: Caller identifies the new task.

`node_anything_else → RESET/node_existing_identity/node_faq/node_transfer_prepare/message/callback/urgent`

### PATH G07 — Second-request readback unclear

Trigger: Corrected or unconfirmed new request.

`RESET_SECOND → node_new_cycle_readback → node_new_cycle_restate → RESET_SECOND`

### PATH G08 — Normal goodbye

Trigger: Caller finished.

`node_anything_else → node_end`

### PATH G09 — FAQ corrects booking

Trigger: Interrupted new-booking tuple changes.

`node_global_faq → INVALIDATE_BOOK → CORRECT`

### PATH G10 — FAQ corrects reschedule

Trigger: Interrupted existing move changes.

`node_global_faq → INVALIDATE_RESCHEDULE → node_reschedule_details`

## Complete explicit path grammar

Each production below is a single directed step. Starting at greeting, and allowing only applicable global activations and enabled predicates, repeated production selection describes all finite configured paths. Terminal end and successful native bridge end automated handling. Exact sibling/missing-data/bypass/loop annotations are in node-inventory.md under the same edge ID. Conditional dead-end/fault paths are retained for audit; they are not approved behavior.

| Rule | Source → destination | Exact predicate |
|---|---|---|
| E001 / `edge_greeting_book` | `node_greeting` → `node_initial_language` | `{"prompt":"Caller wants a new appointment or only wants to check new appointment availability","type":"prompt"}` |
| E002 / `edge_greeting_existing` | `node_greeting` → `node_initial_language` | `{"prompt":"Caller wants to change or cancel an existing appointment","type":"prompt"}` |
| E003 / `edge_greeting_faq` | `node_greeting` → `node_initial_language` | `{"prompt":"Caller asks a standalone general clinic fact including hours, parking or directions; not appointment availability","type":"prompt"}` |
| E004 / `edge_greeting_message` | `node_greeting` → `node_initial_language` | `{"prompt":"Caller wants to leave a message","type":"prompt"}` |
| E005 / `edge_greeting_urgent` | `node_greeting` → `node_initial_language` | `{"prompt":"Caller reports urgent symptoms or needs urgent staff attention","type":"prompt"}` |
| E006 / `edge_greeting_human` | `node_greeting` → `node_initial_language` | `{"prompt":"Caller asks for a human receptionist","type":"prompt"}` |
| E007 / `edge_service_resolve` | `node_service` → `node_capture_service` | `{"prompt":"The requested service is clear enough to send to service resolver","type":"prompt"}` |
| E008 / `edge_downtime_node_resolve` | `node_resolve` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E009 / `edge_resolve_ok` | `node_resolve` → `node_doctor_preference` | `{"equations":[{"left":"{{resolve_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E010 / `edge_node_resolve_else` | `node_resolve` → `node_service_clarify` | `{"prompt":"Else","type":"prompt"}` |
| E011 / `edge_service_clarified` | `node_service_clarify` → `node_intake_name_capture` | `{"prompt":"Caller clarifies the service","type":"prompt"}` |
| E012 / `edge_doctor_chosen` | `node_doctor_preference` → `node_intake_doctor_capture` | `{"prompt":"A specific doctor preference or any-qualified preference is clear; or only one qualified practitioner exists","type":"prompt"}` |
| E013 / `edge_date_check` | `node_date_time` → `node_capture_search` | `{"prompt":"There is enough information to check: canonical service, doctor preference mode, and date or earliest search mode","type":"prompt"}` |
| E014 / `edge_downtime_node_check` | `node_check` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E015 / `edge_calendar_node_check` | `node_check` → `node_calendar_unavailable` | `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}` |
| E016 / `edge_availability_yes` | `node_check` → `node_offer` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E017 / `edge_availability_no` | `node_check` → `node_no_slots` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E018 / `edge_availability_error` | `node_check` → `node_check_error` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E019 / `edge_calendar_transport_node_check` | `node_check` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E020 / `edge_check_error_retry` | `node_check_error` → `node_invalidate_booking_clear_ack` | `{"prompt":"Caller corrects the request and wants another check","type":"prompt"}` |
| E021 / `edge_check_error_callback` | `node_check_error` → `node_callback_collect` | `{"prompt":"Caller requests staff follow-up","type":"prompt"}` |
| E022 / `edge_no_slots_change` | `node_no_slots` → `node_invalidate_booking_clear_ack` | `{"prompt":"Caller changes doctor, service, date, time or flexibility","type":"prompt"}` |
| E023 / `edge_no_slots_end` | `node_no_slots` → `node_anything_else` | `{"prompt":"Caller does not want to continue checking","type":"prompt"}` |
| E024 / `edge_offer_separate_booking` | `node_offer` → `node_reset_prepare` | `{"prompt":"Caller explicitly sets aside or abandons these slots and asks to start a separate NEW appointment or new availability task. This is a new booking cycle, not a parameter correction.","type":"prompt"}` |
| E025 / `edge_offer_select` | `node_offer` → `node_capture_slot` | `{"prompt":"Caller chooses or attempts to choose a local time from the checked availability result, even if speech is slightly ambiguous. A slot choice is booking intent; do not ask for booking intent again. A clearly different service, doctor or date uses correction.","type":"prompt"}` |
| E026 / `edge_offer_change` | `node_offer` → `node_correction_clear_candidate` | `{"prompt":"Caller asks about, corrects, or ambiguously refers to a service, doctor, date, requested time, window, or search mode of the SAME booking, without selecting an exact offered slot. Assess ONLY the latest caller utterance before invalidating anything. Exclude a separate new booking, a decline/goodbye, patient/contact detail, final consent, clinic fact or exact slot selection.","type":"prompt"}` |
| E027 / `edge_offer_inquiry` | `node_offer` → `node_anything_else` | `{"prompt":"Caller clearly declines to book from these slots, only wanted availability, or is finished; not asking to correct the SAME booking's parameters.","type":"prompt"}` |
| E028 / `edge_patient_done` | `node_patient` → `node_intake_contact_capture` | `{"prompt":"Current patient name and confirmed usable contact are established; preserve details already supplied in this booking request","type":"prompt"}` |
| E029 / `edge_patient_change` | `node_patient` → `node_invalidate_booking_clear_ack` | `{"prompt":"Caller changes service, doctor, date or time","type":"prompt"}` |
| E030 / `edge_final_change` | `node_final` → `node_invalidate_booking_clear_ack` | `{"prompt":"Caller corrects a detail of THIS current appointment or selects another current slot. Exclude a separate additional appointment requested AFTER affirming this exact current readback; that is current consent plus a queued new task, not a correction.","type":"prompt"}` |
| E031 / `edge_final_yes` | `node_final` → `node_capture_consent` | `{"prompt":"Caller explicitly affirms booking the exact current just-read patient/service/practitioner/date/time with NO corrections to it. This includes an affirmation followed by a separate additional future appointment request. Book this current tuple first; handle the separate request through Anything Else and fresh reset afterward.","type":"prompt"}` |
| E032 / `edge_final_no` | `node_final` → `node_anything_else` | `{"prompt":"Caller declines booking","type":"prompt"}` |
| E033 / `edge_downtime_node_book` | `node_book` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E034 / `edge_book_success` | `node_book` → `node_booked` | `{"equations":[{"left":"{{booking_success}}","operator":"==","right":"true"},{"left":"{{appointment_booked}}","operator":"==","right":"true"},{"left":"{{booking_id}}","operator":"!=","right":""}],"operator":"&&","type":"equation"}` |
| E035 / `edge_node_book_else` | `node_book` → `node_book_failed` | `{"prompt":"Else","type":"prompt"}` |
| E036 / `edge_node_booked_always` | `node_booked` → `node_downtime_prepare_node_invalidate_after_book` | `{"prompt":"Always","type":"prompt"}` |
| E037 / `edge_book_failed_retry` | `node_book_failed` → `node_invalidate_booking_clear_ack` | `{"prompt":"Caller wants fresh availability or corrects details","type":"prompt"}` |
| E038 / `edge_book_failed_callback` | `node_book_failed` → `node_callback_collect` | `{"prompt":"Caller wants staff follow-up","type":"prompt"}` |
| E039 / `edge_downtime_node_invalidate_booking` | `node_invalidate_booking` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E040 / `edge_node_invalidate_booking_confirmed` | `node_invalidate_booking` → `node_clear_correction` | `{"equations":[{"left":"{{availability_invalidated}}","operator":"==","right":"true"},{"left":"{{invalidation_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E041 / `edge_node_invalidate_booking_failure` | `node_invalidate_booking` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E042 / `edge_change_service_resolve` | `node_change_booking` → `node_capture_service` | `{"prompt":"The SERVICE changed, so resolve the new service and reassess doctor qualification","type":"prompt"}` |
| E043 / `edge_change_doctor_clarify` | `node_change_booking` → `node_doctor_preference` | `{"prompt":"Doctor preference was changed or is missing or ambiguous and must be clarified","type":"prompt"}` |
| E044 / `edge_change_date_time_clarify` | `node_change_booking` → `node_intake_before_time_clear` | `{"prompt":"Only date or time changed, but the new date or time preference is still incomplete; preserve the same canonical service and doctor","type":"prompt"}` |
| E045 / `edge_change_recheck` | `node_change_booking` → `node_capture_search` | `{"prompt":"Only date/time/window changed and final values are clear, or a new specific doctor was clearly named; preserve the service and established doctor mode, use the new doctor only when explicitly changed, and check fresh availability","type":"prompt"}` |
| E046 / `edge_downtime_node_invalidate_after_book` | `node_invalidate_after_book` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E047 / `edge_node_invalidate_after_book_always` | `node_invalidate_after_book` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E048 / `edge_existing_lookup` | `node_existing_identity` → `node_lookup_wait_language_gate` | `{"prompt":"Patient name and phone were clearly provided and confirmed","type":"prompt"}` |
| E049 / `edge_downtime_node_lookup` | `node_lookup` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E050 / `edge_lookup_found` | `node_lookup` → `node_select_existing` | `{"equations":[{"left":"{{lookup_success}}","operator":"==","right":"true"},{"left":"{{appointment_count}}","operator":">","right":"0"}],"operator":"&&","type":"equation"}` |
| E051 / `edge_lookup_none` | `node_lookup` → `node_existing_not_found` | `{"equations":[{"left":"{{lookup_success}}","operator":"==","right":"true"},{"left":"{{appointment_count}}","operator":"==","right":"0"}],"operator":"&&","type":"equation"}` |
| E052 / `edge_node_lookup_else` | `node_lookup` → `node_tool_failure` | `{"prompt":"Else","type":"prompt"}` |
| E053 / `edge_existing_retry` | `node_existing_not_found` → `node_existing_identity` | `{"prompt":"Caller corrects identifying details","type":"prompt"}` |
| E054 / `edge_existing_callback` | `node_existing_not_found` → `node_callback_collect` | `{"prompt":"Caller requests staff follow-up","type":"prompt"}` |
| E055 / `edge_existing_reschedule` | `node_select_existing` → `node_reschedule_details` | `{"prompt":"One exact existing appointment is identified and caller wants to change it","type":"prompt"}` |
| E056 / `edge_existing_cancel` | `node_select_existing` → `node_cancel_confirm` | `{"prompt":"One exact existing appointment is identified and caller wants to cancel it","type":"prompt"}` |
| E057 / `edge_reschedule_check` | `node_reschedule_details` → `node_reschedule_check_wait_language_gate` | `{"prompt":"Final service, doctor preference and new date/time or earliest search are clear","type":"prompt"}` |
| E058 / `edge_downtime_node_reschedule_check` | `node_reschedule_check` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E059 / `edge_calendar_node_reschedule_check` | `node_reschedule_check` → `node_calendar_unavailable` | `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}` |
| E060 / `edge_reschedule_available` | `node_reschedule_check` → `node_reschedule_offer` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E061 / `edge_reschedule_unavailable` | `node_reschedule_check` → `node_reschedule_no_slots` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E062 / `edge_reschedule_check_error` | `node_reschedule_check` → `node_reschedule_check_error` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E063 / `edge_calendar_transport_node_reschedule_check` | `node_reschedule_check` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E064 / `edge_reschedule_error_retry` | `node_reschedule_check_error` → `node_invalidate_reschedule_clear_ack` | `{"prompt":"Caller corrects the new request","type":"prompt"}` |
| E065 / `edge_reschedule_error_callback` | `node_reschedule_check_error` → `node_callback_collect` | `{"prompt":"Caller wants staff follow-up","type":"prompt"}` |
| E066 / `edge_reschedule_no_change` | `node_reschedule_no_slots` → `node_invalidate_reschedule_clear_ack` | `{"prompt":"Caller offers different reschedule details","type":"prompt"}` |
| E067 / `edge_reschedule_keep` | `node_reschedule_no_slots` → `node_anything_else` | `{"prompt":"Caller keeps the original appointment","type":"prompt"}` |
| E068 / `edge_reschedule_offer_change` | `node_reschedule_offer` → `node_invalidate_reschedule_clear_ack` | `{"prompt":"Caller changes service, doctor, date, time, window or selected slot","type":"prompt"}` |
| E069 / `edge_reschedule_offer_choose` | `node_reschedule_offer` → `node_reschedule_final` | `{"prompt":"Caller selects one exact returned new slot","type":"prompt"}` |
| E070 / `edge_reschedule_offer_keep` | `node_reschedule_offer` → `node_anything_else` | `{"prompt":"Caller keeps original appointment","type":"prompt"}` |
| E071 / `edge_reschedule_final_change` | `node_reschedule_final` → `node_invalidate_reschedule_clear_ack` | `{"prompt":"Caller changes any reschedule detail","type":"prompt"}` |
| E072 / `edge_reschedule_final_yes` | `node_reschedule_final` → `node_reschedule_tool_wait_language_gate` | `{"prompt":"Caller clearly confirms moving this exact appointment to the selected verified slot","type":"prompt"}` |
| E073 / `edge_reschedule_final_no` | `node_reschedule_final` → `node_anything_else` | `{"prompt":"Caller declines and keeps original appointment","type":"prompt"}` |
| E074 / `edge_downtime_node_reschedule_tool` | `node_reschedule_tool` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E075 / `edge_reschedule_success` | `node_reschedule_tool` → `node_rescheduled` | `{"equations":[{"left":"{{reschedule_success}}","operator":"==","right":"true"},{"left":"{{rescheduled_id}}","operator":"exists"}],"operator":"&&","type":"equation"}` |
| E076 / `edge_node_reschedule_tool_else` | `node_reschedule_tool` → `node_reschedule_failed` | `{"prompt":"Else","type":"prompt"}` |
| E077 / `edge_node_rescheduled_always` | `node_rescheduled` → `node_downtime_prepare_node_invalidate_after_book` | `{"prompt":"Always","type":"prompt"}` |
| E078 / `edge_reschedule_failed_retry` | `node_reschedule_failed` → `node_invalidate_reschedule_clear_ack` | `{"prompt":"Caller wants to try another new slot","type":"prompt"}` |
| E079 / `edge_reschedule_failed_callback` | `node_reschedule_failed` → `node_callback_collect` | `{"prompt":"Caller requests staff follow-up","type":"prompt"}` |
| E080 / `edge_downtime_node_invalidate_reschedule` | `node_invalidate_reschedule` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E081 / `edge_node_invalidate_reschedule_confirmed` | `node_invalidate_reschedule` → `node_reschedule_details` | `{"equations":[{"left":"{{availability_invalidated}}","operator":"==","right":"true"},{"left":"{{invalidation_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E082 / `edge_node_invalidate_reschedule_failure` | `node_invalidate_reschedule` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E083 / `edge_cancel_yes` | `node_cancel_confirm` → `node_cancel_tool_wait_language_gate` | `{"prompt":"Caller explicitly confirms cancellation of that exact selected appointment","type":"prompt"}` |
| E084 / `edge_cancel_no` | `node_cancel_confirm` → `node_anything_else` | `{"prompt":"Caller declines cancellation","type":"prompt"}` |
| E085 / `edge_downtime_node_cancel_tool` | `node_cancel_tool` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E086 / `edge_cancel_success` | `node_cancel_tool` → `node_cancelled` | `{"equations":[{"left":"{{cancel_success}}","operator":"==","right":"true"},{"left":"{{cancelled_id}}","operator":"exists"}],"operator":"&&","type":"equation"}` |
| E087 / `edge_node_cancel_tool_else` | `node_cancel_tool` → `node_cancel_failed` | `{"prompt":"Else","type":"prompt"}` |
| E088 / `edge_node_cancelled_always` | `node_cancelled` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E089 / `edge_cancel_retry` | `node_cancel_failed` → `node_existing_identity` | `{"prompt":"Caller wants to correct patient details","type":"prompt"}` |
| E090 / `edge_cancel_callback` | `node_cancel_failed` → `node_callback_collect` | `{"prompt":"Caller wants staff follow-up","type":"prompt"}` |
| E091 / `edge_faq_unknown_follow_up` | `node_faq` → `node_unknown_prepare` | `{"prompt":"Caller explicitly requests or accepts clinic follow-up about the factual question that Apero could not answer from configured information. Not a general human request, urgent request, booking problem, calendar failure, or ambiguous yes.","type":"prompt"}` |
| E092 / `edge_node_faq_human` | `node_faq` → `node_transfer_prepare` | `{"prompt":"Caller explicitly requests direct human or clinic staff assistance. Exclude specific unknown-information follow-up, failed booking and calendar unavailable follow-up; keep those specific routes.","type":"prompt"}` |
| E093 / `edge_faq_urgent` | `node_faq` → `node_urgent_collect` | `{"prompt":"Caller reports urgent symptoms or requests urgent staff follow-up","type":"prompt"}` |
| E094 / `edge_faq_booking` | `node_faq` → `node_reset_prepare` | `{"prompt":"The LATEST caller turn explicitly requests a separate NEW appointment or NEW appointment availability task that has NOT already been processed, including 'I'd like to book a consultation', 'When is the next consultation available?' or 'Can I see Dr. Ahmed tomorrow?'. Not resuming or selecting the SAME offered slot of the interrupted task, an old fulfilled request in conversation history, an unclear yes, consent to a read-back, a factual clinic question, or a change/cancellation of an existing appointment.","type":"prompt"}` |
| E095 / `edge_faq_existing` | `node_faq` → `node_existing_identity` | `{"prompt":"Caller wants to look up, change, reschedule or cancel an existing appointment","type":"prompt"}` |
| E096 / `edge_faq_callback` | `node_faq` → `node_callback_collect` | `{"prompt":"Caller explicitly requests only a callback; not a request for direct human assistance or unknown-information follow-up","type":"prompt"}` |
| E097 / `edge_faq_message` | `node_faq` → `node_message_collect` | `{"prompt":"Caller wants to leave a message for staff","type":"prompt"}` |
| E098 / `edge_faq_unspecified_request` | `node_faq` → `node_anything_else` | `{"prompt":"The most recent factual question is answered and caller says yes, needs something else, or has another request WITHOUT identifying what they need","type":"prompt"}` |
| E099 / `edge_faq_done` | `node_faq` → `node_anything_else` | `{"prompt":"The factual question has been answered and there is no outstanding new booking, availability, existing appointment or staff request","type":"prompt"}` |
| E100 / `edge_global_faq_reschedule_change` | `node_global_faq` → `node_invalidate_reschedule_clear_ack` | `{"prompt":"Caller corrects service, practitioner, date or time of the SAME reschedule task that was interrupted","type":"prompt"}` |
| E101 / `edge_global_faq_booking_change` | `node_global_faq` → `node_invalidate_booking_clear_ack` | `{"prompt":"Caller corrects service, practitioner, date or time of the SAME new-booking task that was interrupted, not a separate new appointment","type":"prompt"}` |
| E102 / `edge_global_faq_urgent` | `node_global_faq` → `node_urgent_collect` | `{"prompt":"Caller reports urgent symptoms or requests urgent staff follow-up","type":"prompt"}` |
| E103 / `edge_global_faq_booking` | `node_global_faq` → `node_reset_prepare` | `{"prompt":"The LATEST caller turn explicitly requests a separate NEW appointment or NEW appointment availability task that has NOT already been processed, including 'I'd like to book a consultation', 'When is the next consultation available?' or 'Can I see Dr. Ahmed tomorrow?'. Not resuming or selecting the SAME offered slot of the interrupted task, an old fulfilled request in conversation history, an unclear yes, consent to a read-back, a factual clinic question, or a change/cancellation of an existing appointment.","type":"prompt"}` |
| E104 / `edge_global_faq_existing` | `node_global_faq` → `node_existing_identity` | `{"prompt":"Caller wants to look up, change, reschedule or cancel an existing appointment","type":"prompt"}` |
| E105 / `edge_global_faq_callback` | `node_global_faq` → `node_callback_collect` | `{"prompt":"Caller explicitly requests only a callback; not a request for direct human assistance or unknown-information follow-up","type":"prompt"}` |
| E106 / `edge_global_faq_message` | `node_global_faq` → `node_message_collect` | `{"prompt":"Caller wants to leave a message for staff","type":"prompt"}` |
| E107 / `edge_node_global_urgent_always` | `node_global_urgent` → `node_urgent_collect` | `{"prompt":"Always","type":"prompt"}` |
| E108 / `edge_node_global_human_always` | `node_global_human` → `node_transfer_prepare` | `{"prompt":"Always","type":"prompt"}` |
| E109 / `edge_message_submit` | `node_message_collect` → `node_downtime_prepare_node_message_tool` | `{"prompt":"Caller confirms message and contact details","type":"prompt"}` |
| E110 / `edge_downtime_node_message_tool` | `node_message_tool` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E111 / `edge_message_saved` | `node_message_tool` → `node_message_saved` | `{"equations":[{"left":"{{message_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E112 / `edge_node_message_tool_else` | `node_message_tool` → `node_request_failed` | `{"prompt":"Else","type":"prompt"}` |
| E113 / `edge_node_message_saved_always` | `node_message_saved` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E114 / `edge_callback_submit` | `node_callback_collect` → `node_downtime_prepare_node_callback_tool` | `{"prompt":"Callback details confirmed","type":"prompt"}` |
| E115 / `edge_downtime_node_callback_tool` | `node_callback_tool` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E116 / `edge_callback_saved` | `node_callback_tool` → `node_callback_saved` | `{"equations":[{"left":"{{callback_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E117 / `edge_node_callback_tool_else` | `node_callback_tool` → `node_request_failed` | `{"prompt":"Else","type":"prompt"}` |
| E118 / `edge_node_callback_saved_always` | `node_callback_saved` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E119 / `edge_urgent_submit` | `node_urgent_collect` → `node_downtime_prepare_node_urgent_tool` | `{"prompt":"Urgent callback phone and reason confirmed","type":"prompt"}` |
| E120 / `edge_downtime_node_urgent_tool` | `node_urgent_tool` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E121 / `edge_urgent_saved` | `node_urgent_tool` → `node_urgent_saved` | `{"equations":[{"left":"{{urgent_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E122 / `edge_node_urgent_tool_else` | `node_urgent_tool` → `node_request_failed` | `{"prompt":"Else","type":"prompt"}` |
| E123 / `edge_node_urgent_saved_always` | `node_urgent_saved` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E124 / `edge_node_request_failed_always` | `node_request_failed` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E125 / `edge_tool_failure_callback` | `node_tool_failure` → `node_callback_collect` | `{"prompt":"Caller accepts staff callback","type":"prompt"}` |
| E126 / `edge_tool_failure_end` | `node_tool_failure` → `node_anything_else` | `{"prompt":"Caller declines callback","type":"prompt"}` |
| E127 / `edge_node_anything_else_human` | `node_anything_else` → `node_transfer_prepare` | `{"prompt":"Caller explicitly requests direct human or clinic staff assistance. Exclude specific unknown-information follow-up, failed booking and calendar unavailable follow-up; keep those specific routes.","type":"prompt"}` |
| E128 / `edge_anything_urgent` | `node_anything_else` → `node_urgent_collect` | `{"prompt":"Caller reports urgent symptoms or requests urgent staff follow-up","type":"prompt"}` |
| E129 / `edge_anything_booking` | `node_anything_else` → `node_reset_prepare` | `{"prompt":"The LATEST caller turn explicitly requests a separate NEW appointment or NEW appointment availability task that has NOT already been processed, including 'I'd like to book a consultation', 'When is the next consultation available?' or 'Can I see Dr. Ahmed tomorrow?'. Not resuming or selecting the SAME offered slot of the interrupted task, an old fulfilled request in conversation history, an unclear yes, consent to a read-back, a factual clinic question, or a change/cancellation of an existing appointment.","type":"prompt"}` |
| E130 / `edge_anything_existing` | `node_anything_else` → `node_existing_identity` | `{"prompt":"Caller wants to look up, change, reschedule or cancel an existing appointment","type":"prompt"}` |
| E131 / `edge_anything_callback` | `node_anything_else` → `node_callback_collect` | `{"prompt":"Caller explicitly requests only a callback; not a request for direct human assistance or unknown-information follow-up","type":"prompt"}` |
| E132 / `edge_anything_message` | `node_anything_else` → `node_message_collect` | `{"prompt":"Caller wants to leave a message for staff","type":"prompt"}` |
| E133 / `edge_anything_faq` | `node_anything_else` → `node_faq` | `{"prompt":"Caller asks a general clinic fact such as hours, parking, directions, price or insurance; not appointment availability","type":"prompt"}` |
| E134 / `edge_anything_no` | `node_anything_else` → `node_end` | `{"prompt":"Caller is finished","type":"prompt"}` |
| E135 / `edge_reset_prepared` | `node_reset_prepare` → `node_fresh_request` | `{"equations":[{"left":"{{reset_prepared}}","operator":"==","right":"true"},{"left":"{{reset_ready}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E136 / `edge_node_reset_prepare_failure` | `node_reset_prepare` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E137 / `edge_fresh_request_captured` | `node_fresh_request` → `node_reset_language_gate` | `{"equations":[{"left":"{{fresh_request_present}}","operator":"==","right":"true"},{"left":"{{fresh_request_summary}}","operator":"!=","right":""}],"operator":"&&","type":"equation"}` |
| E138 / `edge_node_fresh_request_failure` | `node_fresh_request` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E139 / `edge_downtime_node_reset_invalidate` | `node_reset_invalidate` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E140 / `edge_reset_invalidated` | `node_reset_invalidate` → `node_reset_verify` | `{"equations":[{"left":"{{availability_invalidated}}","operator":"==","right":"true"},{"left":"{{invalidation_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E141 / `edge_node_reset_invalidate_failure` | `node_reset_invalidate` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E142 / `edge_reset_verified` | `node_reset_verify` → `node_intake_name_capture` | `{"equations":[{"left":"{{reset_ready}}","operator":"==","right":"true"},{"left":"{{reset_verified_attempt}}","operator":"==","right":"{{reset_attempt}}"},{"left":"{{first_cycle_proven}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E143 / `edge_full_cycle_request_readback` | `node_reset_verify` → `node_new_cycle_readback` | `{"equations":[{"left":"{{reset_ready}}","operator":"==","right":"true"},{"left":"{{reset_verified_attempt}}","operator":"==","right":"{{reset_attempt}}"},{"left":"{{first_cycle_proven}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E144 / `edge_node_reset_verify_failure` | `node_reset_verify` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E145 / `edge_reset_retry` | `node_reset_failed` → `node_reset_prepare` | `{"prompt":"Caller explicitly restates the NEW booking/availability request for a retry, not just yes","type":"prompt"}` |
| E146 / `edge_reset_callback` | `node_reset_failed` → `node_callback_collect` | `{"prompt":"Caller accepts staff callback","type":"prompt"}` |
| E147 / `edge_reset_finished` | `node_reset_failed` → `node_end` | `{"prompt":"Caller is finished or declines follow-up","type":"prompt"}` |
| E148 / `edge_proven_first_language_kept` | `node_reset_language_gate` → `node_reset_verify` | `{"equations":[{"left":"{{language_known}}","operator":"==","right":"true"},{"left":"{{first_cycle_proven}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E149 / `edge_language_kept` | `node_reset_language_gate` → `node_reset_invalidate_clear_ack` | `{"equations":[{"left":"{{language_known}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E150 / `edge_language_missing` | `node_reset_language_gate` → `node_reset_language_capture` | `{"equations":[{"left":"{{language_initialization_allowed}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E151 / `edge_node_reset_language_gate_failure` | `node_reset_language_gate` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E152 / `edge_proven_first_language_initialized` | `node_reset_language_capture` → `node_reset_verify` | `{"equations":[{"left":"{{first_cycle_proven}}","operator":"==","right":"true"},{"left":"{{fresh_request_language}}","operator":"!=","right":""}],"operator":"&&","type":"equation"}` |
| E153 / `edge_language_initialized` | `node_reset_language_capture` → `node_reset_invalidate_clear_ack` | `{"equations":[{"left":"{{fresh_request_language}}","operator":"!=","right":""}],"operator":"&&","type":"equation"}` |
| E154 / `edge_node_reset_language_capture_failure` | `node_reset_language_capture` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E155 / `initial_language_edge_greeting_book` | `node_initial_language` → `node_first_booking_provenance` | `{"prompt":"Caller wants a new appointment or only wants to check new appointment availability","type":"prompt"}` |
| E156 / `initial_language_edge_greeting_existing` | `node_initial_language` → `node_existing_identity` | `{"prompt":"Caller wants to change or cancel an existing appointment","type":"prompt"}` |
| E157 / `initial_language_edge_greeting_faq` | `node_initial_language` → `node_initial_faq` | `{"prompt":"Caller asks a standalone general clinic fact including hours, parking or directions; not appointment availability","type":"prompt"}` |
| E158 / `initial_language_edge_greeting_message` | `node_initial_language` → `node_message_collect` | `{"prompt":"Caller wants to leave a message","type":"prompt"}` |
| E159 / `initial_language_edge_greeting_urgent` | `node_initial_language` → `node_urgent_collect` | `{"prompt":"Caller reports urgent symptoms or needs urgent staff attention","type":"prompt"}` |
| E160 / `initial_language_edge_greeting_human` | `node_initial_language` → `node_transfer_prepare` | `{"prompt":"Caller asks for a human receptionist","type":"prompt"}` |
| E161 / `initial_language_else` | `node_initial_language` → `node_anything_else` | `{"prompt":"Else","type":"prompt"}` |
| E162 / `edge_node_capture_service` | `node_capture_service` → `node_guard_service_clear_result` | `{"prompt":"Always","type":"prompt"}` |
| E163 / `edge_node_capture_service_failure` | `node_capture_service` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E164 / `edge_node_guard_service` | `node_guard_service` → `node_downtime_prepare_node_resolve` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E165 / `edge_node_guard_service_failure` | `node_guard_service` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E166 / `edge_node_capture_search` | `node_capture_search` → `node_guard_search_clear_result` | `{"prompt":"Always","type":"prompt"}` |
| E167 / `edge_node_capture_search_failure` | `node_capture_search` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E168 / `edge_node_guard_search` | `node_guard_search` → `node_check_wait_language_gate` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E169 / `edge_node_guard_search_failure` | `node_guard_search` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E170 / `edge_capture_local_slot_match` | `node_capture_slot` → `node_match_slot` | `{"prompt":"Always","type":"prompt"}` |
| E171 / `edge_node_capture_slot_failure` | `node_capture_slot` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E172 / `edge_node_guard_slot` | `node_guard_slot` → `node_capture_patient` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E173 / `edge_node_guard_slot_failure` | `node_guard_slot` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E174 / `edge_node_capture_patient` | `node_capture_patient` → `node_guard_patient_clear_result` | `{"prompt":"Always","type":"prompt"}` |
| E175 / `edge_node_capture_patient_failure` | `node_capture_patient` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E176 / `edge_node_guard_patient` | `node_guard_patient` → `node_final` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E177 / `edge_node_guard_patient_failure` | `node_guard_patient` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E178 / `edge_node_capture_consent` | `node_capture_consent` → `node_guard_book_clear_result` | `{"prompt":"Always","type":"prompt"}` |
| E179 / `edge_node_capture_consent_failure` | `node_capture_consent` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E180 / `edge_node_guard_book` | `node_guard_book` → `node_book_wait_language_gate` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E181 / `edge_node_guard_book_failure` | `node_guard_book` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E182 / `edge_node_guard_service_clear_result` | `node_guard_service_clear_result` → `node_guard_service` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E183 / `edge_node_guard_service_clear_result_failure` | `node_guard_service_clear_result` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E184 / `edge_node_guard_search_clear_result` | `node_guard_search_clear_result` → `node_guard_search` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E185 / `edge_node_guard_search_clear_result_failure` | `node_guard_search_clear_result` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E186 / `edge_node_guard_slot_clear_result` | `node_guard_slot_clear_result` → `node_guard_slot` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E187 / `edge_node_guard_slot_clear_result_failure` | `node_guard_slot_clear_result` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E188 / `edge_node_guard_patient_clear_result` | `node_guard_patient_clear_result` → `node_guard_patient` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E189 / `edge_node_guard_patient_clear_result_failure` | `node_guard_patient_clear_result` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E190 / `edge_node_guard_book_clear_result` | `node_guard_book_clear_result` → `node_guard_book` | `{"equations":[{"left":"{{stage_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E191 / `edge_node_guard_book_clear_result_failure` | `node_guard_book_clear_result` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E192 / `edge_correction_cleared` | `node_clear_correction` → `node_change_booking` | `{"prompt":"Always","type":"prompt"}` |
| E193 / `edge_node_clear_correction_failure` | `node_clear_correction` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E194 / `edge_node_reset_invalidate_clear_ack` | `node_reset_invalidate_clear_ack` → `node_downtime_prepare_node_reset_invalidate` | `{"prompt":"Always","type":"prompt"}` |
| E195 / `edge_node_reset_invalidate_clear_ack_failure` | `node_reset_invalidate_clear_ack` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E196 / `edge_node_invalidate_booking_clear_ack` | `node_invalidate_booking_clear_ack` → `node_downtime_prepare_node_invalidate_booking` | `{"prompt":"Always","type":"prompt"}` |
| E197 / `edge_node_invalidate_booking_clear_ack_failure` | `node_invalidate_booking_clear_ack` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E198 / `edge_node_invalidate_reschedule_clear_ack` | `node_invalidate_reschedule_clear_ack` → `node_downtime_prepare_node_invalidate_reschedule` | `{"prompt":"Always","type":"prompt"}` |
| E199 / `edge_node_invalidate_reschedule_clear_ack_failure` | `node_invalidate_reschedule_clear_ack` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E200 / `edge_first_provenance_prepare` | `node_first_booking_provenance` → `node_reset_prepare` | `{"prompt":"Always","type":"prompt"}` |
| E201 / `edge_node_first_booking_provenance_failure` | `node_first_booking_provenance` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E202 / `edge_node_initial_faq_human` | `node_initial_faq` → `node_transfer_prepare` | `{"prompt":"Caller explicitly requests direct human or clinic staff assistance. Exclude specific unknown-information follow-up, failed booking and calendar unavailable follow-up; keep those specific routes.","type":"prompt"}` |
| E203 / `edge_faq_urgent_initial` | `node_initial_faq` → `node_urgent_collect` | `{"prompt":"Caller reports urgent symptoms or requests urgent staff follow-up","type":"prompt"}` |
| E204 / `edge_faq_booking_initial` | `node_initial_faq` → `node_first_booking_provenance` | `{"prompt":"The LATEST caller turn explicitly requests a separate NEW appointment or NEW appointment availability task that has NOT already been processed, including 'I'd like to book a consultation', 'When is the next consultation available?' or 'Can I see Dr. Ahmed tomorrow?'. Not resuming or selecting the SAME offered slot of the interrupted task, an old fulfilled request in conversation history, an unclear yes, consent to a read-back, a factual clinic question, or a change/cancellation of an existing appointment.","type":"prompt"}` |
| E205 / `edge_faq_existing_initial` | `node_initial_faq` → `node_existing_identity` | `{"prompt":"Caller wants to look up, change, reschedule or cancel an existing appointment","type":"prompt"}` |
| E206 / `edge_faq_callback_initial` | `node_initial_faq` → `node_callback_collect` | `{"prompt":"Caller explicitly requests only a callback; not a request for direct human assistance or unknown-information follow-up","type":"prompt"}` |
| E207 / `edge_faq_message_initial` | `node_initial_faq` → `node_message_collect` | `{"prompt":"Caller wants to leave a message for staff","type":"prompt"}` |
| E208 / `edge_faq_unspecified_request_initial` | `node_initial_faq` → `node_anything_else` | `{"prompt":"The most recent factual question is answered and caller says yes, needs something else, or has another request WITHOUT identifying what they need","type":"prompt"}` |
| E209 / `edge_faq_done_initial` | `node_initial_faq` → `node_anything_else` | `{"prompt":"The factual question has been answered and there is no outstanding new booking, availability, existing appointment or staff request","type":"prompt"}` |
| E210 / `edge_correction_candidate_cleared` | `node_correction_clear_candidate` → `node_correction_capture` | `{"prompt":"Always","type":"prompt"}` |
| E211 / `edge_node_correction_clear_candidate_failure` | `node_correction_clear_candidate` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E212 / `edge_correction_captured` | `node_correction_capture` → `node_correction_guard` | `{"prompt":"Always","type":"prompt"}` |
| E213 / `edge_node_correction_capture_failure` | `node_correction_capture` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E214 / `edge_correction_same` | `node_correction_guard` → `node_offer` | `{"equations":[{"left":"{{correction_decision}}","operator":"==","right":"same"}],"operator":"&&","type":"equation"}` |
| E215 / `edge_correction_changed` | `node_correction_guard` → `node_invalidate_booking_clear_ack` | `{"equations":[{"left":"{{correction_decision}}","operator":"==","right":"changed"}],"operator":"&&","type":"equation"}` |
| E216 / `edge_correction_refresh` | `node_correction_guard` → `node_invalidate_booking_clear_ack` | `{"equations":[{"left":"{{correction_decision}}","operator":"==","right":"refresh"}],"operator":"&&","type":"equation"}` |
| E217 / `edge_correction_clarify` | `node_correction_guard` → `node_correction_clarify` | `{"equations":[{"left":"{{correction_decision}}","operator":"==","right":"clarify"}],"operator":"&&","type":"equation"}` |
| E218 / `edge_node_correction_guard_failure` | `node_correction_guard` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E219 / `edge_correction_separate_booking` | `node_correction_clarify` → `node_reset_prepare` | `{"prompt":"Caller explicitly abandons or sets aside this appointment and requests a separate NEW booking or new availability task. Start the full v4 reset; this is a second or abandoned booking cycle, never a correction to the old one.","type":"prompt"}` |
| E220 / `edge_correction_declines` | `node_correction_clarify` → `node_anything_else` | `{"prompt":"Caller declines this booking or says they are finished, without giving a new scheduling clarification.","type":"prompt"}` |
| E221 / `edge_correction_clarified` | `node_correction_clarify` → `node_correction_clear_candidate` | `{"prompt":"Caller gives an explicit clarification of the SAME booking's service, doctor, date, time, window or search mode; not a separate new booking, patient/contact detail, decline or goodbye.","type":"prompt"}` |
| E222 / `edge_downtime_node_check_arabic_wait` | `node_check_arabic_wait` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E223 / `edge_calendar_node_check_arabic_wait` | `node_check_arabic_wait` → `node_calendar_unavailable` | `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}` |
| E224 / `edge_availability_yes_arabic_wait` | `node_check_arabic_wait` → `node_offer` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E225 / `edge_availability_no_arabic_wait` | `node_check_arabic_wait` → `node_no_slots` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E226 / `edge_availability_error_arabic_wait` | `node_check_arabic_wait` → `node_check_error` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E227 / `edge_calendar_transport_node_check_arabic_wait` | `node_check_arabic_wait` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E228 / `edge_node_check_wait_language_gate_english` | `node_check_wait_language_gate` → `node_calendar_prepare_node_check` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"English"},{"left":"{{wait_filler_decision}}","operator":"==","right":"speak"}],"operator":"&&","type":"equation"}` |
| E229 / `edge_node_check_wait_language_gate_arabic` | `node_check_wait_language_gate` → `node_calendar_prepare_node_check_arabic_wait` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"Arabic"},{"left":"{{wait_filler_decision}}","operator":"==","right":"speak"}],"operator":"&&","type":"equation"}` |
| E230 / `edge_availability_same_episode_silent` | `node_check_wait_language_gate` → `node_calendar_prepare_node_check_silent` | `{"equations":[{"left":"{{wait_filler_decision}}","operator":"==","right":"silent"}],"operator":"&&","type":"equation"}` |
| E231 / `edge_node_check_wait_language_gate_failure` | `node_check_wait_language_gate` → `node_tool_failure` | `{"prompt":"Else","type":"prompt"}` |
| E232 / `edge_downtime_node_reschedule_check_arabic_wait` | `node_reschedule_check_arabic_wait` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E233 / `edge_calendar_node_reschedule_check_arabic_wait` | `node_reschedule_check_arabic_wait` → `node_calendar_unavailable` | `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}` |
| E234 / `edge_reschedule_available_arabic_wait` | `node_reschedule_check_arabic_wait` → `node_reschedule_offer` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E235 / `edge_reschedule_unavailable_arabic_wait` | `node_reschedule_check_arabic_wait` → `node_reschedule_no_slots` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E236 / `edge_reschedule_check_error_arabic_wait` | `node_reschedule_check_arabic_wait` → `node_reschedule_check_error` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E237 / `edge_calendar_transport_node_reschedule_check_arabic_wait` | `node_reschedule_check_arabic_wait` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E238 / `edge_node_reschedule_check_wait_language_gate_english` | `node_reschedule_check_wait_language_gate` → `node_calendar_prepare_node_reschedule_check` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"English"}],"operator":"&&","type":"equation"}` |
| E239 / `edge_node_reschedule_check_wait_language_gate_arabic` | `node_reschedule_check_wait_language_gate` → `node_calendar_prepare_node_reschedule_check_arabic_wait` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"Arabic"}],"operator":"&&","type":"equation"}` |
| E240 / `edge_node_reschedule_check_wait_language_gate_failure` | `node_reschedule_check_wait_language_gate` → `node_tool_failure` | `{"prompt":"Else","type":"prompt"}` |
| E241 / `edge_downtime_node_lookup_arabic_wait` | `node_lookup_arabic_wait` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E242 / `edge_lookup_found_arabic_wait` | `node_lookup_arabic_wait` → `node_select_existing` | `{"equations":[{"left":"{{lookup_success}}","operator":"==","right":"true"},{"left":"{{appointment_count}}","operator":">","right":"0"}],"operator":"&&","type":"equation"}` |
| E243 / `edge_lookup_none_arabic_wait` | `node_lookup_arabic_wait` → `node_existing_not_found` | `{"equations":[{"left":"{{lookup_success}}","operator":"==","right":"true"},{"left":"{{appointment_count}}","operator":"==","right":"0"}],"operator":"&&","type":"equation"}` |
| E244 / `edge_node_lookup_else_arabic_wait` | `node_lookup_arabic_wait` → `node_tool_failure` | `{"prompt":"Else","type":"prompt"}` |
| E245 / `edge_node_lookup_wait_language_gate_english` | `node_lookup_wait_language_gate` → `node_downtime_prepare_node_lookup` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"English"}],"operator":"&&","type":"equation"}` |
| E246 / `edge_node_lookup_wait_language_gate_arabic` | `node_lookup_wait_language_gate` → `node_downtime_prepare_node_lookup_arabic_wait` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"Arabic"}],"operator":"&&","type":"equation"}` |
| E247 / `edge_node_lookup_wait_language_gate_failure` | `node_lookup_wait_language_gate` → `node_tool_failure` | `{"prompt":"Else","type":"prompt"}` |
| E248 / `edge_downtime_node_book_arabic_wait` | `node_book_arabic_wait` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E249 / `edge_book_success_arabic_wait` | `node_book_arabic_wait` → `node_booked` | `{"equations":[{"left":"{{booking_success}}","operator":"==","right":"true"},{"left":"{{appointment_booked}}","operator":"==","right":"true"},{"left":"{{booking_id}}","operator":"!=","right":""}],"operator":"&&","type":"equation"}` |
| E250 / `edge_node_book_else_arabic_wait` | `node_book_arabic_wait` → `node_book_failed` | `{"prompt":"Else","type":"prompt"}` |
| E251 / `edge_node_book_wait_language_gate_english` | `node_book_wait_language_gate` → `node_intake_entry_node_book_clear` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"English"}],"operator":"&&","type":"equation"}` |
| E252 / `edge_node_book_wait_language_gate_arabic` | `node_book_wait_language_gate` → `node_intake_entry_node_book_arabic_wait_clear` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"Arabic"}],"operator":"&&","type":"equation"}` |
| E253 / `edge_node_book_wait_language_gate_failure` | `node_book_wait_language_gate` → `node_book_failed` | `{"prompt":"Else","type":"prompt"}` |
| E254 / `edge_downtime_node_reschedule_tool_arabic_wait` | `node_reschedule_tool_arabic_wait` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E255 / `edge_reschedule_success_arabic_wait` | `node_reschedule_tool_arabic_wait` → `node_rescheduled` | `{"equations":[{"left":"{{reschedule_success}}","operator":"==","right":"true"},{"left":"{{rescheduled_id}}","operator":"exists"}],"operator":"&&","type":"equation"}` |
| E256 / `edge_node_reschedule_tool_else_arabic_wait` | `node_reschedule_tool_arabic_wait` → `node_reschedule_failed` | `{"prompt":"Else","type":"prompt"}` |
| E257 / `edge_node_reschedule_tool_wait_language_gate_english` | `node_reschedule_tool_wait_language_gate` → `node_downtime_prepare_node_reschedule_tool` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"English"}],"operator":"&&","type":"equation"}` |
| E258 / `edge_node_reschedule_tool_wait_language_gate_arabic` | `node_reschedule_tool_wait_language_gate` → `node_downtime_prepare_node_reschedule_tool_arabic_wait` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"Arabic"}],"operator":"&&","type":"equation"}` |
| E259 / `edge_node_reschedule_tool_wait_language_gate_failure` | `node_reschedule_tool_wait_language_gate` → `node_reschedule_failed` | `{"prompt":"Else","type":"prompt"}` |
| E260 / `edge_downtime_node_cancel_tool_arabic_wait` | `node_cancel_tool_arabic_wait` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E261 / `edge_cancel_success_arabic_wait` | `node_cancel_tool_arabic_wait` → `node_cancelled` | `{"equations":[{"left":"{{cancel_success}}","operator":"==","right":"true"},{"left":"{{cancelled_id}}","operator":"exists"}],"operator":"&&","type":"equation"}` |
| E262 / `edge_node_cancel_tool_else_arabic_wait` | `node_cancel_tool_arabic_wait` → `node_cancel_failed` | `{"prompt":"Else","type":"prompt"}` |
| E263 / `edge_node_cancel_tool_wait_language_gate_english` | `node_cancel_tool_wait_language_gate` → `node_downtime_prepare_node_cancel_tool` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"English"}],"operator":"&&","type":"equation"}` |
| E264 / `edge_node_cancel_tool_wait_language_gate_arabic` | `node_cancel_tool_wait_language_gate` → `node_downtime_prepare_node_cancel_tool_arabic_wait` | `{"equations":[{"left":"{{wait_language}}","operator":"==","right":"Arabic"}],"operator":"&&","type":"equation"}` |
| E265 / `edge_node_cancel_tool_wait_language_gate_failure` | `node_cancel_tool_wait_language_gate` → `node_cancel_failed` | `{"prompt":"Else","type":"prompt"}` |
| E266 / `edge_new_cycle_corrected` | `node_new_cycle_readback` → `node_new_cycle_restate` | `{"prompt":"Caller corrects, contradicts, or questions ANY part of the readback, including a different date or service; or does not clearly confirm it.","type":"prompt"}` |
| E267 / `edge_new_cycle_confirmed` | `node_new_cycle_readback` → `node_intake_name_capture` | `{"prompt":"Caller explicitly confirms the entire NEW request just read back, without any correction or contradictory date/service/doctor/patient detail.","type":"prompt"}` |
| E268 / `edge_new_cycle_declined` | `node_new_cycle_readback` → `node_anything_else` | `{"prompt":"Caller decides not to continue with this new booking.","type":"prompt"}` |
| E269 / `edge_new_cycle_restated` | `node_new_cycle_restate` → `node_reset_prepare` | `{"prompt":"Caller clearly restates a complete new booking or new availability request, not merely yes or a single correction fragment.","type":"prompt"}` |
| E270 / `edge_new_cycle_stopped` | `node_new_cycle_restate` → `node_anything_else` | `{"prompt":"Caller declines to continue or asks for other help.","type":"prompt"}` |
| E271 / `edge_slot_matched` | `node_match_slot` → `node_guard_slot_clear_result` | `{"equations":[{"left":"{{slot_match_status}}","operator":"==","right":"matched"}],"operator":"&&","type":"equation"}` |
| E272 / `edge_slot_clarify` | `node_match_slot` → `node_slot_clarify` | `{"equations":[{"left":"{{slot_match_status}}","operator":"==","right":"clarify"}],"operator":"&&","type":"equation"}` |
| E273 / `edge_slot_expired` | `node_match_slot` → `node_invalidate_booking_clear_ack` | `{"equations":[{"left":"{{slot_match_status}}","operator":"==","right":"refresh"}],"operator":"&&","type":"equation"}` |
| E274 / `edge_slot_invalid_state` | `node_match_slot` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E275 / `edge_slot_clarified` | `node_slot_clarify` → `node_capture_slot` | `{"prompt":"Caller clarifies or repeats one of the current checked local slot times. Continue matching within this same availability result.","type":"prompt"}` |
| E276 / `edge_slot_new_search` | `node_slot_clarify` → `node_correction_clear_candidate` | `{"prompt":"Caller explicitly requests a different date, service, doctor, or time outside the current checked slots; assess a real parameter change before invalidating.","type":"prompt"}` |
| E277 / `edge_slot_declined` | `node_slot_clarify` → `node_anything_else` | `{"prompt":"Caller declines the appointment or asks to stop.","type":"prompt"}` |
| E278 / `edge_downtime_node_check_silent` | `node_check_silent` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E279 / `edge_calendar_node_check_silent` | `node_check_silent` → `node_calendar_unavailable` | `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}` |
| E280 / `edge_availability_yes_silent` | `node_check_silent` → `node_offer` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E281 / `edge_availability_no_silent` | `node_check_silent` → `node_no_slots` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E282 / `edge_availability_error_silent` | `node_check_silent` → `node_check_error` | `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E283 / `edge_calendar_transport_node_check_silent` | `node_check_silent` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E284 / `edge_node_calendar_prepare_node_check` | `node_calendar_prepare_node_check` → `node_intake_entry_node_check_clear` | `{"prompt":"Always","type":"prompt"}` |
| E285 / `edge_node_calendar_prepare_node_check_failed` | `node_calendar_prepare_node_check` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E286 / `edge_node_calendar_prepare_node_reschedule_check` | `node_calendar_prepare_node_reschedule_check` → `node_downtime_prepare_node_reschedule_check` | `{"prompt":"Always","type":"prompt"}` |
| E287 / `edge_node_calendar_prepare_node_reschedule_check_failed` | `node_calendar_prepare_node_reschedule_check` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E288 / `edge_node_calendar_prepare_node_check_arabic_wait` | `node_calendar_prepare_node_check_arabic_wait` → `node_intake_entry_node_check_arabic_wait_clear` | `{"prompt":"Always","type":"prompt"}` |
| E289 / `edge_node_calendar_prepare_node_check_arabic_wait_failed` | `node_calendar_prepare_node_check_arabic_wait` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E290 / `edge_node_calendar_prepare_node_reschedule_check_arabic_wait` | `node_calendar_prepare_node_reschedule_check_arabic_wait` → `node_downtime_prepare_node_reschedule_check_arabic_wait` | `{"prompt":"Always","type":"prompt"}` |
| E291 / `edge_node_calendar_prepare_node_reschedule_check_arabic_wait_failed` | `node_calendar_prepare_node_reschedule_check_arabic_wait` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E292 / `edge_node_calendar_prepare_node_check_silent` | `node_calendar_prepare_node_check_silent` → `node_intake_entry_node_check_silent_clear` | `{"prompt":"Always","type":"prompt"}` |
| E293 / `edge_node_calendar_prepare_node_check_silent_failed` | `node_calendar_prepare_node_check_silent` → `node_calendar_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E294 / `edge_calendar_collect` | `node_calendar_unavailable` → `node_calendar_collect` | `{"prompt":"Caller accepts follow-up and calendar_follow_up_saved is not true","type":"prompt"}` |
| E295 / `edge_calendar_done` | `node_calendar_unavailable` → `node_end` | `{"prompt":"Caller declines, is finished, or preferences were already saved","type":"prompt"}` |
| E296 / `edge_calendar_save` | `node_calendar_collect` → `node_downtime_prepare_node_calendar_save` | `{"prompt":"Patient name, confirmed phone, service and preferred date/time are complete","type":"prompt"}` |
| E297 / `edge_calendar_decline` | `node_calendar_collect` → `node_end` | `{"prompt":"Caller declines or is finished","type":"prompt"}` |
| E298 / `edge_downtime_node_calendar_save` | `node_calendar_save` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E299 / `edge_calendar_saved` | `node_calendar_save` → `node_calendar_saved` | `{"equations":[{"left":"{{calendar_follow_up_saved}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E300 / `edge_calendar_save_failed` | `node_calendar_save` → `node_calendar_save_failed` | `{"prompt":"Else","type":"prompt"}` |
| E301 / `edge_calendar_saved_end` | `node_calendar_saved` → `node_end` | `{"prompt":"Always","type":"prompt"}` |
| E302 / `edge_calendar_unsaved_end` | `node_calendar_save_failed` → `node_end` | `{"prompt":"Always","type":"prompt"}` |
| E303 / `edge_unknown_prepare` | `node_unknown_prepare` → `node_unknown_collect` | `{"prompt":"Always","type":"prompt"}` |
| E304 / `edge_unknown_prepare_failed` | `node_unknown_prepare` → `node_unknown_failed` | `{"prompt":"Else","type":"prompt"}` |
| E305 / `edge_unknown_save` | `node_unknown_collect` → `node_downtime_prepare_node_unknown_save` | `{"prompt":"Caller explicitly requested follow-up, the unanswered question is known, and name/phone have been supplied or declined","type":"prompt"}` |
| E306 / `edge_unknown_cancel` | `node_unknown_collect` → `node_anything_else` | `{"prompt":"Caller withdraws or declines follow-up","type":"prompt"}` |
| E307 / `edge_downtime_node_unknown_save` | `node_unknown_save` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E308 / `edge_unknown_saved` | `node_unknown_save` → `node_unknown_saved` | `{"equations":[{"left":"{{unknown_follow_up_saved}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E309 / `edge_unknown_failed` | `node_unknown_save` → `node_unknown_failed` | `{"prompt":"Else","type":"prompt"}` |
| E310 / `edge_unknown_saved_done` | `node_unknown_saved` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E311 / `edge_unknown_failed_done` | `node_unknown_failed` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E312 / `edge_unknown_opt_in_route` | `node_unknown_follow_up` → `node_unknown_prepare` | `{"prompt":"Always","type":"prompt"}` |
| E313 / `edge_human_prepare` | `node_human_prepare` → `node_human_collect` | `{"prompt":"Always","type":"prompt"}` |
| E314 / `edge_human_prepare_failed` | `node_human_prepare` → `node_human_failed` | `{"prompt":"Else","type":"prompt"}` |
| E315 / `edge_human_save` | `node_human_collect` → `node_downtime_prepare_node_human_save` | `{"prompt":"Escalation is required, concise reason/category known, and optional name/phone supplied or declined","type":"prompt"}` |
| E316 / `edge_human_withdraw` | `node_human_collect` → `node_anything_else` | `{"prompt":"Caller withdraws the escalation request","type":"prompt"}` |
| E317 / `edge_downtime_node_human_save` | `node_human_save` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E318 / `edge_human_saved` | `node_human_save` → `node_human_saved` | `{"equations":[{"left":"{{human_follow_up_saved}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E319 / `edge_human_failed` | `node_human_save` → `node_human_failed` | `{"prompt":"Else","type":"prompt"}` |
| E320 / `edge_node_human_saved_done` | `node_human_saved` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E321 / `edge_node_human_failed_done` | `node_human_failed` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E322 / `edge_transfer_prepare` | `node_transfer_prepare` → `node_downtime_prepare_node_transfer_gate` | `{"prompt":"Always","type":"prompt"}` |
| E323 / `edge_transfer_prepare_failed` | `node_transfer_prepare` → `node_transfer_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E324 / `edge_downtime_node_transfer_gate` | `node_transfer_gate` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E325 / `edge_transfer_allowed` | `node_transfer_gate` → `node_transfer_native` | `{"equations":[{"left":"{{transfer_allowed}}","operator":"==","right":"true"},{"left":"{{trusted_transfer_destination}}","operator":"!=","right":""},{"left":"{{trusted_transfer_destination}}","operator":"!=","right":"null"}],"operator":"&&","type":"equation"}` |
| E326 / `edge_transfer_after_hours` | `node_transfer_gate` → `node_transfer_after_hours` | `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"after_hours"}],"operator":"&&","type":"equation"}` |
| E327 / `edge_transfer_already_succeeded` | `node_transfer_gate` → `node_transfer_done` | `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"success"}],"operator":"&&","type":"equation"}` |
| E328 / `edge_transfer_follow_up_only` | `node_transfer_gate` → `node_human_prepare` | `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"not_requested"}],"operator":"&&","type":"equation"}` |
| E329 / `edge_transfer_previous_failure` | `node_transfer_gate` → `node_downtime_prepare_node_transfer_fallback` | `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"previous_failure"}],"operator":"&&","type":"equation"}` |
| E330 / `edge_transfer_no_retry` | `node_transfer_gate` → `node_transfer_done` | `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"already_attempted"}],"operator":"&&","type":"equation"}` |
| E331 / `edge_transfer_unavailable` | `node_transfer_gate` → `node_transfer_unavailable` | `{"prompt":"Else","type":"prompt"}` |
| E332 / `edge_transfer_native_failed` | `node_transfer_native` → `node_transfer_failed` | `{"prompt":"Transfer failed","type":"prompt"}` |
| E333 / `edge_transfer_unavailable_human` | `node_transfer_unavailable` → `node_human_prepare` | `{"prompt":"Always","type":"prompt"}` |
| E334 / `edge_transfer_hours_follow_up` | `node_transfer_after_hours` → `node_human_prepare` | `{"prompt":"Caller still wants clinic assistance/follow-up","type":"prompt"}` |
| E335 / `edge_transfer_hours_decline` | `node_transfer_after_hours` → `node_anything_else` | `{"prompt":"Caller declines follow-up","type":"prompt"}` |
| E336 / `edge_transfer_failed_save` | `node_transfer_failed` → `node_downtime_prepare_node_transfer_fallback` | `{"prompt":"Optional contact supplied, already known or declined","type":"prompt"}` |
| E337 / `edge_downtime_node_transfer_fallback` | `node_transfer_fallback` → `node_downtime_clear` | `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"\|\|","type":"equation"}` |
| E338 / `edge_transfer_follow_up_saved` | `node_transfer_fallback` → `node_transfer_follow_up_saved` | `{"equations":[{"left":"{{transfer_follow_up_saved}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E339 / `edge_transfer_late_success` | `node_transfer_fallback` → `node_transfer_done` | `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"success"}],"operator":"&&","type":"equation"}` |
| E340 / `edge_transfer_follow_up_failed` | `node_transfer_fallback` → `node_transfer_follow_up_failed` | `{"prompt":"Else","type":"prompt"}` |
| E341 / `edge_transfer_saved_done` | `node_transfer_follow_up_saved` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E342 / `edge_transfer_save_failed_done` | `node_transfer_follow_up_failed` → `node_anything_else` | `{"prompt":"Always","type":"prompt"}` |
| E343 / `edge_transfer_done` | `node_transfer_done` → `node_end` | `{"prompt":"Always","type":"prompt"}` |
| E344 / `edge_downtime_prepare_node_resolve` | `node_downtime_prepare_node_resolve` → `node_resolve` | `{"prompt":"Always","type":"prompt"}` |
| E345 / `edge_downtime_prepare_failed_node_resolve` | `node_downtime_prepare_node_resolve` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E346 / `edge_downtime_prepare_node_check` | `node_downtime_prepare_node_check` → `node_check` | `{"prompt":"Always","type":"prompt"}` |
| E347 / `edge_downtime_prepare_failed_node_check` | `node_downtime_prepare_node_check` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E348 / `edge_downtime_prepare_node_book` | `node_downtime_prepare_node_book` → `node_book` | `{"prompt":"Always","type":"prompt"}` |
| E349 / `edge_downtime_prepare_failed_node_book` | `node_downtime_prepare_node_book` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E350 / `edge_downtime_prepare_node_invalidate_booking` | `node_downtime_prepare_node_invalidate_booking` → `node_invalidate_booking` | `{"prompt":"Always","type":"prompt"}` |
| E351 / `edge_downtime_prepare_failed_node_invalidate_booking` | `node_downtime_prepare_node_invalidate_booking` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E352 / `edge_downtime_prepare_node_invalidate_after_book` | `node_downtime_prepare_node_invalidate_after_book` → `node_invalidate_after_book` | `{"prompt":"Always","type":"prompt"}` |
| E353 / `edge_downtime_prepare_failed_node_invalidate_after_book` | `node_downtime_prepare_node_invalidate_after_book` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E354 / `edge_downtime_prepare_node_lookup` | `node_downtime_prepare_node_lookup` → `node_lookup` | `{"prompt":"Always","type":"prompt"}` |
| E355 / `edge_downtime_prepare_failed_node_lookup` | `node_downtime_prepare_node_lookup` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E356 / `edge_downtime_prepare_node_reschedule_check` | `node_downtime_prepare_node_reschedule_check` → `node_reschedule_check` | `{"prompt":"Always","type":"prompt"}` |
| E357 / `edge_downtime_prepare_failed_node_reschedule_check` | `node_downtime_prepare_node_reschedule_check` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E358 / `edge_downtime_prepare_node_reschedule_tool` | `node_downtime_prepare_node_reschedule_tool` → `node_reschedule_tool` | `{"prompt":"Always","type":"prompt"}` |
| E359 / `edge_downtime_prepare_failed_node_reschedule_tool` | `node_downtime_prepare_node_reschedule_tool` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E360 / `edge_downtime_prepare_node_invalidate_reschedule` | `node_downtime_prepare_node_invalidate_reschedule` → `node_invalidate_reschedule` | `{"prompt":"Always","type":"prompt"}` |
| E361 / `edge_downtime_prepare_failed_node_invalidate_reschedule` | `node_downtime_prepare_node_invalidate_reschedule` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E362 / `edge_downtime_prepare_node_cancel_tool` | `node_downtime_prepare_node_cancel_tool` → `node_cancel_tool` | `{"prompt":"Always","type":"prompt"}` |
| E363 / `edge_downtime_prepare_failed_node_cancel_tool` | `node_downtime_prepare_node_cancel_tool` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E364 / `edge_downtime_prepare_node_message_tool` | `node_downtime_prepare_node_message_tool` → `node_message_tool` | `{"prompt":"Always","type":"prompt"}` |
| E365 / `edge_downtime_prepare_failed_node_message_tool` | `node_downtime_prepare_node_message_tool` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E366 / `edge_downtime_prepare_node_callback_tool` | `node_downtime_prepare_node_callback_tool` → `node_callback_tool` | `{"prompt":"Always","type":"prompt"}` |
| E367 / `edge_downtime_prepare_failed_node_callback_tool` | `node_downtime_prepare_node_callback_tool` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E368 / `edge_downtime_prepare_node_urgent_tool` | `node_downtime_prepare_node_urgent_tool` → `node_urgent_tool` | `{"prompt":"Always","type":"prompt"}` |
| E369 / `edge_downtime_prepare_failed_node_urgent_tool` | `node_downtime_prepare_node_urgent_tool` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E370 / `edge_downtime_prepare_node_reset_invalidate` | `node_downtime_prepare_node_reset_invalidate` → `node_reset_invalidate` | `{"prompt":"Always","type":"prompt"}` |
| E371 / `edge_downtime_prepare_failed_node_reset_invalidate` | `node_downtime_prepare_node_reset_invalidate` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E372 / `edge_downtime_prepare_node_check_arabic_wait` | `node_downtime_prepare_node_check_arabic_wait` → `node_check_arabic_wait` | `{"prompt":"Always","type":"prompt"}` |
| E373 / `edge_downtime_prepare_failed_node_check_arabic_wait` | `node_downtime_prepare_node_check_arabic_wait` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E374 / `edge_downtime_prepare_node_reschedule_check_arabic_wait` | `node_downtime_prepare_node_reschedule_check_arabic_wait` → `node_reschedule_check_arabic_wait` | `{"prompt":"Always","type":"prompt"}` |
| E375 / `edge_downtime_prepare_failed_node_reschedule_check_arabic_wait` | `node_downtime_prepare_node_reschedule_check_arabic_wait` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E376 / `edge_downtime_prepare_node_lookup_arabic_wait` | `node_downtime_prepare_node_lookup_arabic_wait` → `node_lookup_arabic_wait` | `{"prompt":"Always","type":"prompt"}` |
| E377 / `edge_downtime_prepare_failed_node_lookup_arabic_wait` | `node_downtime_prepare_node_lookup_arabic_wait` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E378 / `edge_downtime_prepare_node_book_arabic_wait` | `node_downtime_prepare_node_book_arabic_wait` → `node_book_arabic_wait` | `{"prompt":"Always","type":"prompt"}` |
| E379 / `edge_downtime_prepare_failed_node_book_arabic_wait` | `node_downtime_prepare_node_book_arabic_wait` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E380 / `edge_downtime_prepare_node_reschedule_tool_arabic_wait` | `node_downtime_prepare_node_reschedule_tool_arabic_wait` → `node_reschedule_tool_arabic_wait` | `{"prompt":"Always","type":"prompt"}` |
| E381 / `edge_downtime_prepare_failed_node_reschedule_tool_arabic_wait` | `node_downtime_prepare_node_reschedule_tool_arabic_wait` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E382 / `edge_downtime_prepare_node_cancel_tool_arabic_wait` | `node_downtime_prepare_node_cancel_tool_arabic_wait` → `node_cancel_tool_arabic_wait` | `{"prompt":"Always","type":"prompt"}` |
| E383 / `edge_downtime_prepare_failed_node_cancel_tool_arabic_wait` | `node_downtime_prepare_node_cancel_tool_arabic_wait` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E384 / `edge_downtime_prepare_node_check_silent` | `node_downtime_prepare_node_check_silent` → `node_check_silent` | `{"prompt":"Always","type":"prompt"}` |
| E385 / `edge_downtime_prepare_failed_node_check_silent` | `node_downtime_prepare_node_check_silent` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E386 / `edge_downtime_prepare_node_calendar_save` | `node_downtime_prepare_node_calendar_save` → `node_calendar_save` | `{"prompt":"Always","type":"prompt"}` |
| E387 / `edge_downtime_prepare_failed_node_calendar_save` | `node_downtime_prepare_node_calendar_save` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E388 / `edge_downtime_prepare_node_unknown_save` | `node_downtime_prepare_node_unknown_save` → `node_unknown_save` | `{"prompt":"Always","type":"prompt"}` |
| E389 / `edge_downtime_prepare_failed_node_unknown_save` | `node_downtime_prepare_node_unknown_save` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E390 / `edge_downtime_prepare_node_human_save` | `node_downtime_prepare_node_human_save` → `node_human_save` | `{"prompt":"Always","type":"prompt"}` |
| E391 / `edge_downtime_prepare_failed_node_human_save` | `node_downtime_prepare_node_human_save` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E392 / `edge_downtime_prepare_node_transfer_gate` | `node_downtime_prepare_node_transfer_gate` → `node_transfer_gate` | `{"prompt":"Always","type":"prompt"}` |
| E393 / `edge_downtime_prepare_failed_node_transfer_gate` | `node_downtime_prepare_node_transfer_gate` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E394 / `edge_downtime_prepare_node_transfer_fallback` | `node_downtime_prepare_node_transfer_fallback` → `node_transfer_fallback` | `{"prompt":"Always","type":"prompt"}` |
| E395 / `edge_downtime_prepare_failed_node_transfer_fallback` | `node_downtime_prepare_node_transfer_fallback` → `node_downtime_clear` | `{"prompt":"Else","type":"prompt"}` |
| E396 / `edge_downtime_speak` | `node_downtime_clear` → `node_system_downtime` | `{"prompt":"Always","type":"prompt"}` |
| E397 / `edge_downtime_clear_failed` | `node_downtime_clear` → `node_system_downtime` | `{"prompt":"Else","type":"prompt"}` |
| E398 / `edge_downtime_end` | `node_system_downtime` → `node_end` | `{"prompt":"Always","type":"prompt"}` |
| E399 / `node_intake_name_capture_done` | `node_intake_name_capture` → `node_intake_name_gate_clear` | `{"prompt":"Always","type":"prompt"}` |
| E400 / `node_intake_name_capture_failed` | `node_intake_name_capture` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E401 / `intake_name_missing` | `node_intake_name_gate` → `node_intake_name` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":"name"}],"operator":"&&","type":"equation"}` |
| E402 / `intake_name_present` | `node_intake_name_gate` → `node_service` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":"service"}],"operator":"&&","type":"equation"}` |
| E403 / `node_intake_name_gate_failed` | `node_intake_name_gate` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E404 / `intake_name_answered` | `node_intake_name` → `node_intake_name_capture` | `{"prompt":"Always","type":"prompt"}` |
| E405 / `node_intake_doctor_capture_done` | `node_intake_doctor_capture` → `node_intake_before_time_clear` | `{"prompt":"Always","type":"prompt"}` |
| E406 / `node_intake_doctor_capture_failed` | `node_intake_doctor_capture` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E407 / `intake_need_name` | `node_intake_before_time` → `node_intake_name_capture` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":"name"}],"operator":"&&","type":"equation"}` |
| E408 / `intake_need_service` | `node_intake_before_time` → `node_service` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":"service"}],"operator":"&&","type":"equation"}` |
| E409 / `intake_need_doctor` | `node_intake_before_time` → `node_doctor_preference` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":"doctor"}],"operator":"&&","type":"equation"}` |
| E410 / `intake_need_contact` | `node_intake_before_time` → `node_patient` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":"contact"}],"operator":"&&","type":"equation"}` |
| E411 / `intake_ready_for_date` | `node_intake_before_time` → `node_date_time` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":"date"}],"operator":"&&","type":"equation"}` |
| E412 / `node_intake_before_time_failed` | `node_intake_before_time` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E413 / `node_intake_contact_capture_done` | `node_intake_contact_capture` → `node_intake_before_time_clear` | `{"prompt":"Always","type":"prompt"}` |
| E414 / `node_intake_contact_capture_failed` | `node_intake_contact_capture` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E415 / `node_intake_entry_node_check_ready` | `node_intake_entry_node_check` → `node_downtime_prepare_node_check` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E416 / `node_intake_entry_node_check_failed` | `node_intake_entry_node_check` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E417 / `node_intake_entry_node_check_arabic_wait_ready` | `node_intake_entry_node_check_arabic_wait` → `node_downtime_prepare_node_check_arabic_wait` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E418 / `node_intake_entry_node_check_arabic_wait_failed` | `node_intake_entry_node_check_arabic_wait` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E419 / `node_intake_entry_node_check_silent_ready` | `node_intake_entry_node_check_silent` → `node_downtime_prepare_node_check_silent` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E420 / `node_intake_entry_node_check_silent_failed` | `node_intake_entry_node_check_silent` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E421 / `node_intake_entry_node_book_ready` | `node_intake_entry_node_book` → `node_downtime_prepare_node_book` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E422 / `node_intake_entry_node_book_failed` | `node_intake_entry_node_book` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E423 / `node_intake_entry_node_book_arabic_wait_ready` | `node_intake_entry_node_book_arabic_wait` → `node_downtime_prepare_node_book_arabic_wait` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}` |
| E424 / `node_intake_entry_node_book_arabic_wait_failed` | `node_intake_entry_node_book_arabic_wait` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E425 / `node_intake_name_gate_clear_done` | `node_intake_name_gate_clear` → `node_intake_name_gate` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":""}],"operator":"&&","type":"equation"}` |
| E426 / `node_intake_name_gate_clear_failed` | `node_intake_name_gate_clear` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E427 / `node_intake_before_time_clear_done` | `node_intake_before_time_clear` → `node_intake_before_time` | `{"equations":[{"left":"{{intake_route}}","operator":"==","right":""}],"operator":"&&","type":"equation"}` |
| E428 / `node_intake_before_time_clear_failed` | `node_intake_before_time_clear` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E429 / `node_intake_entry_node_check_clear_done` | `node_intake_entry_node_check_clear` → `node_intake_entry_node_check` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E430 / `node_intake_entry_node_check_clear_failed` | `node_intake_entry_node_check_clear` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E431 / `node_intake_entry_node_check_arabic_wait_clear_done` | `node_intake_entry_node_check_arabic_wait_clear` → `node_intake_entry_node_check_arabic_wait` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E432 / `node_intake_entry_node_check_arabic_wait_clear_failed` | `node_intake_entry_node_check_arabic_wait_clear` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E433 / `node_intake_entry_node_check_silent_clear_done` | `node_intake_entry_node_check_silent_clear` → `node_intake_entry_node_check_silent` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E434 / `node_intake_entry_node_check_silent_clear_failed` | `node_intake_entry_node_check_silent_clear` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E435 / `node_intake_entry_node_book_clear_done` | `node_intake_entry_node_book_clear` → `node_intake_entry_node_book` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E436 / `node_intake_entry_node_book_clear_failed` | `node_intake_entry_node_book_clear` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |
| E437 / `node_intake_entry_node_book_arabic_wait_clear_done` | `node_intake_entry_node_book_arabic_wait_clear` → `node_intake_entry_node_book_arabic_wait` | `{"equations":[{"left":"{{intake_entry_ok}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}` |
| E438 / `node_intake_entry_node_book_arabic_wait_clear_failed` | `node_intake_entry_node_book_arabic_wait_clear` → `node_reset_failed` | `{"prompt":"Else","type":"prompt"}` |

## Global productions and dynamic return

### GLOBAL 1 — eligible current node → node_global_faq

Exact activation/source-eligibility rule:

```text
Activate ONLY when an actual unfinished task is in progress at one of these conversation nodes: Understand Service, Clarify Service, Doctor Preference, Date and Time Preference, Offer Verified Slots, Patient and Contact, Final Booking Confirmation, Collect Correction, Verify Existing Patient, Select Existing Appointment, New Appointment Details, Offer Reschedule Slots, Final Reschedule Confirmation, Final Cancellation Confirmation, Take Message, Collect Callback, Collect Urgent Contact. The caller briefly asks a factual clinic question (hours, parking, directions, prices, insurance) and wants to continue THAT task. NEVER activate from Greeting, Clinic Questions, Anything Else, any reset node, a completion node, or a failure node. Never intercept a new booking, appointment availability, correction, consent, or task change. Do not interrupt node_downtime_clear or node_system_downtime, or restart automation after apero_downtime_active is true.
```

Cooldown: 3. Source exclusions are part of this rule. This is model-conditioned activation, not an explicit unconditional edge from every node.

### GLOBAL 2 — eligible current node → node_global_urgent

Exact activation/source-eligibility rule:

```text
Caller describes urgent or potentially emergency dental or medical symptoms. Do not interrupt node_downtime_clear or node_system_downtime, or restart automation after apero_downtime_active is true.
```

Cooldown: 3. Source exclusions are part of this rule. This is model-conditioned activation, not an explicit unconditional edge from every node.

### GLOBAL 3 — eligible current node → node_global_human

Exact activation/source-eligibility rule:

```text
The most recent caller turn explicitly requests clinic staff, a human, manager or receptionist; or the operational request cannot safely be completed, requires clinic judgment, remains incomplete after repeated failures, involves an appointment dispute that Apero cannot safely resolve, or asks for an unsupported operational action. Exclude normal supported questions or requests, unanswered factual questions (use the unknown-answer opt-in path), failed booking (use its specific follow-up), and calendar availability failure (use calendar follow-up). Never infer medical urgency or make a clinical judgment from symptoms; preserve the existing urgent-request path. Do not interrupt an active human escalation collection/save/result path or create another escalation for the same issue. Do not interrupt an active transfer gate, native transfer, unavailable or failure follow-up path. Do not interrupt node_downtime_clear or node_system_downtime, or restart automation after apero_downtime_active is true.
```

Cooldown: 3. Source exclusions are part of this rule. This is model-conditioned activation, not an explicit unconditional edge from every node.

### GLOBAL 4 — eligible current node → node_unknown_follow_up

Exact activation/source-eligibility rule:

```text
The most recent caller turn explicitly requests or clearly accepts clinic follow-up about a specific factual question that cannot be answered from configured clinic information, including an unknown price, practitioner fact, policy or closure exception. A clear acceptance immediately responding to the unknown-information follow-up offer qualifies. Never infer consent from silence, an unrelated or ambiguous yes. Exclude known-answer questions, general human requests, urgent symptoms, booking failures and calendar availability failures. Do not interrupt node_downtime_clear or node_system_downtime, or restart automation after apero_downtime_active is true.
```

Cooldown: 3. Source exclusions are part of this rule. This is model-conditioned activation, not an explicit unconditional edge from every node.

### GLOBAL RETURN — node_global_faq → actual previous unfinished task

```json
[
  {
    "id": "node_global_faq_go_back",
    "transition_condition": {
      "prompt": "The most recent brief factual question has been answered and the caller accepts the answer or resumes the SAME unfinished task, INCLUDING 'yes, book that same consultation', selecting the previously offered slot, giving patient details for it, 'continue', or confirming the same current tuple. This is continuation, NOT a separate new booking; return to the actual previous task node to handle selection/identity/consent there. Do not stay in this FAQ to book. Previous task node must not be Greeting, Clinic Questions, Anything Else, reset, completion or failure. Exclude a separate NEW/ANOTHER appointment, a factual follow-up question, or a correction to the interrupted tuple.",
      "type": "prompt"
    }
  }
]
```

The destination is dynamic and constrained by the activation whitelist. Unknown-information follow-up save has no equivalent return rule.

## Every operational result branch

No operational tool was invoked. All 26 function nodes and every outgoing result/default/transport transition are expanded below, including English/Arabic/silent variants.

### `node_resolve` → `resolve_service`

- `edge_downtime_node_resolve` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_resolve_ok` → `node_doctor_preference` when `{"equations":[{"left":"{{resolve_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_node_resolve_else` → `node_service_clarify` when `{"prompt":"Else","type":"prompt"}`.

### `node_check` → `check_fresh_availability`

- `edge_downtime_node_check` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_calendar_node_check` → `node_calendar_unavailable` when `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}`.
- `edge_availability_yes` → `node_offer` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_availability_no` → `node_no_slots` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_availability_error` → `node_check_error` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_calendar_transport_node_check` → `node_calendar_unavailable` when `{"prompt":"Else","type":"prompt"}`.

### `node_book` → `book_appointment`

- `edge_downtime_node_book` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_book_success` → `node_booked` when `{"equations":[{"left":"{{booking_success}}","operator":"==","right":"true"},{"left":"{{appointment_booked}}","operator":"==","right":"true"},{"left":"{{booking_id}}","operator":"!=","right":""}],"operator":"&&","type":"equation"}`.
- `edge_node_book_else` → `node_book_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_invalidate_booking` → `invalidate_availability`

- `edge_downtime_node_invalidate_booking` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_node_invalidate_booking_confirmed` → `node_clear_correction` when `{"equations":[{"left":"{{availability_invalidated}}","operator":"==","right":"true"},{"left":"{{invalidation_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_node_invalidate_booking_failure` → `node_reset_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_invalidate_after_book` → `invalidate_availability`

- `edge_downtime_node_invalidate_after_book` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_node_invalidate_after_book_always` → `node_anything_else` when `{"prompt":"Always","type":"prompt"}`.

### `node_lookup` → `lookup_appointments`

- `edge_downtime_node_lookup` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_lookup_found` → `node_select_existing` when `{"equations":[{"left":"{{lookup_success}}","operator":"==","right":"true"},{"left":"{{appointment_count}}","operator":">","right":"0"}],"operator":"&&","type":"equation"}`.
- `edge_lookup_none` → `node_existing_not_found` when `{"equations":[{"left":"{{lookup_success}}","operator":"==","right":"true"},{"left":"{{appointment_count}}","operator":"==","right":"0"}],"operator":"&&","type":"equation"}`.
- `edge_node_lookup_else` → `node_tool_failure` when `{"prompt":"Else","type":"prompt"}`.

### `node_reschedule_check` → `check_availability`

- `edge_downtime_node_reschedule_check` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_calendar_node_reschedule_check` → `node_calendar_unavailable` when `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}`.
- `edge_reschedule_available` → `node_reschedule_offer` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_reschedule_unavailable` → `node_reschedule_no_slots` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_reschedule_check_error` → `node_reschedule_check_error` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_calendar_transport_node_reschedule_check` → `node_calendar_unavailable` when `{"prompt":"Else","type":"prompt"}`.

### `node_reschedule_tool` → `reschedule_appointment`

- `edge_downtime_node_reschedule_tool` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_reschedule_success` → `node_rescheduled` when `{"equations":[{"left":"{{reschedule_success}}","operator":"==","right":"true"},{"left":"{{rescheduled_id}}","operator":"exists"}],"operator":"&&","type":"equation"}`.
- `edge_node_reschedule_tool_else` → `node_reschedule_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_invalidate_reschedule` → `invalidate_availability`

- `edge_downtime_node_invalidate_reschedule` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_node_invalidate_reschedule_confirmed` → `node_reschedule_details` when `{"equations":[{"left":"{{availability_invalidated}}","operator":"==","right":"true"},{"left":"{{invalidation_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_node_invalidate_reschedule_failure` → `node_reset_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_cancel_tool` → `cancel_appointment`

- `edge_downtime_node_cancel_tool` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_cancel_success` → `node_cancelled` when `{"equations":[{"left":"{{cancel_success}}","operator":"==","right":"true"},{"left":"{{cancelled_id}}","operator":"exists"}],"operator":"&&","type":"equation"}`.
- `edge_node_cancel_tool_else` → `node_cancel_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_message_tool` → `persist_message`

- `edge_downtime_node_message_tool` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_message_saved` → `node_message_saved` when `{"equations":[{"left":"{{message_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_node_message_tool_else` → `node_request_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_callback_tool` → `persist_callback`

- `edge_downtime_node_callback_tool` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_callback_saved` → `node_callback_saved` when `{"equations":[{"left":"{{callback_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_node_callback_tool_else` → `node_request_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_urgent_tool` → `persist_urgent`

- `edge_downtime_node_urgent_tool` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_urgent_saved` → `node_urgent_saved` when `{"equations":[{"left":"{{urgent_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_node_urgent_tool_else` → `node_request_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_reset_invalidate` → `invalidate_availability`

- `edge_downtime_node_reset_invalidate` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_reset_invalidated` → `node_reset_verify` when `{"equations":[{"left":"{{availability_invalidated}}","operator":"==","right":"true"},{"left":"{{invalidation_success}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_node_reset_invalidate_failure` → `node_reset_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_check_arabic_wait` → `check_fresh_availability`

- `edge_downtime_node_check_arabic_wait` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_calendar_node_check_arabic_wait` → `node_calendar_unavailable` when `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}`.
- `edge_availability_yes_arabic_wait` → `node_offer` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_availability_no_arabic_wait` → `node_no_slots` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_availability_error_arabic_wait` → `node_check_error` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_calendar_transport_node_check_arabic_wait` → `node_calendar_unavailable` when `{"prompt":"Else","type":"prompt"}`.

### `node_reschedule_check_arabic_wait` → `check_availability`

- `edge_downtime_node_reschedule_check_arabic_wait` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_calendar_node_reschedule_check_arabic_wait` → `node_calendar_unavailable` when `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}`.
- `edge_reschedule_available_arabic_wait` → `node_reschedule_offer` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_reschedule_unavailable_arabic_wait` → `node_reschedule_no_slots` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_reschedule_check_error_arabic_wait` → `node_reschedule_check_error` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_calendar_transport_node_reschedule_check_arabic_wait` → `node_calendar_unavailable` when `{"prompt":"Else","type":"prompt"}`.

### `node_lookup_arabic_wait` → `lookup_appointments`

- `edge_downtime_node_lookup_arabic_wait` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_lookup_found_arabic_wait` → `node_select_existing` when `{"equations":[{"left":"{{lookup_success}}","operator":"==","right":"true"},{"left":"{{appointment_count}}","operator":">","right":"0"}],"operator":"&&","type":"equation"}`.
- `edge_lookup_none_arabic_wait` → `node_existing_not_found` when `{"equations":[{"left":"{{lookup_success}}","operator":"==","right":"true"},{"left":"{{appointment_count}}","operator":"==","right":"0"}],"operator":"&&","type":"equation"}`.
- `edge_node_lookup_else_arabic_wait` → `node_tool_failure` when `{"prompt":"Else","type":"prompt"}`.

### `node_book_arabic_wait` → `book_appointment`

- `edge_downtime_node_book_arabic_wait` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_book_success_arabic_wait` → `node_booked` when `{"equations":[{"left":"{{booking_success}}","operator":"==","right":"true"},{"left":"{{appointment_booked}}","operator":"==","right":"true"},{"left":"{{booking_id}}","operator":"!=","right":""}],"operator":"&&","type":"equation"}`.
- `edge_node_book_else_arabic_wait` → `node_book_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_reschedule_tool_arabic_wait` → `reschedule_appointment`

- `edge_downtime_node_reschedule_tool_arabic_wait` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_reschedule_success_arabic_wait` → `node_rescheduled` when `{"equations":[{"left":"{{reschedule_success}}","operator":"==","right":"true"},{"left":"{{rescheduled_id}}","operator":"exists"}],"operator":"&&","type":"equation"}`.
- `edge_node_reschedule_tool_else_arabic_wait` → `node_reschedule_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_cancel_tool_arabic_wait` → `cancel_appointment`

- `edge_downtime_node_cancel_tool_arabic_wait` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_cancel_success_arabic_wait` → `node_cancelled` when `{"equations":[{"left":"{{cancel_success}}","operator":"==","right":"true"},{"left":"{{cancelled_id}}","operator":"exists"}],"operator":"&&","type":"equation"}`.
- `edge_node_cancel_tool_else_arabic_wait` → `node_cancel_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_check_silent` → `check_fresh_availability`

- `edge_downtime_node_check_silent` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_calendar_node_check_silent` → `node_calendar_unavailable` when `{"equations":[{"left":"{{calendar_error}}","operator":"==","right":"calendar_unavailable"}],"operator":"&&","type":"equation"}`.
- `edge_availability_yes_silent` → `node_offer` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_availability_no_silent` → `node_no_slots` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"true"},{"left":"{{available}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_availability_error_silent` → `node_check_error` when `{"equations":[{"left":"{{availability_success}}","operator":"==","right":"false"}],"operator":"&&","type":"equation"}`.
- `edge_calendar_transport_node_check_silent` → `node_calendar_unavailable` when `{"prompt":"Else","type":"prompt"}`.

### `node_calendar_save` → `retain_calendar_follow_up`

- `edge_downtime_node_calendar_save` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_calendar_saved` → `node_calendar_saved` when `{"equations":[{"left":"{{calendar_follow_up_saved}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_calendar_save_failed` → `node_calendar_save_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_unknown_save` → `retain_unknown_answer_follow_up`

- `edge_downtime_node_unknown_save` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_unknown_saved` → `node_unknown_saved` when `{"equations":[{"left":"{{unknown_follow_up_saved}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_unknown_failed` → `node_unknown_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_human_save` → `retain_human_escalation`

- `edge_downtime_node_human_save` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_human_saved` → `node_human_saved` when `{"equations":[{"left":"{{human_follow_up_saved}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_human_failed` → `node_human_failed` when `{"prompt":"Else","type":"prompt"}`.

### `node_transfer_gate` → `check_clinic_transfer`

- `edge_downtime_node_transfer_gate` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_transfer_allowed` → `node_transfer_native` when `{"equations":[{"left":"{{transfer_allowed}}","operator":"==","right":"true"},{"left":"{{trusted_transfer_destination}}","operator":"!=","right":""},{"left":"{{trusted_transfer_destination}}","operator":"!=","right":"null"}],"operator":"&&","type":"equation"}`.
- `edge_transfer_after_hours` → `node_transfer_after_hours` when `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"after_hours"}],"operator":"&&","type":"equation"}`.
- `edge_transfer_already_succeeded` → `node_transfer_done` when `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"success"}],"operator":"&&","type":"equation"}`.
- `edge_transfer_follow_up_only` → `node_human_prepare` when `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"not_requested"}],"operator":"&&","type":"equation"}`.
- `edge_transfer_previous_failure` → `node_downtime_prepare_node_transfer_fallback` when `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"previous_failure"}],"operator":"&&","type":"equation"}`.
- `edge_transfer_no_retry` → `node_transfer_done` when `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"already_attempted"}],"operator":"&&","type":"equation"}`.
- `edge_transfer_unavailable` → `node_transfer_unavailable` when `{"prompt":"Else","type":"prompt"}`.

### `node_transfer_fallback` → `retain_transfer_follow_up`

- `edge_downtime_node_transfer_fallback` → `node_downtime_clear` when `{"equations":[{"left":"{{apero_response_received}}","operator":"!=","right":"true"},{"left":"{{apero_system_unavailable}}","operator":"==","right":"true"}],"operator":"||","type":"equation"}`.
- `edge_transfer_follow_up_saved` → `node_transfer_follow_up_saved` when `{"equations":[{"left":"{{transfer_follow_up_saved}}","operator":"==","right":"true"}],"operator":"&&","type":"equation"}`.
- `edge_transfer_late_success` → `node_transfer_done` when `{"equations":[{"left":"{{transfer_result}}","operator":"==","right":"success"}],"operator":"&&","type":"equation"}`.
- `edge_transfer_follow_up_failed` → `node_transfer_follow_up_failed` when `{"prompt":"Else","type":"prompt"}`.

## Loop and dead-end interpretation

One nontrivial explicit strongly connected component contains 162 nodes, because completion/recovery returns to shared task routers. All 320 cyclic edges have canonical return-path witnesses in node-inventory.md. This is complete cyclic-edge coverage, not an impossible enumeration of infinitely repeated conversations. Conditions can make a structural witness infeasible.

- EXPECTED: name/service/contact/preference clarification, local slot clarification, reschedule correction and caller-requested new tasks.
- SUSPICIOUS: valid multi-slot selection → reset failure; same-query correction → unnecessary refresh (H01); unsupported-service and incomplete identity-correction loops; repeated full-request restatement.
- DANGEROUS/CONDITIONAL: uncertain failed booking → new availability token → new key → another write (C03). C01 unbound target/approval affects repeated existing-mutation attempts. Identical keys are idempotent; fresh keys can represent new actions.
- Transfer re-entry cannot cause a second authorized dial under the deployed backend: persistent atomic attempt reservation blocks it. A successful native bridge is an external termination, not an orphan.
- No reachable nonterminal literally has zero outgoing edges. Many conversation nodes have no default because they await an answer. H02/M08/M10 identify valid correction/stop/inquiry utterances with no local matching exit; these are conditional stalls/reprompts, not proved automatic call termination.

## Future manual acceptance priorities — not performed

Do not execute these under the current inspection-only instruction. Review fixes first. Fault/malformed/uncertain cases belong in deterministic offline fixtures rather than deliberately inducing uncertain production mutations.

1. B01/B17: normal booking with at least two distinct returned slots; choose one. Repeat in Arabic. Verify no reset caused solely by multiple slots.
2. B02–B08: service before name; name+service; doctor before service; early date/time; all fields together; any-qualified and sole-qualified. Verify only missing fields are asked.
3. B18–B22: ambiguous/unoffered time, same-query clarification, true date/doctor/service change; expiry first as an offline fixture. Preserve valid state and require fresh checks for real changes.
4. B24–B26: reject final readback; correct scheduling; correct only name or phone. No creation on rejection/correction and no stranded identity path.
5. B27/B28: complete one authorized test appointment and request a separate next one; verify fresh-cycle isolation. Final approval creates real appointments, so use clinic-authorized fixtures and normal cleanup.
6. C01/C02/C09: two authorized appointments for one patient; select A, reject/correct cancellation, verify only explicitly approved A can change. Destructive production testing requires separate clinic authorization.
7. R01/R06/R08/R14/R15: authorized existing appointment, decline/replace new slot, and test only the doctor/service scope agreed after H04 review. No duplicate creation or wrong original target.
8. F01–F12/U01–U06: hours/location, unknown parking/price/practitioner detail, follow-up opt-in/decline, factual interruption during name intake and final consent, then resume original task.
9. H01–H09/T01–T15: human request, optional contact decline and saved/unsaved outcomes. Keep transfer disabled. Provider busy/no-answer/timeout/bridge scenarios remain offline unless separately authorized later.
10. D01–D15/S01–S08: offline calendar/domain/transport failures, failed-booking saved/unsaved/uncertain outcomes, mutation malformed-success rejection, no uncertain write retry and terminal downtime.

No live, manual, simulated, AI-paid, voice or telephony test was performed.

