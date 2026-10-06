# Production baseline reconciliation for recovery

Read-only inspection on 2026-10-06. No migration replay/history repair/schema change performed. Rebuilding a replacement project must use the verified current logical schema/data/history archive first; repository migrations alone are not a complete seed-free foundation.

Remote history lists:

| Version | Recorded name |
|---|---|
| 20261004140000 | recording_access |
| 20261004202035 | calendar_unavailable |
| 20261005062030 | calendar_acceptance_fixture_cleanup |
| 20261005073058 | unknown_answer_acceptance_fixture_cleanup |
| 20261005105457 | human_escalation_acceptance_fixture_cleanup |
| 20261005105529 | human_escalation_acceptance_fixture_cleanup |
| 20261005121714 | call_transfer |
| 20261005124033 | call_transfer_acceptance_fixture_cleanup |

The table below compares intended local changes with **catalog-verified live effects**. Function hashes compare trimmed bodies with whitespace normalized (`prosrc`, not patient rows). Hash matches prove those compared bodies, not every grant/statement or complete migration equivalence.

| Local source | Verified production effect | History / recovery finding |
|---|---|---|
| `db/01_phase2_schema.sql` | Core clinic/profile/patient/staff/schedule/appointment/call/note/notification tables, enums, policies and guards exist | Historic schema predates recorded history; file also contains development seeds. Never replay whole file into production or seed a replacement with it. |
| `db/03_voice_operations.sql`, `04_voice_service_role_grants.sql`, `05_voice_integrations.sql` | Voice state/operations/slots/requests, integration mappings and aliases exist; `voice_reject_clinic_change` normalized body matches `05` (`36928d152a953b034f7e65ab0bf9664c`) | Earlier `voice_apply_appointment` bodies are superseded by shared-booking migration. Internal reliability state must come from dump. |
| `db/06_staff_scheduling.sql` | Time-off/schedule structures and `create_staff_with_schedule` body match (`c769b5dd29a79d6a4710bb395028ea70`) | No matching remote version recorded; do not replay because history is absent. |
| `db/07_prelaunch_security.sql`, `09_client_notes_restrict_update.sql`, `10_clinic_access_privileges.sql` and local role patches | Anonymous client SELECT false; authenticated client SELECT true; conversation INSERT false; note UPDATE false; voice request status UPDATE true. Profile guard now matches team migration | These effects are verified, but entire historical grant/policy equivalence is not certified. Main and local role patches differ; live ACL/policies in backup are authoritative. |
| `20261002190000_shared_appointment_availability.sql` | `appointment_available_slots` body `a2f6016127364c1210ccdbb3283ad3be`, `guard_appointment_booking` `dfc9d68483ea771ec7c0f79e2de2af21`, `voice_apply_appointment` `4d59828df09ce27a59c475120e51cda9` all match; shared no-overlap constraint exists | Absent remote history despite matching compared bodies/constraint. Do not apply again. |
| `20261003160000_clinic_team_management.sql` | Invitation tables/profile `revoked_at`, team functions exist. `current_clinic_id`, `current_profile_role`, profile guard, `set_clinic_member_role`, `clinic_team_members` normalized bodies all match | No remote version recorded. Capture complete definition/ACL before any reconciliation. |
| `20261003200000_clinic_settings.sql` | Clinic settings columns and validation trigger exist; `validate_clinic_settings` body matches (`1d7b79bbc47ec8b966d46c0eef8ae8a8`) | `update_clinic_settings` is superseded by transfer migration; replaying old settings file could revert live behavior. |
| `20261004120000_clinic_analytics.sql` | `clinic_analytics` body matches (`3e02dc64f17706dd3c26f5508509ad6e`) | No remote version recorded; retain actual live definition. |
| `20261004140000_recording_access.sql` | Matching version recorded | Preserve existing history and recording-access permissions. |
| Local `20261004180000_calendar_unavailable.sql` | Calendar-unavailable state column exists | Actual recorded version is `20261004202035`; do not insert a second timestamp claiming it is another change. |
| Local `20261005120000_call_transfer.sql` | Transfer state/config/constraints exist; current `update_clinic_settings` body matches transfer source (`1b8daeda89abf7855d0deb8610f0d43d`) | Actual recorded version is `20261005121714`; local filename/history timestamp discrepancy requires reviewed reconciliation. |
| Local untracked `db/08_voice_requests_handling.sql` | Live voice_requests has only id/clinic/request/call/kind/contact/reason/status/created_at (11 columns), no new handling fields | Main lacks this file although helpers reference it; do **not** treat this proposal as already applied or fold it into a live baseline. |

## Safe reconciliation plan

1. Obtain first real verified encrypted backup including `supabase_migrations` and value-free schema fingerprint; keep Git/source hash and normalized body comparisons as evidence.
2. Restore exact schema/data/history into an isolated compatible environment. Capture a **schema-only** current baseline there (without seeds/patient values or secrets); retain it encrypted until privately reviewed. Separate managed Auth/Storage baseline from application schema and customizations.
3. Compare tables/types/columns/defaults/indexes/constraints, functions/signatures/body hashes, triggers, policies, owners/table/column/function/default ACLs, extensions/publications, and history against every proposed baseline. Body matches above are only part of this check.
4. Produce one reviewed seed-free baseline for **new projects only** plus explicit supersession/history mapping. The baseline must match live state, exclude unshipped local proposals and acceptance-cleanup operations, and pass a fresh compatible-project build + two-clinic RLS/RPC suite.
5. Separately decide whether to repair existing history or retain legacy history and adopt a forward baseline cutover. If history repair is selected, review exact timestamps/names and statement hashes, apply only proven equivalence with Supabase migration-history discipline, and never execute historical DDL merely to add a history entry. This is a future explicitly reviewed production metadata change, not authorized implicitly by this backup task.
6. For incident recovery now, restore the current verified archive/history and deploy the matching source version. Do not blindly run `supabase db push`, initial seeds, cleanup migrations, or mark missing versions applied. Future migrations start only after history/baseline review and a new backup.

Missing baseline history does not invalidate a successful complete logical restore; it prevents claiming a migration-only rebuild. Completion evidence must say which recovery path was actually tested.
