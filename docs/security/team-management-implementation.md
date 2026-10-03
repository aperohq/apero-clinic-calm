# APERO User / Staff Management

> Current production release evidence: [team-management-production-release.md](team-management-production-release.md). Earlier implementation notes below describe the pre-release state.

Status: **BUILT LOCALLY — NEEDS PRODUCTION ACCEPTANCE**.
Date: 2026-10-03. Audit: [team-management-audit.md](team-management-audit.md).

No production access or modification, deployment, migration application, push,
paid call, or unrelated feature work occurred during this task. Existing
uncommitted workspace changes were preserved. No dependency was added.

## 1. Existing architecture found

Supabase Auth owns identity, invitation verification, sessions and passwords.
`profiles.auth_user_id` is unique; its profile links that identity to one clinic
and the existing Owner/Manager/Staff role. Database membership helpers and RLS
enforce clinic access. The existing Auth provider, recovery flow, setup page,
permission map and Owner role RPC are reused.

## 2. Portal user vs practitioner

**Portal account ≠ practitioner/staff record.** `staff` has its own clinical
identity, contact information, specialty, service array, active flag, hours
and time-off relationships. There is no profile/Auth foreign key. Accounts
never automatically create practitioners, and practitioner creation never
automatically creates portal accounts. This separation is unchanged.

## 3. Functionality that already existed

Clinic authentication and password recovery; multiple clinic accounts;
Owner/Manager account directory; Staff own-profile access; verified Owner-only
Manager/Staff role changes; private operator provisioning; Auth invitations and
`/account/setup`; practitioner creation/detail edits, services/specialties,
active/inactive state, weekly availability and time-off management; appointments
and clinic isolation. The original account panel required an operator to invite
users and had no status or revocation workflow.

## 4. Functionality implemented

`/account/team` and role-filtered Team navigation reuse the account-access panel.
Owner invitation and resend, safe account/invitation statuses, empty/error/retry
states, and confirmed access revocation complete that panel. The Account page
retains its existing panel for compatibility. Frontend and backend directory
reads paginate beyond Supabase's single-response cap.

## 5. Owner experience

Team shows name, email, role and status. Invite user opens a simple name/email/
Manager-or-Staff form. Non-owner active accounts have role controls and Revoke
access; pending invitations also offer Resend invitation. Revocation names the
target and requires confirmation. Success, pending saves and safe failures have
visible feedback. Owner/self accounts have no mutable controls. The database
enforces the same restrictions even when the UI is bypassed.

## 6. Manager behavior

Managers retain the read-only clinic account directory and their existing
practitioner/schedule powers. They cannot invite, resend, revoke, change portal
roles or assign Owner, including through direct backend/RPC requests.

## 7. Staff behavior

Staff retain their own profile and existing operations. They have no Team
navigation, private account-directory RPC access, invitation/revocation/role
powers or practitioner configuration powers. No permission enum or permission
builder was introduced.

## 8. Invitation implementation

The new `manage-clinic-users` Edge boundary validates the bearer using Auth
`getUser`, resolves a live active Owner profile, and accepts strict invite/resend
inputs. The request cannot supply a clinic, Auth ID, Owner role or redirect.
It reuses `provisionClinicUser` and `invitationRedirect`; the operator path is
unchanged. A private database preflight rejects existing linked/confirmed Auth
identities before generation can rotate a foreign clinic's pending link.
The private membership RPC rechecks and locks the Owner and identity, derives
the clinic, and inserts only Manager/Staff. Email follows verified membership.

Supabase's [generateLink](https://supabase.com/docs/reference/javascript/auth-admin-generatelink)
creates the Auth invitation; [inviteUserByEmail](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail)
delivers its email to the existing `/account/setup` flow. No second invitation
table, token scheme, mail provider or custom SMTP was introduced. Auth links,
tokens, Auth IDs and provider diagnostics are not returned to the browser.

Same-clinic duplicate, pending and accepted states are actionable. Existing
global Auth accounts/foreign memberships share a generic failure and are never
automatically reassigned. The existing explicit operator association workflow
remains for those exceptions. Email failure retains the verified pending
profile and offers retry via resend. A membership/database failure withholds
email and retains any newly created Auth identity for safe inspection/retry;
there is no blind Auth deletion.

Status is derived from safely filtered `auth.users.invited_at` and
`email_confirmed_at`. Invite accepted means the Auth invitation was verified,
not that password setup is known to be finished. Existing ordinary accounts
show Active account. Exact Auth link expiry is not exposed or guessed: the
existing invalid/expired setup state now directs users to their clinic Owner,
and pending accounts offer fresh invitation emails. Revoked accounts are not
implicitly restored by another invitation; restoring access remains an
explicit operator action outside this V1 workflow.

## 9. Role management

The existing `set_clinic_member_role` contract and frontend saved-role
verification remain. Its proposed updated definition also rejects revoked
actors and targets. Owner assignment, self/Owner changes, foreign-clinic
targets, direct browser role updates and forged Owner metadata fail.

## 10. Revocation/removal

`revoke_clinic_member` locks the live Owner and same-clinic non-owner target and
sets `profiles.revoked_at`; repeat revocation is idempotent. It neither deletes
nor detaches any profile, Auth account or historical foreign key. The three
membership helpers ignore revoked profiles, so requests using retained or
refreshed JWTs lose protected clinic reads, writes, slot discovery and admin
RPC access after revocation commits. No JWT refresh or global Auth ban is needed.

The frontend also rejects revoked profiles and checks membership on focus and
every 30 seconds while visible. It clears cached clinic data when the association
disappears. Server denial is immediate; UI refresh does not make already
downloaded data disappear retroactively from a device's memory.

## 11. Practitioner changes

None. Existing clinical Staff pages, edit/active controls, service assignment,
weekly hours, time off and booking relationships remain. Tests cover Manager
creation/configuration, active/inactive slot behavior, time-off blocking and
appointments after the proposed membership migration. Account operations do
not create/delete practitioners or rewrite their schedules/history.

## 12. Backend/database security

Auth Admin credentials stay in the Edge runtime. User operations use RLS;
privileged invitation operations require both the authenticated Edge boundary
and service-only SQL grants with a locked, verified Owner subject. Revocation
and role RPCs independently enforce their actor and target restrictions.
Existing profile column grants and immutable identity guard remain; direct
revocation-field writes are not granted. Existing voice/appointment protections
are retained. The endpoint bounds JSON bodies, restricts CORS to the configured
portal origin, rejects wrong methods/content types, uses request timeouts and
returns curated no-store responses. The production frontend bundle contains
neither private invitation RPC names nor service-role configuration markers.

## 13. Cross-clinic isolation

Team data is selected using the actor's database clinic, with no caller-supplied
clinic selector. Owners cannot read/change/revoke/resend another clinic's
accounts, attach its Auth identity or rotate its pending invitation. PostgreSQL
RLS tests exercise two clinics, direct requests, retained revoked claims and
forged metadata. The full clinic-isolation regression suite passes with the
proposed team migration loaded locally.

## 14. Files changed for this task

- `docs/security/team-management-audit.md`, this implementation report.
- `src/components/account-access-panel.tsx`: existing panel completed.
- `src/components/app-layout.tsx`: Team navigation entry only.
- `src/components/clinic-pages.tsx`: login invitation guidance only.
- `src/components/invite-setup-page.tsx`: expired-link guidance.
- `src/lib/auth.tsx`: revoked membership rejection and visible-page refresh.
- `src/lib/db-types.ts`, `src/lib/team-management.ts`: existing-schema types,
  paged directory and safe invitation client.
- `src/routes/account_.team.tsx`, generated `src/routeTree.gen.ts`.
- `supabase/functions/_shared/clinic-users.ts`: optional secure Owner path
  preserving operator provisioning behavior.
- `supabase/functions/manage-clinic-users/{index.ts,function.ts,handler.ts,deno.json}`.
- `supabase/config.toml`: new function's user-bearer verification configuration.
- `supabase/migrations/20261003160000_clinic_team_management.sql`.
- `tests/team-management.test.mjs`, `tests/team-invitations.test.mjs`,
  `tests/team-management-ui.test.tsx`.
- `tests/helpers/clinic-database.mjs`: optional local migration loading and
  local Auth invitation-column shim.
- `tests/clinic-permissions.test.mjs`: preserve proposed migration during
  compatibility checks after the historical role migration is loaded.
- `tests/clinic-auth.test.tsx`, `tests/run-clinic-auth-tests.mjs`,
  `tests/run-clinic-permission-tests.mjs`: updated local directory/Team fixtures.
- `tests/tsconfig.clinic-users-edge.json`: new backend TypeScript coverage.
- `package.json`: `test:team` command only; existing dependency/workspace
  modifications were retained and the lockfile was not changed by this task.

Other already modified/untracked files in the workspace are not changes from
this task. No practitioner, appointment or voice application code was changed.

## 15. Migration and why

The single proposed migration adds one nullable timestamp column,
`profiles.revoked_at`, and updates membership/role guards plus restricted Team
RPCs. No product rows are rewritten, no tables duplicated, no enum changed,
no foreign keys removed and no RLS policies weakened. Existing accounts remain
active because the added field defaults to NULL. Profile deletion was rejected
because it clears historical note-author relationships and cascades profile
notifications; retaining profiles with a revocation marker is the smallest safe
design. The migration is repeat-safe in a disposable PostgreSQL test. It has
**not been applied to production**.

## 16. Validation

All **380 test results passed**:

| Suite | Passed |
| --- | ---: |
| New Team database / Edge invitation / browser UI | 15 / 17 / 15 |
| Authentication | 29 |
| Existing invitation setup, including invalid/expired | 8 + 3 |
| Existing operator provisioning / CLI | 23 / 24 |
| Permissions database / browser UI | 14 / 9 |
| Clinic isolation | 133 |
| Appointments database / Calendar UI | 18 / 19 |
| Appointment conflict handling | 12 |
| Voice Edge authentication/isolation boundary | 11 |
| Existing appointment migration safety | 30 |

The relevant database compatibility suites used
`APERO_TEST_TEAM_MIGRATION=1` to load the proposed migration only into ephemeral
PGlite PostgreSQL. New database and Edge tests also load the current appointment
rules. Browser tests use actual React, Auth context and Supabase SDK against
local HTTP fixtures. Auth/mail provider responses are local fixtures; no email
or paid voice call was sent. This validates application contracts, not hosted
SMTP delivery or the production Deno gateway.

Main TypeScript, backend TypeScript, production build, targeted lint and
`git diff --check` pass. Lint has zero errors and three existing Fast Refresh
warnings in the shared Auth/clinic page files. New modules pass normal lint;
Prettier enforcement was disabled only when linting existing compact-style
files. Deno is not installed here; runtime/gateway acceptance remains pending.

## 17. Production deployment and acceptance still required

Nothing is deployed. A separately authorized release must review/apply the
single Team migration, deploy `manage-clinic-users` with its pinned import map
and configured `APERO_PORTAL_ORIGIN`, then publish the coordinated frontend.
The Edge runtime must supply its standard server-only Supabase URL/anon/service
credentials; none belongs in frontend environment variables. Keep the existing
Auth redirect allowlist and working `/account/setup` email flow.

Then use disposable production accounts to verify delivered email, fresh and
expired/resend links, password setup, Owner role changes, confirmed revocation
with a retained JWT, Manager/Staff direct-call rejection, two-clinic isolation,
and practitioner/appointment history preservation. Supabase's configured email
sender and quotas are used as requested; custom Apero SMTP is postponed.
No live AI call is required for this milestone.

## 18. Final status

**BUILT LOCALLY — NEEDS PRODUCTION ACCEPTANCE**.
