# APERO Analytics production safety audit — 2026-10-04

Current release status: the migration is now installed. See [production-release.md](production-release.md) for live Owner acceptance and publication status. Do not reapply it.
**Exact migration: `supabase/migrations/20261004120000_clinic_analytics.sql`.**

**Verdict: SAFE TO DEPLOY — the latest local files pass this pre-deployment audit.** Nothing was deployed, pushed or modified in production. Hosted access used the Supabase read-only database role and explicit `BEGIN TRANSACTION READ ONLY` transactions. The proposed function is absent from production, so it was never installed or called there. Its aggregate SELECT was evaluated directly against production rows, and independently reconciled in the same database snapshot. Actual hosted RPC/session acceptance remains a release-time check.

## Requested audit result

| # | Check | Result |
| --- | --- | --- |
| 1 | Release verdict | SAFE TO DEPLOY after the narrow fixes described below, already completed locally |
| 2 | Migration | `20261004120000_clinic_analytics.sql` |
| 3 | Exact database object | Adds `public.clinic_analytics(uuid,date,date) RETURNS jsonb`, including its execution ACL; changes no other existing function/table/policy/index/trigger. Sends `NOTIFY pgrst, 'reload schema'` |
| 4 | Destructive operations | NO |
| 5 | RPC security | PASS |
| 6 | Owner/Manager/Staff | PASS — Owner/Manager allowed; Staff rejected |
| 7 | Cross-clinic isolation | PASS — trusted membership clinic, explicit clinic equality, and existing RLS |
| 8 | Read-only guarantee | PASS — aggregate SELECTs only; succeeds inside a local read-only transaction; product snapshots unchanged |
| 9 | Metric correctness | PASS — fixtures and complete production aggregate equality |
| 10 | Timezone/range correctness | PASS — canonical timezone, inclusive dates/exclusive upper instant, 7/30/90, UTC boundaries/DST, invalid/missing zone rejection |
| 11 | Production schema compatibility | PASS — actual hosted columns/types/nullability/helpers/roles/grants/policies/FKs/indexes inspected |
| 12 | Production-data reconciliation | PASS — every proposed metric and every trend bucket equals independent raw-data calculations |
| 13 | Query performance | PASS for current V1 scale — actual read-only production EXPLAIN ANALYZE; no index needed |
| 14 | Existing module compatibility | PASS — no shared database object replaced; all requested regression suites pass |
| 15 | Tests/build | PASS — details below |
| 16 | Required changes before production | No outstanding code or schema correction. Use the latest migration/page with the timezone guard, not an earlier copy |
| 17 | Safe through Supabase SQL Editor | YES — apply the complete latest Analytics migration as the normal administrative SQL Editor role when a release is authorized; existing prerequisites are present in audited production |

## Migration and security proof

The only `CREATE OR REPLACE FUNCTION` targets the new Analytics signature. Production catalog inspection found **no `clinic_analytics` overload**, so no pre-existing production function would be replaced. Local migration tests compare every other public function definition and confirm they remain identical. This audit does not approve applying unrelated migrations in the working tree.

There is no table recreation, ALTER TABLE, DROP, TRUNCATE, DML, policy replacement, RLS change or index addition in this migration. Local tests compare all existing product rows and policies before and after application. No existing rows change. The transaction applies function creation and ACL atomically; a failure rolls back the migration.

`STABLE SECURITY INVOKER` is the correct choice: authenticated callers already have SELECT privileges on all five required relations, and their existing RLS remains active. There is no need to elevate aggregate reads into a definer function. The function itself has a fixed `pg_catalog, public` search path, qualifies all application relations and membership helpers, and uses no dynamic SQL. Production authenticated users have no public-schema CREATE privilege.

Execution is granted only to `authenticated`; PUBLIC, anon and service_role execution are explicitly revoked. Local privilege tests prove anon/service_role lack EXECUTE. Successful execution also requires non-null `auth.uid()`, an active membership, an unrevoked profile, and real Owner/Manager database role. The production membership helpers are STABLE SECURITY DEFINER SELECT-only functions that filter `revoked_at IS NULL` by `auth.uid()` and have fixed search paths. Production enforces UNIQUE `profiles.auth_user_id`, preventing ambiguous membership resolution.

The caller's `p_clinic_id` is a consistency assertion, not an authority source: it must equal the clinic derived by `current_clinic_id()`. Every product query uses that derived value. Supplied foreign/nonexistent/null IDs fail; JWT metadata roles/clinic IDs do not grant access. The function also checks an actual unrevoked profile. Local non-bypass-role tests cover Owner, Manager, Staff with forged metadata, missing Auth identity, anonymous and retained revoked sessions. Cross-clinic tests use two local tenants with independent records. Audited production currently has one clinic and no Manager account, so the role/isolation attack cases were tested locally against PostgreSQL rather than fabricated in production.

The RPC selects only aggregate counts, dates, recorded service labels, and same-clinic practitioner IDs/names. It does not read voice integrations, tokens, secrets, call transcripts, recordings, phone numbers, client records or account-directory contents. Practitioner UUIDs are ordinary authorized same-clinic identifiers used to keep entities separate; none are hardcoded in the frontend, published publicly or rendered as debug information.

## Read-only guarantee

The function reads `conversations`, `appointments`, `staff`, `profiles`, `clinics` and the PostgreSQL timezone catalog. Existing membership helpers perform SELECTs only. There are no writes, dynamic statements, mutating RPC calls, row locks or triggers invoked by this aggregate. `STABLE` further rejects DML inside its own body. A local authenticated call succeeds under `BEGIN READ ONLY`; snapshot comparisons prove calls leave all product relations unchanged, including clients, practitioner records, memberships and Settings fields in clinics. Services are stored appointment text and practitioner arrays, not a separate table; neither is modified. Historical timestamps are never rewritten.

This guarantee applies to Analytics. Existing operational API permissions remain available through their own routes; Analytics does not revoke or broaden them.

## Metric and edge-case validation

Definitions remain in [implementation-and-acceptance.md](implementation-and-acceptance.md). Calls count stored conversation rows filtered by `started_at`. Appointments count rows filtered by their current scheduled `start_time`. Both include all statuses. Booked and Cancelled use exact current status values, not booking/cancellation event histories. Daily buckets use the corresponding timestamp converted to the persisted clinic timezone.

Practitioners group by `staff_id` **and** the corresponding name; they do not group by name alone. Two distinct practitioners with the same display name produce two distinct ID groups. Tests insert duplicate names with separate appointment counts and prove they are not merged. A deleted practitioner has its appointment FK set to NULL by the existing FK; those appointments remain counted under Unassigned. The same-clinic join cannot attach a foreign-clinic practitioner's name. A null FK groups safely; full_name is NOT NULL in production.

Service grouping uses exact stored text, preserving case, Arabic variants and aliases. Tests prove `Case` and `case` remain separate, and an empty label renders as Unspecified. Production service/status/timestamp columns are NOT NULL, so NULL service/status values cannot exist in the audited schema. UI tests additionally exercise a null label defensively and prove HTML-like service labels render as plain text without element injection. No fuzzy service consolidation or unearned lifecycle interpretation was added.

For every 7/30/90 fixture range, daily calls sum to total calls, daily appointments sum to total appointments, current status counts reconcile, and practitioner counts plus remainder reconcile. Both breakdowns retain remainder counts beyond their highest 20 groups. Empty clinics, calls-only and appointments-only cases pass.

## Production schema and reconciliation

Production catalog checks on 2026-10-04 confirmed:

- conversations clinic UUID and NOT NULL timestamptz `started_at`;
- appointments clinic UUID, NOT NULL timestamptz `start_time`, NOT NULL text `service`/`status`, nullable staff UUID;
- staff UUID primary key, clinic UUID and NOT NULL text full_name;
- profiles Auth UUID UNIQUE, clinic UUID, `profile_role` enum with owner/manager/staff, nullable revoked_at;
- clinics UUID and NOT NULL text timezone, currently valid `Asia/Kuwait`;
- practitioner FK `ON DELETE SET NULL`;
- all five relations have RLS enabled, with clinic-scoped SELECT policies;
- authenticated SELECT privileges are present, and authenticated/anon roles have neither superuser nor RLS bypass;
- both existing clinic/date indexes and the membership/staff lookup indexes are present.

Production appointments currently have 10 Booked and 1 Cancelled. There are no blank service names, null staff references, null appointment statuses or noncanonical cancelled spellings. There are no duplicate practitioner names or duplicate membership Auth IDs. Calls have Missed, Completed, Booked and Needs Review statuses. No call status/outcome is interpreted as an appointment event.

For Dental Zone Clinic, the **last 30 clinic days as of October 4: September 5–October 4, 2026**, use UTC interval `[2026-09-04 21:00:00Z, 2026-10-04 21:00:00Z)`.

| Production metric | Independent raw result | Proposed aggregate result |
| --- | ---: | ---: |
| Calls | 29 | 29 |
| Appointments | 11 | 11 |
| Booked | 10 | 10 |
| Cancelled | 1 | 1 |
| Other appointment statuses | 0 | 0 |
| Daily call sum | 29 | 29 |
| Daily appointment sum | 11 | 11 |
| Practitioner groups/counts | 4: 7, 2, 1, 1 | identical |
| Service groups/counts | 10: one group of 2, nine groups of 1 | identical |
| Breakdown remainder counts | 0 | 0 |

SQL compared the **entire JSON payload**, including each zero-filled daily bucket, labels, stable IDs and order: `equal = true`, inside one read-only snapshot at `2026-10-04T07:11:06Z`. Independent raw filtering used clinic-local dates; the proposed SELECT used converted UTC bounds. This was a SELECT-only reproduction of the function's aggregation, not a deployed RPC call.

Production service variants include Dental Cleaning / Cleaning / تنظيف أسنان / تنظيف الأسنان, Veneers / Veneers Consultation, and Arabic orthodontic consultation text. These are separate historical groups by design. Their consolidation would require a separately specified reliable mapping and is not a release blocker for exact-text V1.

[production-safety-evidence.json](production-safety-evidence.json) records actual schema, policies, constraints, reconciliation and plan summaries without patient/contact/secret data. [production-reconciliation.sql](production-reconciliation.sql) preserves the two read-only calculations for reproduction.

## Timezone and frontend safety fixes completed locally

The audit found a narrow missing-zone gap in the earlier SQL: PostgreSQL `AT TIME ZONE NULL` could return NULL bounds and misleading empty results. Added an explicit check against `pg_catalog.pg_timezone_names`; missing, empty and invalid zones now raise a controlled error. Production currently forbids NULL timezone, but the additional check fails safely if legacy schema/data changes later. Tests temporarily allow a NULL timezone **only in the disposable local database** to prove this case. No production schema or timestamp was changed.

The page now refuses to calculate a range or issue an RPC when its clinic timezone is missing/invalid; it shows a safe message asking the Owner to check Settings. It no longer silently defaults analytics ranges to UTC when clinic configuration is absent. SQL still independently reads and validates persisted timezone, so the browser cannot forge timezone scope.

Clinic calendar start/end dates are inclusive; upper instant is local midnight on the day after the end date, exclusive. Presets include today. Tests cover Kuwait UTC+3 crossings, New York spring 23-hour and autumn 25-hour days, leap/year-crossing calendar subtraction, malformed dates, missing/inverted/overlong ranges, and all three preset lengths. All timestamps remain historical stored values.

UI tests render the actual AppLayout with a mocked router and verify Owner/Manager see `/analytics` links and Staff does not. The page's query is also disabled for Staff. Existing RouteShell protects direct route access. Server checks remain the authority. Empty/loading/API-error/retry states pass. A sentinel internal error string is absent from the user-facing error UI. No frontend environment/service-role secrets or hardcoded production clinic/practitioner identifiers were added. Simulated DOM tests emit Recharts zero-layout warnings; actual CSS layout/mobile visual acceptance is still a normal release check.

## Production performance

Read-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` executed the proposed aggregate SELECT against actual production rows, using the read-only audit role. It does not include PostgREST transport or the yet-uninstalled PL/pgSQL authorization wrapper. RLS predicates/helper definitions and authenticated privileges were separately inspected; local authenticated tests execute the full wrapper under RLS.

| Range ending October 4 | Planning ms | Execution ms | Shared buffer hits |
| --- | ---: | ---: | ---: |
| 7 days | 13.460 | 13.514 | 20 |
| 30 days | 1.940 | 1.490 | 30 |
| 90 days | 1.965 | 3.417 | 30 |

These are individual observations, not latency percentile benchmarks. The 30-day scans process 29 conversations and 11 appointments once each. PostgreSQL selects cheap sequential scans for these tiny relations despite the appropriate existing indexes; this is expected. The practitioner join's database nested loop is an ordinary server-side join, not separate browser/API calls. One RPC supplies at most 90 trend rows and 20 groups per breakdown plus remainder totals. The SQL uses clinic/date bounds on raw indexed timestamp fields and reads only needed columns. There is no unbounded frontend table download or N+1 API behavior. No new index is justified by current structure, row counts or measured plan.

## Validation and existing module compatibility

All passed after the audit changes:

- `npm run test:analytics`: migration row/policy/function preservation, ACLs, read-only execution, every metric, raw-row/date/status reconciliation, duplicate names, deletion/null FK, service case/blank text, all range lengths, timezone null/invalid/DST/boundaries, Owner/Manager/Staff/revoked/anonymous/missing-auth/forged-clinic isolation; UI navigation/access, loads, presets, states, safe errors and stored text.
- Auth: 29 tests.
- Permissions: 14 database and 9 UI.
- Isolation: 133.
- Appointments: 18 database and 19 calendar/UI.
- Team Management: 15 + 26 + 13 backend/database and 17 UI.
- Settings: 65 database and 32 UI.
- Calls/voice edge isolation: 11; voice routing/security/operation unit tests: 27 individually executed through bundled imports.
- Frontend `npx tsc --noEmit`.
- Production `npm run build`, local artifacts only.
- Targeted ESLint for Analytics frontend/test files; existing integration files linted with only formatting checks disabled to preserve established compact formatting.
- `git diff --check`.

Analytics changes no backend TypeScript. Its backend/database tests are actual local PostgreSQL execution, not mocked SQL. Existing modules' schema, helper definitions, policies, source data and write paths are untouched by the migration. Existing uncommitted work outside Analytics was preserved, and this verdict applies only to the Analytics migration/module, not approval to release unrelated changes.

## Changes made during this audit and remaining release work

Changed locally:

1. Analytics migration: controlled missing/invalid timezone rejection.
2. Analytics page: controlled missing/invalid timezone state with no request.
3. Analytics database tests: migration preservation, ACL/read-only checks, same-name IDs, deleted practitioner/null FK, exact service text, all-range reconciliation and invalid zone fixtures.
4. Analytics UI tests: actual navigation role checks, missing/invalid timezone, internal-error suppression and safe/null service text.
5. Audit report, read-only reconciliation SQL and sanitized aggregate/schema/plan evidence. Initial implementation report links to this later production read-only audit.

No outstanding migration/code fix is required. When separately authorized, apply **only the latest Analytics migration** and coordinate frontend publication with RPC availability. Use the normal administrative SQL Editor role; creating this function is the expected schema change. Recheck catalog absence if production changes before manual application: an unexpectedly existing same-signature function needs definition review before `CREATE OR REPLACE`.

After release, perform real Owner/Manager/Staff/retained-revoked-session RPC acceptance and browser/mobile chart checks. Those cannot be performed on the currently absent hosted RPC without deploying it. No production session or membership was created/changed to manufacture those cases. **The migration is safe to apply manually against the production schema inspected in this audit; it has not been applied.**
