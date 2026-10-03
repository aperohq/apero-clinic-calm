# Team Management production release — 2026-10-03

The database and invitation backends are installed and accepted through production
API tests. **The published Lovable frontend still requires manual publishing.**
This release does not yet have complete dashboard acceptance.

## Database verification

The operator had already manually applied
`20261003160000_clinic_team_management.sql`. This release did **not** execute or
reapply that migration. Read-only catalog inspection confirmed nullable
`profiles.revoked_at`, both private invitation tables, enabled RLS, restricted
grants, both profile guards, and all 13 accepted function bodies and settings.
Comparison normalized line endings only. Owner mutation/revocation, shared
budgets, cooldown, permanent email ownership and advisory serialization match
the accepted source. Anonymous privileged execution remains denied.

Existing data matched exactly before and after disposable acceptance: two Auth
identities, two profiles/memberships, 11 appointments, 29 conversations and the
original practitioner records. No pre-install snapshot was available to this
release; compatibility was additionally established from the non-destructive
migration and regression tests. No historical appointment or call was edited.

## Backend deployment

Only these invitation runtimes were deployed:

- `provision-clinic-user`: version 3 → 4, sharing the database claim authority.
- `manage-clinic-users`: new version 1, Owner invitation and resend.

Every deployed source file matches the accepted local source. Both functions
retain `verify_jwt = false` with explicit independent server authentication:
Auth `getUser` and live active Owner membership for Team operations; server
secret authentication for operator provisioning. Unrelated functions retained
their versions and source hashes. Revocation and role changes use the installed
restricted database RPCs; no additional Edge deployment was needed.

The historical operator runbook's “no deployment required” statement describes
its direct Node CLI. It does not exempt the existing operator Edge runtime from
this coordinated invitation-claim update. The CLI remains the supported operator
entry point; no privileged credential is included in the frontend.

## Disposable production acceptance

Tests used two new disposable clinics and exact tracked disposable identities.
Invitation emails used disposable aliases of APERO's support mailbox. No paid
service, Retell call, real user mutation or SMTP configuration change occurred.

Passed:

- Owner invites Staff and Manager; both deployed Edge requests return
  `invite_sent`, and Supabase Auth's email-send API returns success.
- Owner cannot invite Owner; pending directory status is correct.
- Two concurrent resends inside the real 60-second cooldown return safe
  `invite_recent` responses.
- Manager ↔ Staff role changes; self/Owner removal and Owner assignment blocked.
- Direct Manager/Staff invitation, role and revocation calls are rejected.
- Foreign clinic role changes, revocation and resend are rejected.
- Two clinics concurrently target one new email: exactly one profile and one
  matching permanent clinic claim exist; the losing request fails generically.
  The winner's additional email attempt hits the mailer failure described below.
- The published `/account/setup` implementation is present. The disposable
  invitation token was accepted by Auth, its password saved, password login
  succeeded and directory status changed to accepted. No link was regenerated
  to substitute a different setup flow.
- Non-owner revocation preserves its profile/Auth identity. Its retained JWT
  immediately loses client/call reads, client CRUD and directory access.
- A second retained Staff JWT loses appointment read/CRUD and availability RPC
  access after revocation. The isolated appointment used a slot returned by the
  deployed availability RPC. Historical appointments were never targeted.
- A privileged fixture setup revokes a disposable Owner, whose retained JWT then
  fails Edge and database administration checks. Real Owners were untouched.
- All disposable Auth users, profiles, operational fixtures, clinics, email
  claims and budgets were removed. Production record fingerprints and counts
  match the baseline exactly.

### Acceptance limitation: post-cooldown email resend

After waiting more than 60 seconds, resend cleared the database cooldown and
reached Auth's mailer, but returned safe `invite_email_failed` (HTTP 502).
The production Auth configuration has no custom SMTP and a two-email hourly
quota. Both initial invitations had already succeeded; the later race email
also returned mailer failure. The provider's private error was not exposed by
the backend. **Successful post-cooldown email delivery remains unaccepted** and
must be retested when the default mailer permits another email. Do not change
claims/timestamps or increase production limits to bypass this acceptance.

## Local release validation

The exact staged release was exported into an isolated directory, excluding
unrelated local mobile/layout, Retell and operational backend edits. It passed
371 targeted test results across Team/invitation hardening, Auth, setup,
provisioning/CLI, permissions, isolation, appointments, voice routing/handlers
and bounded request-body handling. Frontend TypeScript, invitation backend
TypeScript and production build passed. Targeted ESLint passed with three
existing Fast Refresh warnings and no errors; compact legacy files were checked
with the existing formatting-rule exception. Both working and staged
`git diff --check` passed.

Compatibility SQL snapshots keep the release tests independent of unrelated
untracked migrations. Read-only isolation inspection and the corrected
cross-clinic RPC regression are committed as test fixtures; no production
migration beyond the accepted Team migration is introduced.

## Remaining production steps

1. Manually publish the updated frontend in Lovable. The inspected published
   bundle contains `/account/setup`, but no Team route, Owner invite backend call
   or revocation action. A GitHub push alone is not publication evidence.
2. Verify the published Team dashboard and retry actual post-cooldown resend
   delivery when Supabase's current email quota allows it. Browser automation
   was unavailable for this release; API and published-bundle verification were
   used instead.

**Launch ready: NO until frontend publication and remaining acceptance pass.**
