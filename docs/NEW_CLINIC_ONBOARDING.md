# Add a clinic using Apero Master v1

Use `retell/master/prepare.py`. The older `retell/build_flow.py` and Dental Zone
artifacts remain historical/reference tooling; do not use them to instantiate a
new clinic. [Master architecture and configuration](APERO_MASTER_V1.md) explains
field ownership and limitations. The exact onboarding schema is
`retell/master/config.schema.json`.

## Required information

- Existing Apero clinic record (name, phone, timezone), single address/location,
  active practitioners with canonical services/aliases, saved hours and time off.
- Clinic type and approved English/Arabic clinic and receptionist names; default
  language, supported Arabic/English languages, spoken dialect, greeting and voice.
- Approved public hours, pricing/insurance policy, FAQ answers or a clinic-owned
  KB, and the person/revision approving these facts. Unknown facts may stay unknown.
- Callback availability, urgent callback policy, emergency guidance and optional
  fallback phone. v1 has persisted callbacks/messages/urgent requests; no live transfer.
- New Retell workspace/key, explicit dialing prefix, local number length, slot
  duration, and telephony number when assigned. Record new agent/flow IDs after creation.

## Exact process

1. **Create clinic and scheduling data.** Use Apero's existing clinic/staff data
   model. Save active staff, services, aliases, weekly hours and time off. v1 is one
   operational location; public opening hours never override staff availability.
2. **Create the clinic's Retell workspace.** Obtain its API key; verify its exact
   ID with `GET https://api.retellai.com/get-api-key-info` using that key. The
   response `org_id` is authoritative and case-sensitive. Never reuse Dental Zone's
   workspace/key for another clinic. Choose an accessible approved voice.
3. **Collect configuration.** Copy `retell/master/config/template.json` into a
   private developer configuration file, set `mode` to `clinic`, supply its existing
   UUID and fill the schema fields. `prepare.py` refreshes name/phone/timezone from
   the database. Keep raw API keys out of JSON, SQL, prompts and frontend tables.
4. **Approve knowledge and telephony.** Enter approved FAQ/policy facts in the
   config, or create that clinic's approved Retell KB and record its IDs. Empty KB
   is supported. Obtain/connect telephony separately; the script never buys numbers.
   Keep inbound public routing disconnected until acceptance testing is complete.
5. **Prepare and validate locally.** Set `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` in the developer environment, then run:

   ```bash
   python3 retell/master/prepare.py --config /private/clinic.json --output-dir /private/clinic-output
   ```

   The script validates the existing clinic, active staff/services, saved hours,
   schema and integration uniqueness. It outputs `flow.json`, `agent.json`, a
   backend snapshot and `resolved-config.json`. Snapshots contain staff details;
   keep real-clinic output private. No external write occurs by default.
6. **Create the separate clinic draft.** Set `RETELL_API_KEY` to the NEW workspace
   key and rerun with `--create-draft`. This verifies workspace/voice/KB ownership
   and refuses a key that can access any already integrated clinic agent, even if
   historical workspace metadata contains a typo. It creates a new flow and agent;
   it never updates an existing agent or publishes.
   IDs are recorded immediately in `retell-created.json`; do not rerun creation
   after a partial failure without inspecting this file. Use the generated flow
   instead of manually editing 53 nodes or copying Dental Zone's agent IDs.
7. **Register the trusted integration.** Put that key in Supabase Edge secrets
   under the unique configured `RETELL_...` name. Review/apply the generated
   `register-inactive.sql` using write-capable server credentials. It inserts an
   inactive row and intentionally fails on duplicate clinic/workspace/agent/secret.
   Do **not** rerun migration 05 to onboard a clinic: it is historical and already
   applied in this project. The shared deployed backend already supports new rows.
8. **Test without public telephony.** Inactive mappings reject calls, so enable
   only the dedicated clinic/test mapping when ready for controlled signed tests.
   Keep the agent draft and public inbound number disconnected. Run tenant/RPC
   isolation, signature, checked-slot, stale-slot, booking/reschedule/cancellation,
   persistence and webhook tests using synthetic patients in an isolated test clinic.
   Run the 45 mocked Retell text scenarios. Never attach the unbound generic master
   itself to Dental Zone. If testing fails, disable the new mapping.
9. **Accept, publish and activate public routing.** Perform controlled audio and
   phone acceptance for the clinic's approved voice, language, timezone, knowledge
   and callbacks. After approval, publish that clinic's agent, connect its number
   and verify the webhook/dashboard. Monitor failures and tenant ownership. The
   generic master stays an unbound draft for future instantiation.

## Current project state and workspace note

Migration `db/05_voice_integrations.sql` was already applied in September 2026;
all four deployed voice functions match current repository source. This master
implementation requires no additional schema migration or redeployment.

The historical Dental Zone seed contains `org_Ybi3pl9fq16wgTf6` (lowercase **l**),
while the current key's `get-api-key-info` returns `org_Ybi3pI9fq16wgTf6` (uppercase
**I**). This metadata discrepancy is recorded, not silently changed. Routing uses
verified agent/key mapping and the signed Dental Zone probes pass. Do not copy
that historical seed into new clinic configuration; always query the new key's
actual `org_id`. Correcting historical metadata should be a separate reviewed
change, since rerunning migration 05 asserts its original seed value.

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
