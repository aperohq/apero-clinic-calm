# APERO private direct operator provisioning — launch runbook

> Current production release evidence: [team-management-production-release.md](team-management-production-release.md). Earlier implementation notes below describe the pre-release state.

The launch path is the private Node 24 tool `scripts/provision-clinic-user.mjs`.
It calls Supabase directly. No Edge Function deployment or frontend deployment
is required. The old Edge implementation is deprecated and retained solely for
historical/regression compatibility; the operator CLI rejects `--backend edge`.
Do not redeploy or configure it for this launch workflow.

## Private credentials and input

In the trusted operator environment, export `SUPABASE_URL` as
`https://svoybvzvmygszklcmudh.supabase.co` and provide `SUPABASE_SECRET_KEY`
(a valid project `sb_secret_...` server key) using the private secret mechanism.
The CLI does not automatically load `.env` and does not fall back to
`SUPABASE_SERVICE_ROLE_KEY`. Never put keys in command arguments, input JSON,
output files, frontend/VITE configuration, logs or source control.

The operator-only `scripts/clinic-user-admin.server.mjs` creates a stateless
`@supabase/supabase-js` admin client with session persistence, refresh and URL
session detection disabled. Requests use the secret in `apikey`, omit opaque
keys from Authorization, refuse redirects and have a 30-second timeout.
This module is not imported into application/frontend code.

Keep the approved input in a private directory outside the repository:

```json
{
  "mode": "invite",
  "clinicId": "REPLACE_WITH_APPROVED_EXISTING_CLINIC_UUID",
  "email": "REPLACE_WITH_APPROVED_NEW_USER_EMAIL",
  "fullName": "Clinic colleague"
}
```

The operator must verify clinic approval before adding the colleague. The shared
provisioning logic is unchanged: it verifies the clinic, calls Auth Admin
`generateLink({ type: "invite" })`, creates a profile if missing, and verifies
its Auth identity and clinic membership. Only then does it release the link.
It generates a private invitation without sending email automatically.
Existing profile details/roles are preserved; there are no profile updates,
upserts, clinic reassignments, role-management operations, or policy changes.

## Redirect and output

`--portal-origin` configures the invitation redirect as `origin + /account/setup`.
For production use `https://aperodashboard.lovable.app`. In Supabase
Authentication → URL Configuration, allow
`https://aperodashboard.lovable.app/account/setup` while retaining existing entries.
No Edge `APERO_PORTAL_ORIGIN` configuration is used by the direct tool.

The operator output uses Supabase's returned `properties.action_link` verbatim.
Do not construct verification URLs, remove query parameters, or change the
verification type. Newly generated invitations target `/account/setup`; links
generated previously with `/account` retain their old redirect.

The setup page is independent of the protected `/account` route. It waits for
the existing browser SDK's auth initialization and clinic loading, then lets
the authenticated invited user create and confirm their first password. It
uses `supabase.auth.updateUser({ password })` through the existing Auth context,
without changing profiles, clinic membership, roles, or RLS. Successful setup
opens `/home`. Sessionless/expired invitations show a safe error and sign-in
link. Existing `/account` and normal login behavior remain unchanged.

The output directory must already exist and be writable. Output is reserved
exclusively with mode 0600 before external operations. Existing files are never
overwritten. The file contains only verified Auth/profile/clinic IDs and the
private invitation URL (null for association), never the operator key.
Success prints exactly:

```text
Clinic membership verified. Private result written to the requested file.
```

## Local check and manual live acceptance

With credentials exported, local preflight makes no network calls and creates
no output file:

```bash
node scripts/provision-clinic-user.mjs --backend direct --input /tmp/apero-test/member.json --portal-origin https://aperodashboard.lovable.app --check --output /tmp/apero-test/invitation-direct-launch-20261002.json
```

After authorizing the real invitation, manually execute:

```bash
node scripts/provision-clinic-user.mjs --backend direct --input /tmp/apero-test/member.json --portal-origin https://aperodashboard.lovable.app --execute --output /tmp/apero-test/invitation-direct-launch-20261002.json
```

Check the private result and database profile for the approved clinic and exactly
one profile for the Auth UUID. Deliver the invitation privately. Verify that
the recipient reaches `/account/setup`, sets their password, logs in, refreshes in the
correct workspace and logs out independently of the existing clinic user.
Confirm normal authenticated access remains isolated from other clinics.

Publish the updated portal through the existing frontend release workflow
before that live check; no database migration or Edge redeployment is needed.
For this acceptance test use an approved new/unaccepted account and a fresh
output filename. Open the exact newest `invitationUrl` in a clean private
browser session. Confirm mismatched passwords are rejected, then submit a
valid matching password. Verify `/home` shows the same clinic, refresh, log
out, and sign in normally with the new password. Opening `/account/setup`
without a session must show an invalid/expired invitation rather than a form.
No production deployment or invitation was performed during implementation.

Retries must use a new output filename. Before retrying any failed request,
inspect partial Auth/profile state: those operations are not one transaction.
An invitation can create an Auth identity before profile insertion fails;
the link remains withheld and the error reports a recovery Auth UUID where
available. No automatic account deletion or reassignment is performed.

For an existing verified Auth identity, use `mode: "associate"` with its explicit
`authUserId` and matching email. The tool checks email confirmation and refuses
cross-clinic membership. It returns no invitation and never resets a password.
Do not reinvite an already accepted/verified account.

## Local validation

```bash
npm run test:clinic-user-cli
npm run test:invite-setup
npm run test:clinic-users
npm run test:auth
npm run test:security
```

Tests use local transport fixtures and local PostgreSQL. Live invitation/link
acceptance and actual production grants remain manual acceptance checks. No
migration, deployment or live provisioning was performed during preparation.
