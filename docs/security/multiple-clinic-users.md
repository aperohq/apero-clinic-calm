# Multiple users per clinic

The launch flow uses the private direct Node operator tool. The former Edge
implementation is deprecated. See [direct operator runbook and live acceptance steps](clinic-user-provisioning-deployment.md).

The existing relationship is unchanged:
`auth.users.id → profiles.auth_user_id → profiles.clinic_id → clinics.id`.
Only `auth_user_id` is unique; several profiles may share a clinic. The auth
context, membership helpers, and RLS resolve membership separately for each
session. Each user keeps their own profile and account details. Session/cache
state clears on account changes and logout.

## Operator-assisted addition

This milestone uses approved operator-assisted invitations. Clinic users ask
APERO to add a colleague; a trusted APERO operator verifies that the clinic
approved that person's access. There is no new browser endpoint or team UI.
Possession of the backend service credentials is required to execute the tool;
a browser cannot self-assign membership. Do not expose the tool as a public
HTTP handler without separate authorization design.

`src/lib/clinic-users.server.ts` re-exports the shared server-only capability and
`scripts/provision-clinic-user.mjs` is its Node 24 operator entry point. It uses
a private, stateless Supabase Admin client from
`scripts/clinic-user-admin.server.mjs`, with exported `SUPABASE_URL` and
`SUPABASE_SECRET_KEY` (`sb_secret_...`), never VITE-prefixed secrets. Direct
provisioning is the default and only supported operator CLI backend. The
shared logic remains in `supabase/functions/_shared/clinic-users.ts`.

Create a private input file outside the repository:

```json
{
  "mode": "invite",
  "clinicId": "00000000-0000-4000-8000-000000000100",
  "email": "colleague@example.test",
  "fullName": "Clinic colleague"
}
```

Replace the fixture values with an operator-approved identity/clinic. Validate
input locally first; this command validates private configuration but makes no network requests:

```bash
node scripts/provision-clinic-user.mjs --input /private/member.json --portal-origin https://your-portal.example --check
```

After separate authorization to create a real account, the operator may replace
`--check` with `--execute --output /private/invitation.json`. Execution contacts
Supabase and creates account/membership data; it was **not run against a live
service in this task**. Do not include secrets in command arguments, input JSON,
frontend code, logs, or source control. Configure Supabase Auth's allowed
redirect URL to include the actual portal's `/account/setup` URL before acceptance.
The portal origin must be HTTPS, except for explicit loopback local testing.

The tool verifies the clinic, generates a Supabase Auth invitation with
`auth.admin.generateLink({type: 'invite'})`, and inserts a profile for the
provider-returned Auth identity. It does not send email. The invitation URL is
released only after the profile is verified against the approved clinic.
[Supabase generateLink documentation](https://supabase.com/docs/reference/javascript/auth-admin-generatelink).

The result is written to a new exclusive file with mode 0600. It contains
Auth/profile/clinic IDs and the secret invitation URL. Share that URL privately
with the intended recipient through the operator's established channel; it is
not printed to the terminal or automatically sent to anyone. The recipient
accepts the provider invitation, reaches the existing Account page, and sets a
password using the existing account form. Subsequent login uses email/password.
Real redirect acceptance, invitation expiry, and password setup remain manual
acceptance checks; local tests do not simulate email delivery or live Auth.

## Existing Auth accounts and recovery

For an existing **verified** Auth account, use `mode: "associate"` and add its
explicit `authUserId` UUID to the same fields. The tool fetches that account
through Admin Auth and checks both its UUID and email plus email confirmation.
It inserts a profile only if none exists. This mode returns no invitation URL
and never resets a password, alters Auth identity, or moves membership.

New profiles use the existing `staff` value. Existing `owner`, `manager`, and
`staff` values and permissions remain unchanged; this milestone introduces no
permission matrix or role-management operation. Existing profiles retain their
personal details and role on retries. Do not use historical
`db/02_link_owner_profile.sql` to add colleagues: it targets a seed clinic and
can overwrite an existing user's membership/role.

Provisioning never upserts or updates profiles. The existing unique Auth-user
constraint arbitrates concurrent inserts, followed by a membership read. A
same-clinic retry succeeds; another clinic's association fails without issuing
the link. Unknown fields, including caller-selected roles, are rejected.

Auth account creation and profile insertion are separate service operations.
On profile failure, the tool withholds the link and reports the created Auth
UUID where available. The account stays blocked from clinic data without a
valid profile. Inspect the account before retrying; regenerate an invitation
for the same email/approved clinic, or explicitly associate a verified existing
account. No automatic user deletion is attempted, since a concurrent process
may already have associated it. If the output write failed after provisioning,
inspect the matching Auth account/profile before regenerating the link. An
output file is never overwritten, including an empty file from a failed run.

## Local validation

- `npm run test:clinic-users`: real Supabase SDK, mocked in-process Auth
  transport, and actual local PostgreSQL for profile/membership queries.
  Exercises A1/A2/B1 shared/isolated reads, personal profile updates, membership
  tampering, retries, concurrent inserts, existing verified users and failures.
- `npm run test:auth`: existing regressions plus A1/A2/B1 membership resolution,
  restored sessions/token refresh, and independent-browser logout.
- `npm run test:security`: existing PostgreSQL grant/RLS/trigger/FK attack suite.
- `npx tsc --noEmit` (with installed local dependencies) and `npm run build`.

No database migration is needed. Auth, profile loading, dashboard/UI, policies,
and backend voice flows are reused. All execution during implementation is
local/free; no live accounts, invitation links, emails, or deployments were
created. Production acceptance must use operator-approved accounts and confirm
that the configured Auth provider/redirect settings and applied database grants
match the reviewed repository.
