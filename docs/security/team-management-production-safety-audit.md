# APERO Team / User Management production safety audit

Date: 2026-10-03. Verdict: **NEEDS CHANGES**.

Follow-up: these invitation findings are resolved locally in
[team-management-invitation-hardening.md](team-management-invitation-hardening.md).
This document preserves the original pre-fix audit.

Audit performed locally against the current working tree. No deployment, push,
production connection, hosted migration, production modification, paid call,
or application-code fix was performed. Existing workspace changes were preserved.
Local build output and this report are the only repository artifacts produced
by the audit. Tests use disposable local PostgreSQL/WASM databases and mocked
Auth/HTTP providers; they do not prove hosted SMTP or Edge-runtime acceptance.

## 1. Deployment verdict and findings

Database authorization and non-destructive migration behavior passed. The
invitation boundary needs these changes before release:

1. **Invite/resend throttling is missing.** The handler performs privileged Auth
   operations without an atomic per-Owner/clinic rate limit or per-recipient
   resend cooldown. A local probe sent five sequential resends immediately;
   all returned 200 and all five reached `/auth/v1/invite`. This demonstrates
   absence of an application throttle, not five real emails. Supabase/provider
   quotas may reject requests in production, but their configuration was not
   inspected and cannot substitute for application-level admission control.
   Source: `supabase/functions/manage-clinic-users/handler.ts:109`.

2. **Cross-clinic invitation preflight is not atomic with Auth generation.**
   `owner_invite_email_available` finishes its transaction before
   `generateLink`. Another clinic can attach the pending identity in that gap.
   A local interleaving probe demonstrated that Auth generation is still
   invoked, then the membership RPC rejects the foreign identity and email
   is withheld. No foreign membership or protected data changed. However,
   Supabase's invitation generation updates an existing unconfirmed identity's
   confirmation token and invitation timestamps. Thus a competing request
   can affect another clinic's pending invitation even though the later
   membership check prevents reassignment. The token effect is inferred from
   the provider implementation; actual production Auth was not exercised.
   [Supabase Auth implementation](https://raw.githubusercontent.com/supabase/auth/master/internal/api/mail.go)
   Source: `supabase/functions/_shared/clinic-users.ts:74` and `:84`.

3. **Total work has no explicit bound.** Directory loading is a loop over every
   1,000-row page, with no page/row ceiling or total request deadline. Individual
   outbound fetches time out after 30 seconds; that does not bound the entire
   sequence or streaming body-read time. Prefer authorized target lookups or a
   bounded fail-closed lookup, and a deadline for the whole request.
   Source: `supabase/functions/manage-clinic-users/handler.ts:45` and
   `supabase/functions/manage-clinic-users/function.ts:47`.

## 2. Exact migration changes

File: `supabase/migrations/20261003160000_clinic_team_management.sql`.
The transaction adds nullable `profiles.revoked_at timestamptz` with no default;
replaces the three membership helpers, profile-sensitive-field trigger function
and role RPC; adds the revocation RPC, directory RPC and two service-only invite
RPCs; restricts execution/column grants; and requests PostgREST schema reload.
It does not create another identity or practitioner system.

All nine functions use `SECURITY DEFINER`, with fixed
`search_path = public, pg_temp`. None uses `SECURITY INVOKER`.
The security-sensitive table references are schema-qualified.
All PUBLIC and anonymous execution privileges are revoked.
The effective ACLs below were inspected in the local database with the existing
privilege and appointment migrations installed:

| Function | Authenticated execution | Service-role execution | Authorization |
| --- | --- | --- | --- |
| `current_clinic_id()` | Yes | Yes | Auth subject; active profile only |
| `current_profile_id()` | Yes | Yes | Auth subject; active profile only |
| `current_profile_role()` | Yes | Yes | Auth subject; active profile only |
| `guard_profile_sensitive_fields()` | No direct execution | No direct execution | Existing trigger; protected fields, explicit trusted-service bypass |
| `set_clinic_member_role(uuid,profile_role)` | Yes | No explicit grant | Active Owner; own-clinic non-Owner/non-self/non-revoked target; Manager/Staff only |
| `revoke_clinic_member(uuid)` | Yes | No explicit grant | Active Owner; own-clinic non-Owner/non-self target |
| `clinic_team_members()` | Yes | No explicit grant | Active Owner/Manager; own clinic only |
| `owner_invite_email_available(uuid,text)` | No | Yes | Service-role JWT and active database Owner; global collision check, boolean result only |
| `owner_invite_clinic_member(uuid,uuid,text,text,profile_role)` | No | Yes | Service-role JWT and active database Owner; clinic derived from actor; identity and target locks |

Function ownership remains the database owner. Trigger execution does not
require exposing its function as a callable browser RPC. The service role
retains its table privileges and existing voice RPC privileges; it uses the two
private invite RPCs rather than the browser administration RPCs.
Hosted default privileges/role inheritance can differ from the local fixture;
the migration's explicit revocations/grants, not the fixture, are the release
contract. Hosted catalog confirmation belongs to separately authorized release
acceptance, not this no-production audit.

## 3. Destructive operations

None during installation: no DROP/TRUNCATE/DELETE of data; no Auth-user or
profile deletion; no operational-history changes; no membership or role backfill.
A before/after comparison of all 16 product tables plus `auth.users` passed.
Only the new column changes profile shape, with existing values NULL.
Invoked administration functions later insert a new profile or update a role or
revocation timestamp; they do not delete identities/history/practitioners.

## 4. Compatibility with active users

Existing active users remain active because `revoked_at` defaults to NULL.
Profile IDs, Auth IDs, clinic assignments and roles are unchanged. Active Owner
and Manager directory/appointment access passed after installation. The column
is nullable, timestamp-with-time-zone, and has no default in the catalog.
Reapplying the migration preserves existing revocation markers.

Prerequisites remain the existing profile RLS/identity trigger, role permissions,
and restricted table/column grants. The new migration does not recreate the
trigger or normalize legacy table-wide profile UPDATE grants. Its column-only
REVOKE cannot remove a table-wide UPDATE grant. The local installed baseline
has an enabled guard trigger, no authenticated table-wide profile UPDATE, no
revocation-column UPDATE, and permitted full_name UPDATE. Verify these
prerequisites at release time; do not treat the file as a standalone migration
for an arbitrary older schema.

## 5. Retained-session revocation

PASS for requests/transactions authorized after the revocation commits.
Every membership helper resolves the live database profile and returns NULL
when revoked. Existing clinic-data RLS policies use those helpers; JWT metadata
cannot override membership. A retained Staff JWT lost portal reads, client and
appointment updates/deletes, appointment insert/availability and administration
RPCs. A separate retained Owner JWT probe lost all portal-table reads, all
portal-table UPDATE/DELETE attempts (zero rows or permission denial), directory,
role/revocation RPCs and both service-only invite checks for that revoked actor.
Calls/conversations, clients and appointments are included.

RLS enabled flags and policy definitions were identical before and after the
migration. Internal voice tables retain denied browser grants. Revocation does
not depend on frontend logout. Old downloaded data cannot be erased, and an
already-running request using an earlier database snapshot is not retroactively
undone. Auth/password changes, invite acceptance, retries and role changes do
not clear the revocation marker. Restoration remains an explicit privileged
operator workflow. An authorized in-flight email request can finish after its
last database check; it cannot restore clinic access.

## 6. Owner administration security

PASS for database role/revocation actions and authorization of new invite/resend
requests. Database functions lock and validate the actor's real profile, require
an active Owner and scope targets to that clinic. Owner assignment, changing or
revoking an Owner, and self-revocation are rejected. Resend validates a pending,
non-Owner, non-revoked same-clinic member and rechecks the actor/target through
the private RPC. Invitation timing/rate findings in section 1 remain open.

## 7. Manager/Staff bypass assessment

PASS. Both roles fail direct invitation/resend HTTP calls before Auth Admin
operations. Direct role/revocation RPC calls fail inside the database, including
forged Owner metadata. Staff cannot call the directory or private invite RPCs;
Managers retain their existing read-only clinic directory. Staff retain only
their own active portal profile and existing operational permissions.

## 8. Cross-clinic isolation

PASS for protected reads/writes, role changes, revocation and final membership
assignment. A foreign profile UUID cannot be targeted; frontend-supplied clinic
or Auth IDs are rejected. Unique Auth/profile membership and locked target
checks prevent reassignment. Known foreign pending invites are rejected before
Auth generation. The concurrent preflight/Auth-token boundary is a separate
remaining defect described in section 1; full invitation isolation is therefore
not approved yet.

## 9. Invite/resend backend security and account behavior

The Edge handler validates the bearer independently with Auth `getUser`; it
never trusts decoded metadata. It resolves the caller's live profile under RLS
and requires an active Owner. Clinic comes from database membership. Role is
strictly Manager/Staff. Caller-controlled redirects/clinic/Auth IDs are excluded.
Server credentials are read only at the Edge/server boundary. No private RPC
markers or service-key environment names were found in built browser JS.
Existing `client.server.ts` service-key access is server-only. Response payloads
exclude tokens, invitation links, private Auth diagnostics and global account
information.

CORS permits only the configured exact portal origin; no-Origin authenticated
server requests are supported. Wrong methods/content types/bearers/origins are
rejected. Streamed and declared request bodies are bounded at 4,096 bytes;
email/name/UUID/role fields are validated. Individual fetches have a 30-second
timeout. Rate and total-work limits are incomplete, as above.

| State | Current V1 behavior |
| --- | --- |
| New email | Generate Auth invite, attach profile through checked RPC, then send Auth email to `/account/setup` |
| Same-clinic pending member | New invite returns `invite_pending`; resend targets existing profile without role reassignment |
| Expired invite | Remains conservatively pending; resend issues another Auth invite; existing setup rejects invalid/expired links |
| Accepted/active member | Invite returns `already_member`; resend rejected |
| Verified Auth identity without membership | Generic `invite_unavailable`; explicit operator association required |
| Unconfirmed Auth identity without membership | May attach through the checked invitation path; no existing membership is overwritten |
| Revoked member | Invite returns `access_revoked` in its own clinic; resend/role restoration rejected |
| Provider/email failure | Safe error; an already-created pending profile is retained for explicit resend; no identity deleted |

These are deterministic for sequential requests. Concurrent identity-generation
behavior needs the section 1 fix. Cross-clinic/global account failures are generic;
more specific statuses are disclosed only for the authorized clinic directory.

## 10. Practitioner/account separation

PASS. `auth.users`/`profiles` are portal identities/membership; `staff` is the
practitioner model. No implicit profile/Auth linkage exists. Account functions
reference neither practitioner configuration nor availability/time-off/service
writes. Account-operation tests preserve staff, schedules, time off and history.
Practitioner creation does not add a profile, and practitioner deletion/config
cannot alter a portal membership or grant access.

## 11. Service-role, voice and appointment compatibility

PASS locally. Existing service table access and voice behavior remain intact.
Membership helper execution is explicitly retained for authenticated and
service_role. Voice-internal browser privileges are unchanged. Active Manager
practitioner scheduling, active/inactive behavior and appointment lifecycle pass.
Shared-availability/conflict and appointment-security suites pass with the new
membership helpers. No Retell or paid voice call was made.

## 12. Tests and checks

The requested regression rerun produced **380 passing results, zero failures**:

| Suite | Passing results |
| --- | ---: |
| Team database / Edge invitation / UI | 15 / 17 / 15 |
| Authentication | 29 |
| Invite setup, including invalid invites | 11 |
| Provisioning with team migration | 23 |
| Provisioning CLI | 24 |
| Database permissions / UI permissions | 14 / 9 |
| Clinic isolation/security with team migration | 133 |
| Appointment database / Calendar | 18 / 19 |
| Appointment conflicts | 12 |
| Voice Edge isolation | 11 |
| Appointment migration safety | 30 |

The temporary invitation audit fixture reran the 17 boundary results plus two
additional probes: all 19 passed their assertions, demonstrating the two open
findings rather than asserting those behaviors are safe. Additional local
catalog/data/policy/retained-Owner checks passed. Initial audit-script failures
were corrected fixture assumptions (service claims required for operator
revocation; baseline includes additional seeded appointments), not application
failures.

Frontend TypeScript, backend/Edge implementation TypeScript, production build,
targeted lint and `git diff --check`: PASS. Lint: zero errors, three existing
Fast Refresh warnings. Existing compact-format files were checked with only
Prettier's lint rule disabled; new Team files used normal rules. Deno is not
installed, so native Deno entrypoint/runtime validation was not performed;
backend TypeScript covers shared provisioning and the Edge function/handler.
Hosted email delivery, redirects and gateway behavior require later acceptance.

Evidence:
- `/tmp/apero-team-safety-results.json` and matching suite logs.
- `/tmp/apero-team-safety-catalog.json` and `.log`.
- `/tmp/apero-team-safety-invite-probes.log` and `.mjs`.
- `/tmp/apero-team-safety-catalog.mjs`.

## 13. Required changes before production

Implement atomic, shared invitation admission controls across Edge instances:
per-Owner/clinic rate limits and per-target resend cooldown. Serialize email/identity
invitation orchestration across clinics before Auth generation, including normal
Owner invitation/resend and any competing operator path. A database preflight
transaction whose lock ends before the Auth call is insufficient. Denied
competing requests must not rotate the winning clinic's Auth invitation.
Bound total request work and directory lookup. Add concurrent-invitation,
rate-limit/cooldown and bounded-work regressions; rerun affected checks.

No verified-account association automation or revoked-account restoration
feature is required. No application fix or additional migration was created
by this audit. After fixes, separately authorize deployment and perform native
Edge/email/SQL/catalog acceptance.

## 14. Supabase SQL Editor applicability

**The migration is structurally safe and SQL-Editor compatible on the stated
existing production schema, but the complete feature is not yet approved for
deployment.** Its BEGIN/COMMIT transaction, SQL/PLpgSQL definitions, grants and
PostgREST NOTIFY execute successfully locally and preserve data/RLS. Use a
privileged migration connection with the existing guard, role/privilege schema
and Auth columns; review the prerequisite catalog first. The file should be
applied as one transaction. No migration was applied to production here, and
this conditional compatibility assessment does not claim live catalog verification.
