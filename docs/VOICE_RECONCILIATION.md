# Dental Zone voice reconciliation — 2026-09-18

Migration 05 was applied manually by the owner on 2026-09-18. This pass verified the live schema and deployed current Edge Function source. Retell was inspected read-only and was not changed. No appointment, conversation, or clinic-facing request was created.

## Migration decision

Migration 05 is the sole applied voice-integration migration. Draft 07 had identical executable SQL from `begin;` through `commit;` and was removed from the workspace without being applied. It contributed no new schema or behavior.

Migration 05 creates the service-role-only `voice_integrations` table and seeds Dental Zone's active workspace, agent, flow, knowledge base and secret **name**; creates clinic-owned `clinic_service_aliases` with service synonyms; merges practitioner aliases into four staff rows; adds clinic-ownership guards to voice call state and voice-linked conversations; and replaces `voice_apply_appointment` with per-clinic dialing settings. It did not delete operational records or update appointments. It did update four staff configuration rows.

## Verified live state

| Object | Live state after 05 |
|---|---|
| `voice_integrations` | One active Dental Zone row with clinic `11111111-1111-4111-8111-111111111111`, workspace `org_Ybi3pl9fq16wgTf6`, agent `agent_b84b2766efeb85afc809147d7a`, flow `conversation_flow_43f53e5e8531`, KB `knowledge_base_5e52df7d832025dc`, and secret **name** `RETELL_API_KEY`; no raw-key column |
| `clinic_service_aliases` | 30 rows, all owned by Dental Zone; RLS enabled, browser roles have no SELECT |
| `voice_operations`, `voice_call_state`, `voice_checked_slots`, `voice_requests` | Present with RLS enabled and expected service-role grants |
| `staff_availability`, `staff_time_off` | Present with RLS enabled; no clinic/staff mismatches |
| `voice_apply_appointment` | Live body matches migration 05 after whitespace normalization; security definer, service_role EXECUTE only |
| Voice clinic-ownership guard | Both enabled triggers call `voice_reject_clinic_change` |
| `staff.aliases` | All four Dental Zone staff rows have aliases (13, 5, 5, and 4 values) |

The live RPC retains clinic, call, patient, staff, service, checked-slot ID and expiry, schedule, time-off, and appointment-conflict checks for booking/rescheduling/cancellation. Service_role has SELECT on operations and time off; SELECT/INSERT/UPDATE on call state and staff availability; INSERT on checked slots; SELECT/INSERT on requests. Direct service-role SELECT on checked slots and INSERT on operations are unnecessary because the security-definer RPC performs those internally. `voice_integrations` and `clinic_service_aliases` are inaccessible to anon/authenticated roles; service_role has the grants from 05.

## Deployed functions and published Retell flow

Each function's deployed bundle hash matched its validated source bundle; all are ACTIVE with `verify_jwt=false`:

| Function | Current version | Published flow use |
|---|---:|---|
| `clinic-operations` | 5 | All 10 published tool URLs |
| `retell-webhook` | 7 | Agent/account webhook destination must be confirmed in Retell dashboard |
| `check-availability` | 6 | No flow tool URL |
| `book-appointment` | 5 | No flow tool URL |

The published Dental Zone agent is `agent_b84b2766efeb85afc809147d7a`; its published conversation flow remains `conversation_flow_43f53e5e8531`, version 2, with the expected KB. All ten flow tool URLs still point to `https://svoybvzvmygszklcmudh.supabase.co/functions/v1/clinic-operations`. No Cal.com or legacy endpoint URL occurs in that flow. The agent API response omits a webhook URL, so its account-level destination still needs a manual Retell dashboard check. Retell was not republished.

## Production verification and limits

- All four unsigned POSTs returned 401. Signed read-only Dental Zone lookup returned 200; wrong signature and unknown agent returned 401. A signed lookup with a forged clinic ID returned the same Dental Zone result. A signed webhook `call_started` event returned 204 without persistence; the unsigned event returned 401.
- A signed availability fixture using Dr. Ahmed's alias found no Saturday slots and ten 45-minute Sunday slots in `Asia/Kuwait`. Ten checked-slot rows were read back with the expected Dental Zone clinic, practitioner and service; one synthetic call-state row was created. A forged clinic ID combined with the `cleaning` service alias still resolved Dental Zone's Dental Cleaning and returned no Saturday slots. No appointment, conversation, voice operation, or clinic-facing request was created by these fixtures. The ten checked slots expire; the synthetic call state remains for planned operational-data cleanup.
- Signed invalid book/reschedule slot IDs returned `stale_or_invalid_slot`; a signed cancellation using a nonexistent fixture appointment returned `appointment_not_found`. The appointment count stayed at eight. Automated tests cover disabled days, changed hours, time off, service/practitioner aliases, clinic routing and appointment overlap. Live time-off filtering could not be exercised because Dental Zone has no time-off row. Completed booking/rescheduling/cancellation and webhook persistence require controlled acceptance calls or non-production fixtures.
- Source inspection confirms webhook signature verification is awaited; call ownership is checked before upsert; transcript, recording and summary are written; client and appointment lookups are clinic-scoped; outcomes derive from persisted voice operations/requests. A client-query error now fails the webhook rather than silently losing the association. `message`, `callback`, and `urgent` use `voice_requests` with an idempotent request key; their live persistence was not tested because doing so would create clinic-facing work items.

The legacy `book-appointment` function remains directly reachable for signed callers and uses its historical 30-minute booking path; it is not referenced by the published Retell flow. Keep it out of new flows pending a separate decision about retirement or alignment with checked-slot booking. The current published flow uses `clinic-operations` and its checked-slot RPC path. Confirm the Retell webhook destination and perform controlled real-call acceptance before clinic handoff.
