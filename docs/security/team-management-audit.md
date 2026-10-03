# Team management: repository audit before implementation

Date: 2026-10-03. Repository HEAD: `9160a889747eb3b140aafa047438dc00d7363876`.
This audit inspected the repository only. No production queries, writes,
deployment, migration execution, commits, or pushes are part of this task.
Existing uncommitted work is retained.

## Identity and membership

- `auth.users` is the existing Supabase authentication system. Passwords,
  invitation verification, sessions and recovery belong to Supabase Auth.
- `public.profiles` has a unique, mandatory `auth_user_id` foreign key to
  `auth.users`, a mandatory clinic foreign key, name, email, phone and the
  existing `owner | manager | staff` enum. One Auth user has one profile and
  therefore one clinic association in this V1 architecture.
- The database's `current_clinic_id`, `current_profile_id` and
  `current_profile_role` resolve membership from profiles on every request.
  Tenant RLS uses these helpers, rather than editable JWT metadata.
- `AuthProvider` resolves the authenticated profile and clinic, clears cached
  data across identity/clinic/role changes, and refreshes on focus. Route guards
  and navigation use the existing permission map; RLS is the enforcement layer.
- Owners and Managers can read their clinic's account directory. Staff can read
  their own profile. Browser profile updates are limited to name and phone.
- `set_clinic_member_role` locks actor and target memberships and allows an
  Owner to assign Manager/Staff only to a non-owner in their own clinic.
  Owner assignment, owner changes, self-changes and cross-clinic changes fail.

## Existing account and invitation UI

`AccountAccessPanel` on Account already lists name, email and role, shows
Manager/Staff controls to Owners only, verifies role writes, invalidates the
directory, and handles loading/errors. It has no invitation, account status,
empty-state or revocation workflow and tells users to contact the operator.
`/account/team` has a reserved permission rule but no implemented page.

The private Node operator script and retained secret-authenticated provisioning
Edge function reuse `supabase/functions/_shared/clinic-users.ts`. The helper
validates inputs, restricts redirects, generates an Auth invitation, inserts a
Staff profile only after identity verification, handles unique-profile races,
and never reassigns an existing account to another clinic. Operator links are
returned privately; `generateLink` does not deliver email. Existing confirmed
Auth association is a separate, explicit operator action.

`/account/setup` already consumes the Auth session, validates password and
confirmation, uses authenticated `updateUser`, and handles invalid/expired
links. It creates neither membership nor roles. Forgot/reset password works
through the existing Auth context.

There is no account revocation/deactivation state. Removing a profile would
clear `client_notes.author_profile_id` and delete profile notifications through
existing foreign keys. Deleting `auth.users` cascades to profiles. Neither is
an acceptable access-removal implementation because it loses history.

## Portal account ≠ practitioner/staff record

`public.staff` has its own primary key and clinic foreign key, name, specialty,
contact details, services array and active flag. It has **no profile or Auth
foreign key**. A portal role called Staff is an authorization role, not a link
to a practitioner. Practitioner email is contact information, not membership.

`staff_availability` stores the practitioner's weekly hours; `staff_time_off`
stores blocked date/time ranges. Appointments reference `staff.id`, not portal
profiles. Clinical history must survive portal access changes.

The existing Staff list/detail pages and dialogs already support creation,
name/specialty/contact/service edits, active/inactive state, weekly availability,
time-off creation/edit/removal, clinic timezone display and upcoming appointments.
Owner/Manager can configure these records; Staff portal users cannot. Creating
a practitioner does not create a login and inviting a portal user does not
create a practitioner. Preserve this architecture without a new linkage.

## Implementation decision

Reuse the existing Account panel, permission map, role RPC, Auth invitations,
setup page and practitioner system. Add a Team page that hosts the same panel,
an authenticated Owner-only Edge invitation boundary, and a minimal proposed
migration adding nullable `profiles.revoked_at`. Existing rows remain active
without rewriting data. Membership helpers ignore revoked profiles, so retained
old JWTs cannot authorize clinic data reads or mutations. Preserve all profiles,
Auth users, practitioner records and historical foreign keys.

Use safely filtered Auth invitation metadata for directory status, never expose
tokens or Auth Admin credentials. Invitation accepted means the Auth invitation
was verified; it does not claim password setup was completed. Exact link expiry
is not safely known by the portal; expired links are handled by the existing
setup page and Owner resend action. Supabase's current mail delivery is used;
custom SMTP, Settings, Analytics, Billing and WhatsApp remain out of scope.
