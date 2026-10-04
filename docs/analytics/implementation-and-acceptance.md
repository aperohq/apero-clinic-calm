# APERO Analytics V1 — local implementation and acceptance

Current release status: the migration is now installed. See [production-release.md](production-release.md) for live Owner acceptance and publication status. Do not reapply it.
Status: **BUILT LOCALLY — NEEDS PRODUCTION ACCEPTANCE**.

During the initial implementation, no deployment, push, hosted query, synchronization change, or production mutation was performed. A subsequent read-only production safety audit is recorded in [production-safety-audit.md](production-safety-audit.md). Unrelated working-tree changes present at the start were preserved. Evidence is repository schema/code and disposable local PostgreSQL fixtures, not an inspection of current hosted rows.

## 1. Existing architecture audited before implementation

No Analytics route, page, charts, placeholders, view or aggregate RPC existed. `src/lib/permissions.ts` already reserved `/analytics` and `analytics.view` for Owner/Manager. Navigation did not expose it. Existing `RouteShell` enforces page permissions and Auth clears query caches when clinic/account role changes. Ordinary Calls/Appointments hooks fetch operational records; reusing those hooks would download full rows for browser aggregation and would not enforce the Analytics-specific role boundary.

The existing design uses `PageHeader`, `Panel`, `PanelTitle`, `Empty`, semantic theme colors, React Query, Supabase and TanStack file routes. Recharts was already installed.

## 2. Reliable data available in the repository

- Calls: `public.conversations`, one stored conversation per row. Fields include `clinic_id`, `started_at`, unconstrained text `status`/`outcome`, integer `duration_seconds` defaulting to zero, optional `appointment_id`, optional unique `retell_call_id`. Existing index `conversations_clinic_idx(clinic_id, started_at DESC)`.
- Appointments: `public.appointments` with `clinic_id`, required `start_time`, `end_time`, `service` text, current `status`, `created_at`/`updated_at`, optional `staff_id`/`client_id`, source. Existing index `appointments_clinic_idx(clinic_id, start_time)`. Repository booking/cancellation workflows write exact `Booked` and `Cancelled`. Status is free text, so unknown legacy values are retained in totals and surfaced as other statuses. No completion/no-show recording workflow was found.
- Clients: `public.clients` contains clinic-scoped identity/contact and creation/update timestamps. No patient value, acquisition attribution or financial facts. Analytics does not query or expose clients.
- Practitioners: `public.staff`, full name, clinic, active flag, specialty and assigned service-name array. Membership `profiles` is separate from practitioner `staff`. Historical appointments may reference inactive practitioners or lose their reference on deletion; they remain counted.
- Services: stored appointment `service` is the historical grouping key; practitioner `services` arrays describe current assignments, not historical activity. No normalized service catalog, pricing or financial ledger is used.
- Canonical timezone: `public.clinics.timezone`, validated by existing Settings. UI calendar helpers are `toClinicInput`, `fromClinicInput` and `clinicDayBoundary` in `src/lib/clinic-time.ts`. SQL uses PostgreSQL `AT TIME ZONE` with the clinic's persisted timezone, never a browser-supplied timezone.
- Webhook call statuses: `Booked`, `Completed`, `Missed`, `Needs Review`. Call `Completed` is not appointment completion. Outcomes include `Appointment Booked`, `Appointment Rescheduled`, `Appointment Cancelled`, `Follow-up Needed`, `General Inquiry`, `No Appointment`; seeds also contain legacy outcome spellings. No outcome strings are used to calculate metrics.

The webhook records `started_at` from a supplied start timestamp, otherwise schema default applies; duration is rounded from supplied milliseconds, otherwise defaults to zero. Consequently the dashboard measures **stored records by recorded timestamps**, not independent telephony provider volume or precise ingestion completeness.

## 3–5. Implemented metrics and exact definitions

All metrics resolve one active authenticated clinic membership. Date filtering is the half-open UTC instant interval corresponding to the selected clinic-local calendar dates: `[local start midnight, local midnight after end date)`. Start/end dates shown in the UI are inclusive. Counts are integers, not estimates. No sample rows, client-side aggregation or inferred attribution.

| Metric | Source/fields | Included/excluded statuses | Date field and calculation |
| --- | --- | --- | --- |
| Total calls | `conversations.clinic_id, started_at` | All statuses; none excluded | Count rows whose recorded `started_at` lies in the interval |
| Daily calls | Same fields | All statuses; none excluded | Group total-call rows by `(started_at AT TIME ZONE clinic.timezone)::date`; zero-fill each selected day |
| Total appointments | `appointments.clinic_id, start_time, status` | All statuses including cancelled/legacy; none excluded | Count rows whose currently scheduled `start_time` lies in the interval |
| Booked appointments | Same | Exact `Booked` only; all other values excluded | Count selected appointment rows currently marked `Booked` |
| Cancelled appointments | Same | Exact `Cancelled` only; all other values excluded | Count selected appointment rows currently marked `Cancelled` |
| Other recorded appointment statuses | Same | Any value other than exact `Booked` or `Cancelled` | Count selected rows outside those two statuses; display contextual note when nonzero |
| Daily appointments | `appointments.clinic_id, start_time` | All statuses; none excluded | Group total-appointment rows by `(start_time AT TIME ZONE clinic.timezone)::date`; zero-fill each selected day |
| Practitioner appointment breakdown | Above appointment rows plus `staff_id`; same-clinic `staff.id, full_name` | All statuses and inactive practitioners; none excluded | Count selected rows by practitioner ID, label with current name; null references are `Unassigned`. Highest 20 counts, deterministic ID ties; remaining counts combined as `Other groups` |
| Service appointment breakdown | Above appointment rows plus `service` | All statuses; none excluded | Count selected rows by exact recorded service text (no renaming/fuzzy merging); highest 20 counts, deterministic label ties; remaining counts combined as `Other groups`. Blank label displays `Unspecified` |

Breakdown counts plus remainder equal total appointments. A practitioner renamed later displays their current name. Rescheduling changes which date an appointment falls on. Booked/cancelled are **current statuses of scheduled appointments**, not booking/cancellation events or appointments created in the range. These definitions appear in the UI and are reproducible with the migration's SQL.

Intentionally omitted:

- Completion and no-show: no reliable appointment lifecycle workflow or constrained status source establishes these facts. Never infer completion from a past start time.
- Call-to-booking conversion: links may reference existing appointments, reschedules/cancellations, or collected IDs; a successful booking can also precede a later last operation. `appointment_id`, source text and current call outcome alone do not define a complete reliable booking-attribution cohort. No conversion percentage is exposed.
- Average duration: missing duration and a true zero share the same default, and the schema has no validity/completeness flag. Excluding zeros would silently bias an average. No average exposed.
- Busiest days/hours: timestamps can support descriptive groupings, but V1 retains two daily trends and clear breakdowns to keep the dashboard focused. No occupancy, availability or staffing demand inference.
- Client acquisition, revenue, profit, ROI, patient value and other finances: unsupported reliable source data; no financial analytics added.

## 6. Date behavior

Last 7, 30 and 90 days include today in the canonical clinic timezone. UI derives the current local date with existing `toClinicInput`, then subtracts calendar dates in UTC date arithmetic, rather than subtracting elapsed hours. SQL independently loads the persisted clinic timezone for filtering and grouping. Neither browser timezone nor UTC-date slicing determines the clinic's today.

The database accepts explicit start/end `date` parameters, validates non-null ordered ranges of 1–90 inclusive days, and bounds dates to 2000–2100. Malformed date text fails PostgreSQL parameter parsing. There is no custom-range control in focused V1. DST 23- and 25-hour days and Kuwait's UTC+3 day boundaries are exercised in real local SQL fixtures. Data through the end of today is selected; the UI identifies today's inclusion rather than suggesting a completed day.

## 7–8. Permissions and isolation

`clinic_analytics(uuid,date,date)` is `STABLE SECURITY INVOKER` with fixed `pg_catalog, public` search path and qualified application relations/helpers. Its grant is only to `authenticated`; PUBLIC, anon and service_role execution are explicitly revoked. Existing helpers read real membership, including Team revocation. The RPC additionally checks an unrevoked profile. It does not trust JWT metadata clinic/role. Membership clinic is authoritative; the supplied clinic ID is an expected-clinic assertion and must match it. Role must be Owner or Manager.

Staff may continue to read records allowed by existing operational RLS, but cannot execute an Analytics aggregate successfully. A retained JWT with a revoked profile is rejected on its next request. Existing Auth refresh removes clinic association and cached data; the dashboard revalidates every 60 seconds and on focus, hides cached results on query errors, and keys cache by clinic, profile, role, timezone and range. Previously delivered information cannot be retroactively withdrawn.

The migration creates no policies and changes no RLS settings. Local tests compare all policies before/after and exercise SQL as authenticated non-bypass roles, plus anonymous/missing-auth cases. Clinic A requests for Clinic B, nonexistent/null IDs, Staff with forged Owner metadata, and revoked Owner sessions fail. Clinic B's valid query returns only Clinic B's records.

## 9. Query/performance architecture

One aggregate RPC per load/refetch/range change. No N+1 requests and no browser downloads of operational tables, transcripts, patient contact details or voice internals. The server materializes only needed fields from each table once per bounded interval, aggregates daily counts and returns at most 90 daily rows and 20 rows per breakdown plus remainder counts. Grouping may process every matching row inside the chosen range; that work stays in PostgreSQL. The response size is bounded independently of record volume.

Date predicates compare raw indexed timestamp columns to converted constants. Existing `(clinic_id, started_at)` and `(clinic_id, start_time)` indexes match the access pattern. No speculative index was added. Production cardinality, actual execution plans and latency still need acceptance under representative data; local fixture timing is not a production benchmark. Existing platform statement/resource limits continue to apply.

## 10–11. Files changed for this task

- `src/components/analytics-page.tsx`: summary cards, trends, accessible daily-number tables, breakdowns, loading/error/retry/empty states, responsive grids.
- `src/lib/analytics.ts`: result type and clinic-calendar preset calculation.
- `src/routes/analytics.tsx`: route using existing `RouteShell`.
- `src/components/app-layout.tsx`: Analytics navigation entry and icon only; pre-existing modifications preserved.
- `src/lib/db-types.ts`: typed RPC declaration.
- `src/routeTree.gen.ts`: generated Analytics registration.
- `supabase/migrations/20261004120000_clinic_analytics.sql`: one read-only invoker function and safe execution grants, schema reload notification. Non-destructive, not applied remotely. Requires existing Team membership migration with `revoked_at` and revocation-aware helpers.
- `tests/analytics.test.mjs`: PostgreSQL metric/security/read-only tests.
- `tests/analytics-ui.test.mjs`: isolated UI/load/role/range/state tests with no network or production credentials.
- `package.json`: `test:analytics` command.
- `docs/analytics/implementation-and-acceptance.md`: audit, definitions, validation and remaining acceptance.

## 12. Local validation results

Passed:

- `npm run test:analytics`: correct totals/statuses/trends/breakdowns and remainder counts; preset filtering, UTC+3 boundaries, DST boundaries, empty clinic, calls-only/appointments-only, Owner/Manager allow, Staff/revoked/anonymous/missing-auth denial, forged claims/IDs, cross-clinic isolation, malformed/inverted/overlong/null ranges; unchanged product row snapshots and policies. UI Owner/Manager load, Staff no RPC, date changes, loading, retry recovery, empty state and breakouts.
- `npm run test:auth`: 29 tests.
- `npm run test:permissions`: 14; `npm run test:permissions:ui`: 9.
- `npm run test:security`: 133.
- `npm run test:appointments`: 18 database + 19 calendar/UI tests.
- `npm run test:team`: 15 + 26 + 13 database/backend + 17 UI tests.
- `npm run test:settings`: 65 database + 32 UI tests.
- `node --max-old-space-size=384 retell/master/tests/edge-isolation.test.mjs`: 11.
- Existing voice routing, request security, clinic operation logic, ownership, resolution and timing tests: 27 individual cases, bundled with esbuild and imported into one Node process to execute the registered tests. No backend source was changed for Analytics.
- `npx tsc --noEmit`: frontend TypeScript.
- `npm run build`: production build, local artifacts only.
- Targeted ESLint on new frontend files with normal formatting checks; integration files `app-layout.tsx` and `db-types.ts` also linted with formatting disabled to preserve existing compact file formatting.
- `git diff --check`.

Backend TypeScript is not applicable to this change: no Edge Function/backend TypeScript was edited. Database behavior is tested in PostgreSQL. Simulated DOM tests emit Recharts zero-size warnings because the DOM harness does not perform CSS layout; they do not establish rendered chart sizing or real mobile browser behavior. No dependency installation was needed.

## 13–14. Remaining production work and final status

Under separately authorized release work:

1. Verify deployed schema/helpers, Team revocation migration, source timestamp population, canonical timezone, existing status distributions and indexes against this repository. Confirm stored call completeness with operations; no sync work is part of this module.
2. Review and apply only the new Analytics migration after its existing prerequisites. Coordinate frontend release with the RPC; a missing RPC currently produces a recoverable error state.
3. Execute Owner/Manager/Staff, revoked retained-session and two-clinic tests against hosted RPC, then reconcile every displayed metric with equivalent date-range SQL.
4. Inspect representative 7/30/90-day query execution plans and latency before deciding whether further optimization is warranted.
5. Verify actual desktop and narrow/mobile rendering, charts, keyboard behavior, error recovery and timezone boundary dates in a browser.

**BUILT LOCALLY — NEEDS PRODUCTION ACCEPTANCE**. This report does not certify current production data or hosted deployment. Billing, WhatsApp, Retell synchronization and production product records were not modified.
