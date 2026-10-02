# Clinic role permissions

The existing PostgreSQL `profile_role` enum remains `owner`, `manager`, `staff`.
The UI labels `manager` as **Admin / Manager**. Roles are read from the user's
authenticated profile, never from editable Auth metadata or frontend input.
Practitioners in `staff` are scheduling records, not portal account roles.

| Capability | Owner | Admin / Manager | Staff |
| --- | --- | --- | --- |
| Read calls, appointments and client records | Yes | Yes | Yes |
| Book, reschedule and cancel appointments | Yes | Yes | Yes |
| Update client details; add personal-authored notes | Yes | Yes | Yes |
| Create/delete clients; delete appointments/notes | Yes | Yes | No |
| Manage practitioners, availability and time off | Yes | Yes | No |
| View/handle voice requests | Yes | Yes | No |
| Edit own name/phone/password | Yes | Yes | Yes |
| View clinic account directory | Yes | Yes | Own profile only |
| Assign Manager/Staff to existing non-owner accounts | Yes | No | No |
| Edit clinic configuration | Yes | No | No |
| Change ownership/assign Owner | Private Apero operator only | No | No |
| Modify voice integrations/internal voice records | Trusted signed backend/operator only | No | No |

Existing role-aware RLS is retained for operational data. Cross-clinic access is
denied regardless of role. Calls cannot be forged by browser users, including
owners. Server voice functions continue to validate signed integration identity
and use their privileged client; no browser role bypass was added.

`set_clinic_member_role(profile_id, role)` is the sole new browser-callable role
operation. Its security-definer implementation locks and resolves the caller's
database profile, requires Owner, checks the target's clinic, rejects owner/self
targets, and accepts only Manager/Staff. It changes no identity, clinic, email,
or personal details. The existing profile trigger independently checks these
conditions. No direct browser grants to update role/membership were added.
Anonymous and unassociated callers fail closed. Backend service-role updates
retain their existing behavior. Ownership changes remain operator-assisted;
this milestone does not implement ownership transfer or an invitation UI.

The Account page shows the existing clinic accounts to Owner/Manager, with a
simple Manager/Staff selector only for Owner. The private provisioning script
still creates Staff profiles; invitations and clinic association are unchanged.
The frontend verifies saved changes. Database permissions apply immediately to
existing sessions; the frontend refreshes its profile on focus and clears cached
data when the role changes. A tab kept continuously active can retain stale UI
until refocused/reloaded, but cannot bypass database authorization.

The current dashboard contains operational totals available to all roles.
There are no dedicated analytics, billing/subscription, ownership, clinic
settings or integration-management screens/handlers in this repository.
Presentation permissions reserve analytics for Owner/Manager, billing and
ownership for Owner, and sensitive settings/integrations for Owner. These do
not authorize direct browser access to voice credentials. When those modules
are built, their database/server operations must enforce the corresponding
role checks; a frontend capability alone is never sufficient.

## Frontend release

The role-permission migration was already applied manually to production.
This frontend release does not include or apply SQL migrations. The Account
panel requires the existing `set_clinic_member_role` RPC and profile policies.
Publish the frontend through Lovable after the reviewed commit reaches main.
No secrets/configuration changes or Edge deployments are needed.

Manually test Clinic A Owner/Manager/Staff and Clinic B Owner: switch a non-owner
between Manager/Staff, refocus their existing session, confirm staff operations
continue, and attempt direct forbidden management, role mutation and cross-clinic
requests. Verify ordinary login, invite acceptance, refresh and independent logout.

## Local validation

`npm run test:permissions:ui` exercises the real browser Supabase SDK, profile
role refresh, protected routes, account selectors, authenticated role RPC calls,
logout, and the route/action matrix using local HTTP fixtures. It requires no
SQL migrations, operator credentials, or external services.
Also run `npm run test:invite-setup`, TypeScript, and the production build.

The private local database audit additionally uses PostgreSQL/WASM with the
reviewed SQL and four identities across two clinics. Those SQL files and audit
fixtures are not included in this frontend-only release. The database checks
must pass separately; mocked HTTP tests do not prove database authorization.
