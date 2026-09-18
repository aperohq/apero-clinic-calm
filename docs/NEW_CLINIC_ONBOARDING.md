# Add a clinic voice integration

Production is unchanged until the migration and functions are deployed. The dashboard already reads tenant data; this guide covers the voice path.

## Inventory of Dental Zone bindings

| Location | Binding | Resolution |
|---|---|---|
| `clinic-operations`, `retell-webhook`, legacy `book-appointment`, `check-availability` | Dental Zone UUID; first two also pinned agent ID | Server-only `voice_integrations` lookup by agent ID, then raw-body signature verification with that workspace's Edge secret |
| `clinic-operations/logic.ts` | Four staff UUIDs and pronunciation aliases | Aliases moved to `staff.aliases` by migration 05 |
| `clinic-operations/logic.ts` | Dental service synonyms | Moved to tenant-owned `clinic_service_aliases` by migration 05 |
| `clinic-operations/logic.ts`, `db/03_voice_operations.sql` | `+965` and eight-digit numbers | Per-integration dialing prefix and local length in migration 05; Dental Zone defaults remain |
| `clinic-operations` | 45-minute slot | Per-integration `slot_minutes`; Dental Zone default 45 |
| `retell/build_flow.py` | Clinic name, Arabic greeting, location, timezone, phone, hours, KB ID, tool URL, transfer wording, pricing/insurance wording | `retell/config/*.json`; common 53-node source is generated once per clinic |
| `retell/dental-zone-flow.json`, `retell/dental-zone-knowledge.md` | Published Dental Zone flow and KB source | Retained as Dental Zone artifacts, not used as Clinic B configuration |
| `db/01_phase2_schema.sql`, `db/02_link_owner_profile.sql` | Dental Zone seed data and owner link | Historical setup scripts only; do not rerun for onboarding |
| `src/routes/*.tsx`, `src/components/clinic-pages.tsx`, README | Dental Zone page metadata, examples, static copy | Dashboard scope excluded from this refactor |

The old `book-appointment` and `check-availability` functions now require trusted integration resolution but retain their older scheduling contract. New agents must use `clinic-operations`, which uses persisted checked slots and the atomic appointment RPC. Do not point a new flow at the legacy functions.

## Actual process

1. Create a clinic row, staff with `services` and `aliases`, optional `clinic_service_aliases`, and `staff_availability` and any time off. The clinic row supplies the authoritative timezone; staff rows supply practitioner and service choices. Confirm the clinic's owner and RLS access.
2. Create a separate Retell workspace for this clinic. Obtain its agent ID and workspace API key. A workspace and its key must be unique per clinic. Keep the key in Supabase Edge Function secrets under a unique `RETELL_...` name. Never enter it in a client table, JSON config or flow definition. Vault was not used because Edge Function environment secrets already provide server-only access; the database stores only the secret's environment variable name.
3. Create the clinic knowledge base from approved clinic facts and record its ID. Set up telephony and record assigned number separately. Transfer remains disabled until a real transfer mechanism and destination are configured; a configured number alone does not enable a transfer tool.
4. Fill a clinic JSON file using `retell/config/dental-zone.json` as a schema example. Enter identity, Arabic name, address, hours, languages, KB ID, timezone, tool URL, phone rules and booking duration. Do not copy Dental Zone IDs or its knowledge document. Set `tool_url` to the deployed `clinic-operations` endpoint.
5. Run `python3 retell/onboard_clinic.py --config path/to/config.json --output /tmp/new-clinic-flow.json` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the developer environment. It reads clinic and staff data, checks timezone, staff and services, and writes a local flow. It does not create or publish resources. For offline validation, use `--fixture retell/config/clinic-b.fixture.json` with the local Clinic B config.
6. `db/05_voice_integrations.sql` was applied to the live Dental Zone project on 2026-09-18, after `db/04_voice_service_role_grants.sql`. It seeded the existing workspace and agent with the `RETELL_API_KEY` secret name, copied staff aliases, and updated the appointment RPC. Current source for `clinic-operations`, `retell-webhook`, and both legacy endpoints was deployed with shared `_shared` code. Keep Dental Zone's existing Edge secret. The duplicate draft numbered 07 was removed without applying it.
7. Insert a new `voice_integrations` row with the new clinic ID, distinct workspace/agent/secret names, KB and flow IDs, dialing prefix, number length and slot duration, with `active=false`. Verify secret presence on the server. Apply generated flow in the correct Retell workspace. The generator writes local JSON only; publishing requires a separate owner-reviewed action.
8. Test signed tool calls, unknown agent rejection, other-workspace signature rejection, clinic-scoped staff and appointment lookup, checked-slot expiry and stale slots, webhook routing and idempotency. Then run live acceptance calls for booking, reschedule, cancellation, corrections, messages and urgent callback.
9. Only after acceptance, set `active=true` and connect telephony. Monitor webhook failures and tenant-scoped conversations.

## Request boundary

The unverified `call.agent_id` is only a lookup hint. The server loads its single integration row using the service role, obtains the named Edge secret, and verifies the raw signed body. A request claiming another clinic's `clinic_id` is ignored. Unique workspace IDs and secret names prevent duplicate mapping rows; the server also rejects an active integration when another clinic's configured secret has the same actual value. All reads and writes use the resolved clinic ID. Checked-slot tokens contain clinic ID and are signed with that workspace key; the database RPC checks clinic, staff, call, check and slot IDs again. `voice_call_state.call_id` has a global primary key, so the endpoint rejects an existing call ID owned by another clinic before writing.

## Limits requiring owner decisions

- Supply a dedicated Retell workspace, agent, KB, API key and telephony for each new clinic. Dental Zone's workspace ID `org_Ybi3pl9fq16wgTf6` is recorded in the seed and local config. A read-only `GET /get-agent/{agent_id}` with the existing `RETELL_API_KEY` confirms the key can access that agent; the response itself omits the workspace ID.
- Approve clinic language, phone rules, slot duration, business policies, transfer implementation and destination. The current flow offers persisted callbacks; it does not perform live transfer.
- The base flow assumes a receptionist and dental appointment language in some node copy. Review generated Clinic B prompts and KB before publishing for a clinic with different clinical services.
- The legacy scheduling endpoints are retained for compatibility, but they lack the newer checked-slot protocol and should be retired after confirming no old Retell tool still calls them.
