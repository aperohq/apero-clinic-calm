# Integration release runbook

**Not deployed.** This runbook is the concrete release scope requiring authorization. It does not authorize execution. No new paid service is required by the code; production Edge/Google/hosting quota and any staging provisioning must be reviewed before enabling them.

## Release contents

- Migration: `supabase/migrations/20261122120000_integration_system.sql`.
- Edge functions: `integration-api`, `integration-worker`, `google-calendar-webhook` and their shared integration modules.
- `supabase/config.toml`: platform JWT verification disabled only for these handlers because they validate their own API key, Auth bearer, independent worker secret, or channel token.
- Dashboard: Account → Integrations, visible only to active owners when `VITE_APERO_INTEGRATIONS_ENABLED=true`.
- Server switch: `INTEGRATIONS_ENABLED=true` only after backend deployment and authorized setup. It defaults off.
- Optional operator schedule: `operations/integrations/worker-schedule.sql`; **never installed by a migration or CI**.
- Incident booking rollback: `operations/integrations/rollback-booking-gate.sql`.

Existing Retell handlers, flow configuration, agent versions and tools are unchanged. The migration intentionally changes the shared booking predicate only for selected calendar connections. It preserves the existing scheduling rules, duration/practitioner constraints and exclusion constraint.

## Configuration through the secret manager

| Server setting                                                   | Required value / purpose                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Existing reviewed target project; service key stays server-side.                                        |
| `APERO_PORTAL_ORIGIN`                                            | Exact HTTPS portal origin, without path or trailing slash.                                              |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                       | Authorized web application OAuth credentials.                                                           |
| `GOOGLE_REDIRECT_URI`                                            | Exact HTTPS `<project>/functions/v1/integration-api/oauth/callback`; register the same URI with Google. |
| `INTEGRATION_ENCRYPTION_KEY`                                     | Independent random 32-byte key encoded as 64 hex characters; escrow outside the database.               |
| `INTEGRATION_WORKER_SECRET`                                      | Independent high-entropy server-only bearer secret, at least 32 characters.                             |
| `GOOGLE_WEBHOOK_URI`                                             | Optional exact HTTPS `<project>/functions/v1/google-calendar-webhook`; omission retains polling.        |
| `INTEGRATIONS_ENABLED`                                           | `false` during installation; `true` only for the authorized release.                                    |
| `VITE_APERO_INTEGRATIONS_ENABLED`                                | Public frontend flag, `false` until backend acceptance; rebuild frontend when changing.                 |

Do not put secret values in chat, Git, CLI arguments, screenshots or test evidence. Set them through the authorized account's secret manager. Configure Google Calendar API and consent/verification for the two scopes in `google.ts`. Testing-mode Google refresh-token lifetimes are not evidence of production token longevity. Real clinic consent is performed by the clinic owner through Google, never by an operator copying tokens.

Encryption-key rotation requires a reviewed credential re-encryption operation or disconnect/re-authorization of every connection while booking is paused; replacing the key alone makes existing credentials unreadable. API-key rotation and worker-secret rotation are independent. Rotate the worker secret in Edge and Vault together. Removing the Google account grant affects all connections using that Google grant; coordinate with clinics.

## Preflight and staged verification

1. Fetch `origin/main` read-only and reconcile it through ordinary additive commits. Review changed-file and migration checksums at the exact candidate SHA. Require the five protected checks: `quality`, `regression`, `windows-components`, `native-database`, `supabase-bootstrap`.
2. Use a separately authorized test/staging Supabase project and synthetic clinics. Confirm account costs and resource ownership first. Never run `supabase db reset` against the linked production project.
3. Verify migration history and backup/restore readiness. The migration performs no appointment data rewrite, but installs triggers and must be reviewed as a live booking change. Record baseline clinic/appointment counts and constraint definitions without patient data.
4. Apply the new migration to the approved target through the existing migration workflow. Deploy all three functions with their pinned Deno imports and reviewed configuration. Do not deploy existing Retell functions as part of this release.
5. Confirm unauthenticated API, owner-management, webhook and worker requests are denied; disabled APIs return 503. Confirm anonymous/browser roles cannot read or truncate integration tables or invoke worker RPCs.
6. Enable the server and frontend flags in the approved staging target. Verify owner key creation, one-time disclosure, scope denial, 90-day expiry, rotation, revocation, 60/min rate limiting, cross-clinic denial, idempotency conflicts and concurrent booking rejection.
7. Have an authorized test clinic owner complete Google consent in the initiating browser, select a writable test calendar and practitioner, and verify a healthy initial snapshot. Cancelled/wrong-browser/replayed OAuth completion must fail safely.
8. Verify booking, rescheduling and cancellation appear correctly in Google with only the generic event title; test lost responses, deleted Google events, token expiry, revocation, quota/5xx recovery, expired worker leases, webhook replays, recurring/all-day/DST events and missed-notification polling.
9. Force an external busy conflict and a stale snapshot. Both must block new local bookings and display attention. Test both native database race orders and the unavoidable external-provider race described in README. Reconcile an external conflict without silently changing a patient's appointment.
10. Review the optional worker schedule and expected invocation quota. Store the URL and bearer secret in Vault under the exact names in the schedule template. After approval, install it and confirm one minute polling plus bounded drains keep lag below two minutes. Record actual job duration and backlog at the clinic's expected volume. No scheduler is enabled by this code alone.
11. Exercise Account at 320, 375, 768 and 1440 px, owner/manager/staff roles, connection errors and clinic switches. Re-run Retell synthetic regression; no live calls without separate authorization.

## Authorized production sequence

After one consolidated authorization names the target project, candidate SHA, migration, functions, configuration, worker schedule/quotas, frontend rollout and clinic participant:

1. Confirm a current usable encrypted backup and migration history. Capture a redacted baseline.
2. Install server settings with `INTEGRATIONS_ENABLED=false`; leave frontend hidden. Apply the reviewed migration once and deploy the three new functions.
3. Verify RLS/grants, unchanged exclusion constraint and existing Retell contract with synthetic data. Keep real booking mutations out of this step unless specifically authorized.
4. Enable server configuration and the authorized worker schedule, then enable the frontend flag and publish using the existing protected workflow.
5. Have the named clinic owner authorize Google and choose the real clinic calendar. Observe the initial snapshot and queued existing bookings before accepting live bookings.
6. Perform the approved booking → reschedule → cancellation acceptance using the agreed records; verify Google, Apero, queue, audit, webhook and Retell behavior, and clean up only those explicitly approved records.
7. Record deployed function versions, migration version, frontend SHA, configuration **names**, scheduling state, acceptance results and actual spend. Do not record credential values.

## Incident rollback

Stop the worker cron job and disable new API/OAuth traffic with the server flag; hide the dashboard. This alone intentionally leaves selected calendars blocking bookings after freshness expires. Reconcile external conflicts before deciding to reopen booking. Under the release's rollback authorization, apply `rollback-booking-gate.sql` to restore the original scheduling predicate and remove only the calendar-lock trigger. Keep outbox, keys, encrypted credentials and audit for recovery; no appointment or patient data is erased. Existing Google events remain and must be reconciled.

To resume, restore only the wrapper and lock-trigger definitions from the reviewed migration, restore secrets/flags, refresh snapshots, drain preserved jobs and repeat acceptance. Do not re-run a non-idempotent schema creation migration or remove the exclusion constraint.

## GitHub publishing/cost check

Read-only inspection on 2026-11-22 verified a public repository, protected `main` with all five required checks, `enforce_admins=true`, and no repository webhooks. The candidate branch is newly created, separate from `main` and the existing Lovable sync branch. The only PR workflow runs synthetic checks with `contents: read`; production backup/retention/recovery workflows are schedule/manual workflows and are not changed here. No deployment workflow is added. Standard hosted runners for public repositories are free under [GitHub's current billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions); no new Actions artifact upload or cache dependency is introduced. A draft PR can therefore run these checks without a provider deployment. Production publication/migrations/real clinic connections remain separately gated. Never bypass branch protection or rewrite Lovable history.

Lovable's [publication guidance](https://docs.lovable.dev/features/publish) separates synced editor changes from the published snapshot. This source-only merge does not invoke publication or backend deployment; real activation still follows the authorization above.
