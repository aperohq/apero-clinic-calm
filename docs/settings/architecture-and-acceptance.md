# Clinic Settings V1 — architecture and acceptance

Status: **DATABASE APPLIED — FRONTEND PUBLISH REQUIRED**. The migration was
applied manually by the operator. Release verification uses disposable accounts
and reversible Settings edits; Tally and Retell synchronization remain separate.

## Audit before coding

There was no Settings route/page/component in this checkout. Settings permissions
were reserved in `src/lib/permissions.ts`, and clinic configuration was Owner-only
through the existing `clinics` UPDATE RLS policy. The Account page edits personal
profile name/phone/password and contains account-directory access; it is not clinic
Settings. Team, practitioners, appointments, calls and integrations remain separate.
There were no persisted Settings controls or Settings placeholder form to finish.

The external Tally form is a collection mechanism for manual APERO onboarding;
it is not an application form or database integration. The user confirmed this
architecture. No Tally form or new onboarding UI was added.

### Canonical storage and field ownership

| Information | Existing storage before this change | Canonical Settings storage |
| --- | --- | --- |
| Patient-facing name | `clinics.name` | Same column |
| Main phone / email | `clinics.phone`, `clinics.email` | Same columns |
| Timezone | `clinics.timezone` | Same column |
| Logo / clinic ID / created date | `clinics.logo_url`, `id`, `created_at` | Preserved; not edited here |
| Arabic/localized clinic name | Retell master `clinic.localized_name` | New nullable `clinics.localized_name` |
| Clinic type | Retell master `clinic.type` | New nullable `clinics.clinic_type` |
| Address | Retell master `clinic.address` | New nullable `clinics.address` |
| Area/city / country | No distinct app/database field | New nullable `clinics.city`, `country` |
| Website | No app/database field | New nullable `clinics.website` |
| Directions / parking | No structured field; approved FAQ/KB may contain facts | New nullable `clinics.directions`, `parking_information` |
| Public hours / regular closures | Retell `clinic.opening_hours` text, not booking authority | New nullable `clinics.opening_hours` JSONB |
| Fallback phone | Retell `escalation.fallback_phone` | New nullable `clinics.fallback_phone` |
| Receptionist names | Retell `speech.receptionist_name`, `receptionist_localized_name` | New nullable matching columns in `clinics` |
| Practitioner weekly availability / time off | `staff_availability`, `staff_time_off` | Unchanged; separate from clinic hours |
| Provider IDs, API keys, secret names, agent/flow/KB IDs, dialing/slot configuration | Private `voice_integrations`, Edge secrets and operator deployment files | Private/internal; not Settings |
| Voice ID, languages, dialect, greeting, prompts, approved policies/FAQ/KB | Retell-managed implementation/approved voice configuration | No prompt editor or integration controls added |

Clinic type is free text, not an authorization/service source. Location remains
one operational clinic record, not a multi-location facility system. All new
values default to NULL: unknown information stays unknown. Receptionist name has
no fabricated default. No speculative integration toggles were added.

## UI and persistence

Owner-only `/account/settings` appears in the existing navigation. Four sections:
Clinic profile, Contact & location, Clinic hours, AI receptionist. No dashboard
redesign or additional settings tabs. Responsive grids, wrapping hour controls,
existing buttons/panels/dialogs and labels preserve the APERO design.

The page loads explicitly selected real fields from the current clinic record.
Only changed fields and their original values go to `update_clinic_settings`.
The RPC accepts no clinic ID, obtains the active Owner's membership, and locks
membership then clinic. The database compares originals only for edited fields:
conflicting edits fail atomically; concurrent edits to other fields are retained.
Its merged UPDATE is based on the freshly locked clinic row, never the browser's
whole stale record. Identity/logo/creation and operational records are not updated.
Optional clearing sends NULL explicitly. Blank required name/timezone is rejected.

Loading, retry, generic errors, successful save, unsaved state, save-in-progress
and explicit discard confirmation are implemented. A synchronous submission
lock prevents double submission; inputs remain disabled during writes. Navigation
and browser unload warn about unsaved changes. Focus/query refreshes preserve
unsaved drafts. Reloading saved values requires confirmation if dirty. Save errors
and stale conflicts keep edits. Late save responses after logout/unmount cannot repopulate
the cleared clinic cache. Background Auth refresh publishes the saved clinic
name/timezone without replacing the form with a loading screen.

Client validation covers name, lengths, email, HTTP(S) website without credentials,
phones (6–15 digits), IANA timezone and structured hours. Only edited values are
normalized/validated, so unchanged legacy optional formatting is not accidentally
rewritten or made a prerequisite for unrelated edits. The form uses explicit validation
rather than native browser constraints that would also block unchanged legacy data. RPC/database failures never
render raw diagnostics; only known validation and generic request messages appear.

## Clinic hours and timezone semantics

`opening_hours` is either NULL (not configured) or:

```json
{"days":[
  {"day":0,"periods":[]},
  {"day":1,"periods":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}]},
  {"day":2,"periods":[]},{"day":3,"periods":[]},{"day":4,"periods":[]},
  {"day":5,"periods":[]},{"day":6,"periods":[]}
]}
```

Seven unique days, Sunday=0, up to four non-overlapping intervals per day. Empty
periods means a regular closed day; split intervals describe closed breaks.
Times use HH:mm, with start before end. Overnight hours must be split across days;
this UI does not introduce a holiday calendar. Public hours are descriptive clinic
metadata. They do **not** constrain bookings, overwrite practitioner availability,
or create practitioner time off. This matches the audited Retell architecture.

Appointments and time off store timestamptz instants. Calendar, time formatting,
slot generation and voice booking read the existing canonical clinic timezone.
Settings changes that timezone only; no appointment/time-off timestamp, checked
slot or history is rewritten. The same instant can display on a different local
clock/date after a change; future weekly practitioner availability is interpreted
in the new zone. Existing appointment conflict/availability checks remain enabled.
The UI explicitly tells Owners to review upcoming bookings before saving a change.
Cached available slots are invalidated and the shared clinic context is refreshed.

## Migration and security

Migration: `20261003200000_clinic_settings.sql`, applied manually in production;
the release verification does not rerun it. Twelve nullable columns on existing `clinics`; no
new configuration table, backfill, historical-record change or Auth/profile deletion.
Existing values/roles/memberships/policies remain unchanged. No migration from the
Team release is rerun on production. User explicitly authorized missing canonical
storage and validation of existing fields.

`validate_clinic_settings()` is SECURITY INVOKER with fixed
`search_path = pg_catalog, public, pg_temp`. Its trigger checks INSERTs and changed
Settings fields on direct UPDATEs too, including service-role/operator writes.
Existing legacy values are not scanned/rewritten on installation, and unrelated
edits leave them intact. Invalid new timezones are rejected against PostgreSQL's
`pg_timezone_names`, with IANA-style identifiers or UTC. Email, URL, phone, lengths
and JSON structure/overlap are validated in the database, not just UI.

`update_clinic_settings(jsonb,jsonb)` is SECURITY INVOKER, same fixed search path,
3-second lock timeout, explicit authenticated EXECUTE; PUBLIC/anon denied. It
locks/validates the real active Owner profile, then its clinic, retains row RLS
and restricted column grants, and whitelists fields. Patch/expected objects each
have a 64 KiB ceiling; no dynamic SQL, external calls, retries, private credentials,
or privileged service-role client. Loops are bounded by sixteen allowed fields,
seven days and four intervals. Trigger execution cannot be invoked as a privileged
RPC by browser roles. New safe metadata column SELECT/UPDATE grants retain existing
RLS. Manager/Staff cannot update through the RPC or direct API; a revoked retained
JWT loses clinic reads and writes via existing live membership helpers.

Owners can read/edit Settings. Managers/Staff have no Settings route or edit
controls; their existing own-clinic operational SELECT of basic clinic metadata
is retained for the dashboard. No policy is broadened. Clinic A cannot read/update
B; a supplied foreign ID/internal field is rejected, and the save RPC exposes no
clinic selector. Provider credentials/prompts never enter the UI.

## Onboarding and Retell synchronization

The canonical model is **Tally/operator collection → existing Supabase clinic
record → dashboard editing that same record**. Operators can populate nullable
columns through trusted existing manual provisioning/database administration;
the Settings load/save tests prove these values use the same row. No automated
Tally bridge, parallel onboarding table or settings JSON mirror was introduced.

Existing Retell onboarding files remain legacy approved deployment snapshots.
This change does not publish/regenerate or live-sync Retell. Before deploying
voice changes, APERO must explicitly reconcile existing localized names/type,
address/public hours, fallback phone and receptionist names into the canonical
record, then synchronize approved public facts/name changes to the appropriate
Retell agent/flow/KB. Structured hours require deliberate conversion from legacy
free text; they are not guessed. Null canonical metadata must not silently replace
approved voice facts. No receptionist name/fallback change will affect an existing
published agent until that explicit synchronization occurs. The UI states this.
Website/location/directions/parking should likewise be reconciled with relevant
approved KB facts. Provider IDs, keys, secret names, internal prompts and dialing
rules stay outside clinic-facing settings throughout this process.

## Validation and remaining production steps

Tests exercise real local PostgreSQL RLS/trigger/RPC authorization, migration
compatibility and direct malformed writes, plus real React/Auth/Supabase SDK UI
flows with local HTTP fixtures. They never use production credentials/services.
Final command results are recorded below after validation.

For this authorized release: verify the installed migration, preserve approved
optional values, publish the frontend manually in Lovable, and complete final
published-frontend acceptance. Database/API acceptance uses disposable signed-in
accounts, immediate restoration of each real-clinic Settings edit, and complete
operational-record and membership comparisons. No new Edge deployment
is required for Settings; persistence uses the new SQL RPC. Voice synchronization
is separate and requires its own explicit review/acceptance before publication.

### Final local results

The accepted HEAD plus only the sixteen Settings files was exported into an
isolated local checkout, excluding unrelated mobile/layout, Retell, backend and
untracked prerequisite changes. All relevant checks passed there:

| Suite | Passing results |
| --- | ---: |
| Settings database/input validation | 65 |
| Settings UI | 32 |
| Auth | 29 |
| Invite/setup | 11 |
| Team / invitations / hardening / Team UI | 71 |
| Provisioning / operator CLI | 47 |
| Permissions / permissions UI | 23 |
| Clinic isolation | 133 |
| Appointments / Calendar UI | 37 |
| Appointment conflicts / migration compatibility | 42 |
| Clinic-time runtime | 3 |
| Voice routing / real Edge handler isolation | 15 |
| Request-security runtime | 5 |
| **Total** | **513** |

Database regression suites were run with `APERO_TEST_SETTINGS_MIGRATION=1` and
`APERO_TEST_TEAM_MIGRATION=1` so the proposed Settings migration was present.
The Settings suite separately checks installation against unchanged legacy data.
Existing TypeScript runtime tests were compiled with esbuild and executed as
CommonJS to verify their individual assertions, rather than counting file-only
Node runner markers. Repeated checks are not counted twice.

Frontend TypeScript, existing invitation Edge/backend TypeScript, production
build, targeted lint and working `git diff --check` all passed. There are two
existing Auth Fast Refresh warnings and zero lint errors. Compact existing shared
files were checked with their existing formatting-rule exception; all new
Settings TypeScript/TSX uses normal formatting lint. A scan of 43 local frontend
assets found no Supabase secret/service-role key or private-key exposure.

### Exact Settings file list

- `package.json`
- `src/components/app-layout.tsx` (Settings navigation only; existing local edits preserved)
- `src/components/clinic-settings-panel.tsx`
- `src/lib/auth.tsx` (optional background refresh and nested clinic equality)
- `src/lib/clinic-settings.ts`
- `src/lib/clinic-settings-api.ts`
- `src/lib/db-types.ts`
- `src/lib/permissions.ts` (reserved-module comment only; existing rules retained)
- `src/routes/account_.settings.tsx`
- `src/routeTree.gen.ts` (generated Settings route registration)
- `supabase/migrations/20261003200000_clinic_settings.sql`
- `tests/clinic-settings.test.mjs`
- `tests/clinic-settings-ui.test.tsx`
- `tests/helpers/clinic-database.mjs` (optional Settings migration in local tests; existing edits preserved)
- `tests/run-clinic-permission-tests.mjs` (local Settings HTTP/UI fixtures)
- `docs/settings/architecture-and-acceptance.md`

The website validator uses PostgreSQL’s built-in `inet` parser for bracketed IPv6
hosts. Regression coverage exercises valid URLs, both reproduced malformed hosts,
broken URL structures and optional clearing through the save RPC and direct Owner
updates. Invalid values return the existing generic Settings validation error.

No Edge deployment or migration application is required during this release.
No paid resources, voice calls or Retell synchronization are part of acceptance.

Production release evidence: [production-acceptance.md](production-acceptance.md).
