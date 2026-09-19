# Pre-launch security review — 2026-09-19

This is a focused code, configuration, and safe-probe review, not a penetration test or compliance assessment. No real appointments or production rows were changed during the review. `db/07_prelaunch_security.sql` was subsequently reviewed, applied manually, and verified successfully on 2026-09-19.

## Findings and launch gates

| Severity | Finding | Action |
| --- | --- | --- |
| Resolved high | Clinic owners could write call records through PostgREST. | Migration 07 removed authenticated conversation INSERT/UPDATE/DELETE while retaining clinic-scoped SELECT and service_role writes. |
| Resolved medium | Auth Site URL and password-recovery redirect were not production-ready. | The values were manually corrected and password recovery was tested successfully. |
| Resolved medium | Profile `email` was a browser-writable mirror of Auth email. | Migration 07 made the mirror immutable to browser roles. |
| Medium | Signed voice endpoints read whole request bodies before parsing and have no explicit body-size/rate cap. A holder of a valid Retell credential could trigger repeated expensive availability calls or generate many distinct message requests. | Set practical gateway limits and monitor abuse; avoid limits that reject normal Retell retries. Size and rate limits need a deployment plan. |
| Medium | Conversation rows expose Retell recording URLs to authorized clinic users. RLS protects the row, but the URL's own sharing/expiry policy was not verified. | Check Retell URL access lifetime and use private, short-lived access if available. |
| Low | The live frontend has HSTS, `nosniff`, and `strict-origin-when-cross-origin`; no CSP, frame protection, or Permissions-Policy header appeared in the HEAD response. | Add tested headers at hosting/Cloudflare when controllable. CSP must permit Supabase and current Google Fonts. |
| Low | The webhook logs call IDs and database error objects; error objects may contain query details. | Minimize log payloads when next deploying the function; retain a non-patient correlation ID if needed. |

## Verified boundaries

- Live metadata query: RLS is enabled on all 16 requested clinic tables. `anon` has no SELECT on any. `voice_integrations`, `clinic_service_aliases`, `voice_operations`, `voice_call_state`, and `voice_checked_slots` have no authenticated SELECT grant or policy. `voice_requests` has one authenticated SELECT policy. Clinic tables have tenant-specific policies in migrations 01–06. This supports isolation, but it is not a live two-clinic adversarial test.
- The RLS helper derives clinic and role from `auth.uid()` and the profile row. Cross-clinic references are guarded by database triggers/composite foreign keys. Profile role, clinic ID, and auth user ID are immutable through browser writes. The SQL uses PostgREST filters and fixed PL/pgSQL, with no user-built dynamic SQL in runtime RPCs. SECURITY DEFINER appointment RPC uses `public, pg_temp` search path and service_role-only EXECUTE.
- All four production voice endpoints returned HTTP 401 to an unsigned, forged-clinic request. The shared resolver awaits Retell signature verification on the raw body, then selects integration by signed agent ID. The signed clinic is used instead of request `clinic_id`. A valid signed production request was not sent because it could create operational records.
- Slot tokens include clinic, staff, service, time, check ID, call ID, expiry, and an HMAC. The appointment RPC rechecks the persisted slot, current check, expiry, staff/service/clinic, working hours, time off, appointment ownership, and conflicts. Operation keys and database locks guard duplicate booking; request keys deduplicate identical message/callback/urgent requests. These are code and prior reconciliation findings, not destructive live tests.
- Frontend Auth uses Supabase password APIs, persistent sessions, token refresh, and sign-out; no custom password database exists. Protected routes check session/profile. Browser queries use a publishable `sb_publishable_` key. Server code reads service-role credentials separately. No upload feature or user storage bucket use was found.
- React escapes names, notes, summaries and transcripts. No user-provided HTML/Markdown renderer was found. The only `dangerouslySetInnerHTML` is an unused chart style component, not fed by patient content. Links to phone numbers use the `tel:` prefix.
- The production frontend and Supabase project URLs use HTTPS. Localhost URLs occur in development preview/fixtures. Production dependency audit reported zero vulnerabilities at all severities on 2026-09-19.

## Secret history

All 65 reachable commits and 243 unique text blobs were scanned for Supabase secret-key and JWT shapes, GitHub tokens, and literal Retell assignments without printing values. No matching secret was found. Tracked `.env` history contains only project URL/ID and publishable-key variable names and no sensitive candidate. This pattern scan is not proof against every possible credential format; no rotation is indicated by the evidence. If a credential is later found, rotate it before considering history cleanup. Do not rewrite Lovable-connected history automatically.

## Remaining safe acceptance tests

Use separate authorized Clinic A and Clinic B test accounts and synthetic records. Confirm A cannot SELECT B clients/appointments/conversations, UPDATE B staff/schedules/time off, or insert A records referencing B IDs. Confirm malformed IDs, forged clinic IDs, role updates, and changed appointment fields fail. No second-clinic account was available for these live tests in this pass. Confirm a signed synthetic Retell request, unknown agent, wrong signature, replay, invalid/reused/expired slot, and cross-clinic appointment ID in an isolated test environment; do not use live appointment IDs. Confirm login rate-limit behavior and reset email delivery with approved test accounts.

## Backup and rollback

- Supabase: verify project plan's automated backup/PITR availability and last successful backup in Dashboard → Database → Backups. No paid backup feature was enabled. Take a verified backup before applying migration 07. Its rollback is to restore only the previous conversation write grant/policy and profile guard definition after security review; avoid blind whole-database rollback when clinic data has changed.
- Edge Functions: retain deployed version/source for rollback; redeploy a known-good commit if a function regression occurs. This review did not redeploy.
- Retell: export the published flow and agent configuration before future changes; this review did not publish.
- Git/Lovable: use a new revert commit for code rollback, not force push or history rewrite.
