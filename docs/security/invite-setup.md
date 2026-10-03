# Invited user password setup

The portal provides `/account/setup` as an independent route, outside the
protected `/account` layout. It waits for the existing browser Supabase client
and Auth provider to initialize the invitation session before showing a form
or invalid/expired invitation state.

The form requires matching passwords of at least eight characters, including
an uppercase letter and a number. It calls the existing authenticated
`supabase.auth.updateUser({ password })` capability and then navigates to
`/home`. It never writes clinic membership, profiles, roles, or RLS policies.
Sessionless visitors receive an invalid/expired state with a link to sign in.
Normal `/account` and login behavior remain unchanged.

## Operator/backend prerequisite

The private operator provisioning tool must use Admin `generateLink` with
`type: "invite"` and a redirect to the configured portal origin plus
`/account/setup`. Deliver the returned `properties.action_link` verbatim;
never reconstruct verification links or remove query parameters. This frontend
commit does not deploy or change the private operator provisioning tool.

In Supabase Authentication → URL Configuration → Redirect URLs, add:

```text
https://aperodashboard.lovable.app/account/setup
```

Retain existing redirect entries. Release the updated portal using the normal
Lovable workflow before testing a fresh approved invitation in a private
browser. Verify confirmation mismatch rejection, successful password setup,
correct existing clinic workspace, refresh, logout, and normal password login.
If the user already accepted an older link, do not assume a new invite can be
issued for that verified identity; use a new approved/unaccepted test user.

### A correct invitation link still opens the login page

An Admin-generated action link can contain the correct `redirect_to` even if
that URL is not allowed in the project's Auth redirect configuration. Supabase
can then fall back to the configured Site URL. Check the exact setup URL in
Redirect URLs before changing the provisioning code or frontend guards.
Also verify the published portal contains the setup route. Do not paste the
action link or callback tokens into logs, screenshots, or support messages.

The saved action link is a verification request, not the resulting browser
callback. It cannot establish whether the hosted callback contained session
tokens, a code, or an error. The current browser client uses Supabase's default
implicit flow and waits for SDK initialization. Local regressions exercise
invite session tokens in the URL fragment and expired-invite error fragments
against the production route tree.

Opening an invitation can consume its token even when the final destination
is wrong. Do not assume the original link can be reused. If the invited user
has a valid session, they can open `/account/setup` directly. Otherwise check
their Auth confirmation state privately before issuing another link or
choosing a fresh approved test identity; do not change their clinic profile.

## Local regression tests

```bash
npm run test:invite-setup
npm run build
```

The tests use the real browser Supabase SDK with local HTTP fixtures and a
simulated browser. They cover asynchronous invite session initialization,
password validation/update, expired callbacks, existing workspace association,
and normal account/login routing. No production call or email is made.
