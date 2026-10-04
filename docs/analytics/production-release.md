# APERO Analytics production release — 2026-10-04

Migration: `supabase/migrations/20261004120000_clinic_analytics.sql`.

**The migration was already applied manually. It was verified, never rerun or reapplied during this release.** No production clinic data or memberships were created, changed or deleted. Normal Owner sign-in used the credentials explicitly supplied by the user; no credential/session token is included in this report, evidence, logs or commit. Auth necessarily creates a normal login session; the six Analytics source/product tables remain unchanged.

## Installed migration verification

PASS: `public.clinic_analytics(uuid,date,date)` exists, and its complete normalized body matches the latest audited local migration byte-for-byte. The installed missing/invalid timezone guard is present. The function is STABLE, SECURITY INVOKER, with fixed `pg_catalog, public` search path. ACL is postgres + authenticated EXECUTE only. Authenticated execution is granted; anon and service_role execution are denied. No RLS bypass or definer elevation was introduced.

Production policies on clinics/profiles/staff/appointments/conversations match the preceding safety audit exactly; RLS remains enabled. MD5 fingerprints of every complete row in conversations, appointments, clients, staff, profiles and clinics are identical between the before/after snapshots. The release issued no product DML or schema DDL. SQL inspection/reconciliation used explicit read-only transactions.

## Live Owner acceptance and reconciliation

The Owner signed in normally through Supabase Auth. Real PostgREST calls using that Owner's JWT returned 200 for the installed RPC. Every live JSON result, not only summary totals, was compared with independent raw production calculations. They match, including zero-filled daily buckets and stable-ID practitioner/service groups.

| Clinic-local range, ending October 4 | Calls | Appointments | Booked | Cancelled | Call daily sum | Appointment daily sum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 days: September 5–October 4 | 29 | 11 | 10 | 1 | 29 | 11 |
| 7 days: September 28–October 4 | 7 | 3 | 3 | 0 | 7 | 3 |
| 90 days: July 7–October 4 | 29 | 11 | 10 | 1 | 29 | 11 |

Timezone: `Asia/Kuwait`. Booked/Cancelled represent exact current statuses of appointments scheduled in the range, not historical events. Calls use recorded started_at; appointments use scheduled start_time. The 30-day UTC bounds are `[2026-09-04T21:00Z, 2026-10-04T21:00Z)`.

The 30-day practitioner counts are 7, 2, 1, 1 across four stable IDs. Ten exact stored service-text groups contain one group of 2 and nine groups of 1. All breakdown rows/labels/counts and trend buckets match raw production data. Production has no duplicate practitioner names or NULL staff references; duplicate-name and deleted/null practitioner behavior is therefore exercised with local raw-row fixtures, not manufactured in production. Those tests prove separate stable-ID groups and safe Unassigned counts. Stored service case/blank/null defensive UI cases and HTML-like text also pass locally.

Live Owner requests for a forged/nonexistent clinic UUID or NULL clinic return 403/42501. Inverted, overlong and missing ranges return 400/22023; malformed date input returns 400/22007. Anonymous direct RPC returns 401/42501. Production currently has one clinic, so a real second-clinic live request cannot be exercised without adding data; two-clinic isolation is tested locally under actual PostgreSQL RLS and the identical function body.

## Role acceptance evidence and limits

| Role/case | Evidence | Result |
| --- | --- | --- |
| Owner | Real production Auth session and installed RPC, all three ranges | PASS live |
| Manager | Active Manager in local PostgreSQL, identical installed function body and production-compatible schema | PASS local; no production Manager membership exists |
| Staff | Direct function denial with Staff/forged Owner metadata; UI no request/nav, in local PostgreSQL/UI | PASS local; user explicitly accepted local Staff-denial verification because no existing Staff credentials/session is available |
| Revoked retained session | Revoked profile denied in local PostgreSQL; installed production helpers independently verified to filter revoked_at IS NULL | PASS local; no revoked production membership exists |
| Forged clinic | Real Owner production RPC 403 | PASS live |
| Anonymous | Real unauthenticated production RPC 401 | PASS live |

No Manager, revoked membership, second clinic or invalid-timezone clinic was created or changed to fabricate a live test. Claims/session impersonation through the read-only audit connection was refused by the database and was not used to bypass authorization. Owner acceptance then used the user-authorized real login. No elevated service-role call was used for Analytics.

Valid canonical Kuwait timezone is verified live. Missing/invalid zones, DST 23/25-hour days, UTC crossings and 7/30/90 inclusive date boundaries pass local SQL/UI tests against the same function body. The live configuration remains valid and unchanged; invalid-zone cases are not presented as live tests.

## Performance and existing-module health

One bounded RPC returns aggregate JSON; there is no browser table download or N+1 API behavior. The installed SQL retains raw timestamp clinic/date predicates and both existing clinic/date indexes. Prior actual production SELECT plans measured 1.49 ms for the 30-day aggregate and 13.514 / 3.417 ms for 7 / 90 days at this tiny current dataset. There is no evidence for a new index, and none was added.

Live PostgREST wall times, including HTTPS/network/gateway/Auth/RLS/serialization: first 30-day acceptance 997 ms; next 7/90 calls 404/409 ms. A separate session reuse measured 920 ms for its first request and 410/410 ms for subsequent 30-day calls. Every response was 200. These are single-request observations, not database-only durations or percentile/SLA claims; at current V1 scale there is no performance blocker. The audit connection cannot assume authenticated role, so full-wrapper server EXPLAIN was not obtained; direct aggregate plans and genuine authenticated RPC timings are distinct evidence.

Authenticated read-only checks return 200 for Auth user, Calls, Appointments, Settings clinic values, practitioners and clinic_team_members. No write endpoint was invoked. Existing published /login, /home, /calendar, /conversations, /account/team and /account/settings return HTTP 200. Their local regression suites also pass. This establishes read health and regression compatibility, not permission to mutate production to retest booking/invitation/settings writes.

## Validation and commit scope

All requested tests passed in the working tree, then passed again in a separate export of the **exact staged Analytics-only tree**, with the committed helper fixtures and without unrelated local changes:

- Analytics SQL/UI, including all metrics, schema/row/policy/function preservation, ACL/read-only transaction, scopes/roles, date/timezone edges, duplicate/deleted practitioners, states, navigation and safe errors.
- Auth, permissions database/UI, clinic isolation, Appointments database/calendar, Team Management and Settings.
- Calls/voice: edge-isolation 11 cases; committed voice request-security/routing/operation tests 17 individually executed cases.
- Frontend `tsc --noEmit` and production build.
- Targeted ESLint for Analytics/test files; existing integration files linted with formatting checks disabled to retain established compact formatting.
- `git diff --check` and staged diff checks.

Backend TypeScript was not edited for Analytics; actual local PostgreSQL tests validate its backend. No speculative indexes or new modules were introduced.

Commit scope: Analytics page, route, range/result types, RPC type, generated route registration, package test script, Analytics migration, Analytics tests/docs/evidence, and exactly the two navigation additions (icon import + entry). Existing navigation sizing/logout changes and all other unrelated working-tree changes remain unstaged. The requested commit message is `Add clinic analytics`, targeting a normal non-force `main -> origin/main` push. The final response records the resulting Git hash and push receipt.

## Lovable publishing and launch status

**LOVABLE MANUAL PUBLISH REQUIRED**.

Before the push, the published /analytics route returns 404 and its reachable bundles contain no clinic_analytics or Analytics route. Git synchronization updates the Lovable editor; publishing is a separate snapshot operation. Lovable's [official publishing documentation](https://docs.lovable.dev/features/publish) says later changes require Publish → Publish changes. No Lovable publishing tool was invoked.

After the requested push syncs to Lovable, open the connected project, confirm the Analytics source is present, then select **Publish → Publish changes**. Verify /analytics with the Owner session and check charts/mobile layout on the published build. **Do not reapply the migration.** Staff/Manager/revoked cases are locally verified as explicitly qualified above; do not change production memberships merely to create test cases.

The backend and source release are ready for frontend publication. Analytics is **not live/fully launched** until Lovable is published and the route is checked. This distinction is reflected by `Analytics Launch Ready: NO — publication pending` in the final release report.

See [production-release-evidence.json](production-release-evidence.json) for sanitized installed-object, runtime reconciliation, denial, product-fingerprint, timing and module-health evidence. Credentials and JWTs remain excluded.
