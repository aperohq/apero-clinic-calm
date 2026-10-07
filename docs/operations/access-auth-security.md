# Access controls and secure authentication — Dental Zone production

Verified 2026-10-07 against Supabase project `svoybvzvmygszklcmudh` and
`https://aperodashboard.lovable.app`. Source baseline: main `0500926`.
Scope: authentication, authorization, clinic isolation, credential exposure,
and their hosted acceptance only. No paid calls or real patient content were
used. No unrelated product controls were changed.

**ACCESS CONTROLS: not COMPLETE. SECURE AUTHENTICATION: not COMPLETE.**
Authorization enforcement passed the tested attacks, but the launch gates below
remain. The password-policy issue was reproduced; its deployment was denied.

## Launch gates and actual changes

1. **FAIL — server password minimum.** Apero requires eight characters in its
   password UI, but production Auth accepts six. A synthetic user's direct
   authenticated `PUT /auth/v1/user` accepted a six-character password (200).
   The narrow proposed fix is `PATCH /config/auth` with only
   `{"password_min_length":8}`. The available Management credential returned
   **403**; no configuration was changed. The user explicitly requested that
   this remain an unresolved launch blocker. After an authorized administrator
   applies it, retest seven-character rejection, strong-password acceptance,
   and recovery with the deployed policy. Existing passwords should not be
   forcibly reset as part of this change. Composition checks in the UI are
   presentation rules; the server currently has no required character groups.
2. **FAIL — reliable invitation/recovery email delivery acceptance.** Custom
   SMTP is absent. A hosted Owner invitation returned safe
   `invite_email_failed` (502), although the correct clinic-scoped pending
   Staff membership was created. Recovery requests for a synthetic support
   alias and a nonexistent address both returned 200; this establishes mail-API
   acceptance, not inbox delivery. Configure a production mail transport and
   verify delivery/acceptance for disposable recipients before clinic launch.
   Supabase's default mailer restricts recipients to organization members and
   has a low quota; it is not a production mail service. Do not raise limits or
   invent SMTP credentials to bypass acceptance.
3. **NOT VERIFIED — successful hosted provider-recording playback.** No existing
   conversation with provider IDs was explicitly marked synthetic/test/simulation.
   No real patient recording was accessed and no call was made to create one.
   Denial paths passed; successful signed playback and expiry still need an
   identified safe existing recording, or separately authorized synthetic data.
4. **PENDING — four closed synthetic Requests and their four clinics.** All
   synthetic Auth users, profiles, patients, practitioners, calls, appointments,
   notifications, and browser/invitation fixtures were removed. Requests have
   no API DELETE grant, and the supplied SQL connection is
   `supabase_read_only_user`. The user agreed to execute the exact guarded
   [cleanup SQL](access-auth-synthetic-cleanup.sql). It was provided, but its
   completion has not yet been observed. Verify zero remaining exact clinic IDs
   afterward. Do not change grants or run an unrelated deletion worker to
   perform cleanup.

Only this report, sanitized evidence, and scoped synthetic cleanup SQL were
added. No application/RLS/Edge code was changed. No successful deployment
occurred in this audit. The password setting remains six after the denied PATCH.

## Authentication architecture

The published bundle uses the same Supabase Auth calls as the reviewed source:
`signInWithPassword`, `resetPasswordForEmail`, `updateUser`, and local-scope
`signOut`. Passwords necessarily enter transient browser input/React state and
are passed directly to Supabase's SDK over HTTPS. Apero does not persist them,
hash/store them in its tables, or send them to an Apero password backend. Thus
"never handled by application code" cannot literally describe a password form;
the verified boundary is transient browser handling and Supabase-only password
storage/verification. Public password change targets the authenticated subject,
not an arbitrary user ID.

The browser uses the intended Supabase publishable/public key. Supabase sessions
persist in localStorage under `sb-svoybvzvmygszklcmudh-auth-token`, with automatic
refresh enabled. Current Auth access-token lifetime is 3,600 seconds. This is a
browser-readable bearer session, not an HttpOnly cookie. XSS and untrusted code
on the application origin therefore matter; no auth redesign was made.

On recognized framed Lovable previews only, the storage adapter brokers session
storage through `postMessage` to validated editor origins, with localStorage
fallback. Production standalone hosting uses localStorage. Password-recovery
state uses the sessionStorage flag `apero-password-recovery`; it is a UI flag,
not a database authority. Altering it cannot change the JWT subject or clinic.

Initial route rendering waits for Auth and a complete matching profile/clinic.
The protected shell redirects anonymous users to login, blocks inaccessible
membership, and shows generic retry/logout states on failed reads. Cached query
data is cleared on account, clinic, role changes and logout. Membership refresh
runs on focus and every 30 seconds; backend authorization does not wait for this
UI refresh. Published Chromium acceptance covered redirect, invalid login,
persistence, logout, role controls, recovery, revocation and invalid stored JWT.
Local tests also exercise delayed-profile races and sensitive-content gating.

Logout calls Supabase with scope `local`, removes this device's stored session,
clears application data and returns to login. Hosted refresh after logout was
rejected (400). A copied, already-issued access JWT still read authorized data
until expiry (observed 200); logout is not immediate invalidation of every bearer
JWT. Other device sessions are outside this local logout scope. Membership
revocation, separately, immediately blocks clinic access through RLS.

Malformed and expired/tampered tokens returned hosted 401. A restored invalid
JWT in the published browser showed the generic account-load failure, with no
workspace rendered, and still permitted logout. A genuinely signed token was
not held for an hour to observe expiration; actual expiry behavior is covered
by SDK/local verification rather than claimed as a hosted elapsed-time test.

## Clinic isolation and role model

The authority chain is:

`verified JWT subject → auth.uid() → unique profiles.auth_user_id → active
profiles.clinic_id / role → current_clinic_id/current_profile_id/current_profile_role
→ RLS, restricted column grants and guarded RPCs → rows`.

The three membership helpers are trusted SECURITY DEFINER functions with fixed
search paths and `revoked_at is null` predicates. The unique Auth-user index is
present. Neither frontend filters, URL IDs, localStorage clinic values nor
editable Auth user metadata establish clinic access. `anon` and `authenticated`
are neither superusers nor BYPASSRLS roles. Service role intentionally bypasses
RLS and remains a server authority with explicit restricted object privileges.

| Capability | Owner | Admin / Manager | Staff / Receptionist |
| --- | --- | --- | --- |
| Own-clinic calls/transcripts, patients, appointments | Yes | Yes | Yes |
| Create/update appointments, including cancellation | Yes | Yes | Yes |
| Delete appointments | Yes | Yes | No |
| Create patients | Yes | Yes | No |
| Update existing patient operational details | Yes | Yes | Yes |
| Practitioner/schedule management | Yes | Yes | No |
| Requests read/status management | Yes | Yes | No |
| Analytics RPC | Yes | Yes | No |
| Portal account directory | Yes | Read | No |
| Invite, change Manager/Staff roles, revoke membership | Yes | No | No |
| Important clinic settings | Yes | No | No |
| Direct integration-secret/configuration table access | No | No | No |
| Reserved integration/billing/ownership UI sections | Owner gate; current implemented actions only | No | No |
| Create/promote/demote/remove Owner through portal APIs | No | No | No |

This is the actual intended permission map, including Staff restrictions on
Requests and new-patient creation. "Full operational access" does not imply
direct provider credentials or bypassing data-integrity/deletion guards.
Privileged integration operations currently remain server/operator work; hidden
controls were not treated as an authorization boundary.

Profile UPDATE grants allow only own `full_name` and `phone`. Role, clinic,
Auth-user identity and revocation fields cannot be directly updated. Guarded
role/revocation RPCs recheck a live Owner and scope/lock the target. Owner and
self mutation are rejected; only Manager↔Staff changes are accepted. Multiple
Owners can exist through trusted provisioning: two synthetic Owners coexisted,
and neither could remove/demote the other through portal APIs. Every Owner is
protected, rather than merely the last Owner. Arbitrary trusted database/Auth
administrators can still bypass this model; no new ownership system was added.

Invitation Edge validates Auth with `getUser`, checks live Owner membership,
uses strict input schemas, and rechecks scope through server-only database
invitation functions. A foreign clinic could not claim the same invited email,
resend a foreign profile, invite an existing confirmed foreign account, or move
the accepted member. A synthetic invitation token accepted the intended user;
its session could not read Clinic B or edit its membership clinic. This token
was generated through Admin `generate_link` after the mail step failed: it
verifies token/membership semantics, not delivery of the original emailed link.

## RLS coverage

All **25 public tables** have RLS enabled. The following lists each effective
browser command; **deny** means no browser grant/policy combination permits it.
Every permitted clinic command checks the current live membership. The exact
policy expressions and table-wide grants are in the evidence JSON; column
grants below are essential where table-wide privilege checks return false.

| Table | SELECT | INSERT | UPDATE | DELETE | Additional boundary |
| --- | --- | --- | --- | --- | --- |
| clinics | Own clinic | Deny | Owner, selected settings columns | Deny | Settings RPC rechecks Owner |
| profiles | Self; Owner/Manager clinic directory | Deny | Self name/phone | Deny | Identity/role/clinic guards; revoked membership excluded |
| clients | Own clinic | Owner/Manager | Own clinic | Owner/Manager plus existing erasure guard | Clinic-scoped patient references |
| appointments | Own clinic | Own clinic | Own clinic | Owner/Manager | Same-clinic patient/practitioner; immutable clinic |
| conversations | Own clinic, allowed columns | Deny | Deny | Deny | recording_url SELECT denied; immutable server ownership |
| client_notes | Own clinic | Own clinic and own author | Deny | Owner/Manager | Immutable clinic/client/author |
| staff | Own clinic | Owner/Manager | Owner/Manager | Owner/Manager | Same-clinic reference guards |
| staff_availability | Own clinic | Owner/Manager | Owner/Manager | Owner/Manager | Same-clinic practitioner |
| staff_time_off | Own clinic | Owner/Manager | Owner/Manager | Owner/Manager | Same-clinic practitioner |
| notifications | Owner clinic notices or own notices | Owner | Authorized notice, read column only | Owner | Clinic/profile ownership enforced |
| voice_requests | Owner/Manager own clinic | Deny | Owner/Manager status column only | Deny | Closed-at handled server-side |
| voice_integrations | Deny | Deny | Deny | Deny | Server/operator only |
| clinic_service_aliases | Deny | Deny | Deny | Deny | Server only |
| voice_operations | Deny | Deny | Deny | Deny | Server only |
| voice_call_state | Deny | Deny | Deny | Deny | Includes transfer/escalation state; server only |
| voice_checked_slots | Deny | Deny | Deny | Deny | Server only |
| clinic_invitation_claims | Deny | Deny | Deny | Deny | Restricted invitation RPCs only |
| clinic_invitation_budgets | Deny | Deny | Deny | Deny | Restricted invitation RPCs only |
| retention_client_activity | Deny | Deny | Deny | Deny | Server only; authorization inventory only |
| retention_deletion_ledger | Deny | Deny | Deny | Deny | Server/operator only |
| retention_control | Deny | Deny | Deny | Deny | Server/operator only |
| clinic_retention | Deny | Deny | Deny | Deny | Server/operator only |
| retention_runs | Deny | Deny | Deny | Deny | Server/operator only |
| retention_provider_jobs | Deny | Deny | Deny | Deny | Server/operator only |
| clinic_offboarding | Deny | Deny | Deny | Deny | Server/operator only |

`retention_candidates`, the additional public view, has no browser SELECT grant.
No additional recording-access table exists: recordings authorize against
conversations and the server-only integration mapping. Analytics uses the
invoker RPC over clinic-scoped calls/appointments/staff and rejects Staff or
foreign-clinic arguments. No browser-accessible cross-clinic RLS gap was found.
This audit inspected the newer state tables' access only; it did not operate or
modify their product lifecycles.

## Revocation, recovery and recording acceptance

The exact hosted revocation scenario passed: Staff logged in, read its Clinic A
patient/call and updated its appointment; Owner revoked that profile; the same
retained access token still passed Auth identity validation (200), but seven
clinic table reads returned no rows, appointment INSERT returned 403, UPDATE
affected no row, and recording access returned 403. The published browser also
lost its workspace on membership refresh. Revocation therefore does not wait
for JWT expiry, and a later token refresh cannot restore revoked membership.

Production recovery redirects are explicitly allowlisted to the application
`/reset-password`, `/account`, and `/account/setup`; the site URL is the published
dashboard. The recovery token was single-use, belonged to the intended subject,
and could not modify another Auth user or foreign profile. Password change
succeeded, the old password failed, and the new password logged in. Old Auth
identity access returned 403 and its refresh token returned 400 after the change.
The published browser followed an actual generated recovery verification link,
rendered the reset UI, changed the password, and returned to Home. An invalid
recovery link showed a safe request-new-link state. No real clinic staff were
emailed; the mail request used a disposable Apero support alias.

`recording-access` version 2 validates the bearer with Auth, reads live membership
and an RLS-scoped conversation, resolves provider credentials only server-side,
checks provider call/agent identity and signed HTTPS URL requirements, then
rechecks RLS before issuing access. Responses are no-store and expose only the
authorized signed URL. Hosted unsigned/invalid-token requests returned 401;
substituting Clinic B's conversation ID returned 404; revoked Staff returned
403. A own-clinic synthetic conversation without a provider recording safely
returned 404. Direct SELECT of `conversations.recording_url` returned 403.

Successful fresh signed URL issuance for Owner/Manager/Staff, provider mismatch,
unsigned URLs, and revocation during lookup passed local handler tests with
mocked provider responses. They are **not** proof of the remaining hosted
provider-success/expiry path. An already-issued signed URL is a bearer capability
until its provider expiry; logout/revocation prevents new issuance, not recall
of a copied URL. No recording URLs or provider responses are in this evidence.

## Credentials and safe logging

Server-only Supabase service credentials live in Edge/server environment, with
session persistence disabled in admin clients. Retell secrets are resolved by
the integration's environment-variable name, never a browser value. All files
in deployed `recording-access` v2, `manage-clinic-users` v2 and
`provision-clinic-user` v5 match main source (normalized line endings only).
Their disabled platform JWT verification is paired with explicit independent
authentication; it is not an anonymous administration bypass.

The scan inspected **624 reachable Git blobs**, including historical objects,
and **54 published HTML/JS assets**, including the complete discovered script
dependency map. It checked current privileged credential matches, service-role
JWT payloads, and modern Supabase secret-key patterns without printing values.
No real privileged credential exposure was found. Four matches were the same
literal non-working `DO_NOT_LOG_THIS_VALUE` fixture or documentation describing
it. Public project URL/publishable credentials are expected. This is a bounded
repository/asset scan, not a claim to have scanned external logs or every old
provider credential. No rotation was performed.

Deployed authentication/authorization handlers use the established allowlist
logger. It records category, safe generated identifiers, status and approved
dependency fields, discarding raw errors/bodies/headers. Portal error capture
also strips error text, stacks and raw context before forwarding telemetry.
Passwords, JWTs, refresh tokens, headers, API keys, transcripts, playback URLs,
session objects and full sensitive payloads are not passed to application logs.
No monitoring redesign or real patient log export was performed.

## Explicit test matrix

PASS below means the stated hosted behavior was observed, not merely inferred
from hidden controls. NOT VERIFIED is a failed acceptance gate, not a passed
control. Zero-row 200 responses are expected RLS denial for SELECT/UPDATE/DELETE.

| Test | Result | Evidence |
| --- | --- | --- |
| Valid login | PASS | Five synthetic identities; published browser |
| Invalid login | PASS | Auth 400; safe browser error |
| Logout | PASS | Browser storage cleared/login redirect; refresh 400 |
| Invalid/expired session | PASS for malformed/expired-tampered JWT; genuine elapsed expiry NOT VERIFIED hosted | REST 401; invalid stored JWT blocked; local expiry coverage |
| Reset-password flow and own-user change | PASS | Token/API and real hosted Chromium navigation |
| Production recovery/invitation delivery | FAIL acceptance | Invitation 502; recovery API 200 is not delivery evidence |
| Server password policy | FAIL | Six-character direct change accepted; fix PATCH 403 |
| Unauthenticated protected access | PASS | Hosted RLS/Edge denial and browser redirect |
| Cross-clinic SELECT | PASS | Clinic/profile/patient/staff/appointment/request/notice/call/transcript reads denied |
| Cross-clinic INSERT | PASS | Seven operational/account tables denied |
| Cross-clinic UPDATE | PASS | Seven tables: forbidden or no rows affected |
| Cross-clinic DELETE | PASS | Seven tables: forbidden or no rows affected |
| Recording access denial | PASS | Anonymous 401, wrong clinic 404, revoked 403, legacy column 403 |
| Recording provider success/expiry | NOT VERIFIED hosted | Safe provider fixture unavailable; local handler success passed |
| Owner allowed actions | PASS | Settings, analytics, practitioner management, role changes, revocation; own-clinic Staff invitation membership |
| Manager allowed/restricted actions | PASS | Operations/analytics/directory allowed; account mutation/settings denied |
| Staff allowed/restricted actions | PASS | Operations allowed; Requests/analytics/account management/settings denied |
| Self-promotion and profile-field manipulation | PASS | RPC/role/clinic/Auth ID/revoked-at updates denied |
| Cross-clinic user management | PASS | Role/revoke/resend/invite takeover denied |
| Invitation acceptance intended clinic | PASS | Correct token subject; foreign reads/membership move denied |
| Owner protection/multiple Owners | PASS | Self/another Owner removal/demotion/promotion denied |
| Revoked user with existing session | PASS | Hosted retained JWT denial and browser workspace block |
| Frontend bundle inspection | PASS | 54 published assets; no privileged secret found |
| Repository/history scan | PASS | 624 blobs; controlled fixture matches only |
| Synthetic cleanup | PENDING operator step | Zero test Auth users; four closed Requests/four clinics remain |

The final API matrix has **148/149** passing assertions; the remaining assertion
is cleanup. The published browser has **22/22** passes. Invitation follow-up has
**14/15** passes; mail-send acceptance fails. Password-policy reproduction and
fixture cleanup passed, but the security control remains FAIL after denied
deployment. See [sanitized evidence](access-auth-security-evidence.json) for
individual names, HTTP statuses, timestamps, RLS expressions and source hashes.

Local Auth, permissions, provisioning, recording handler/player, Team/invitation,
isolation and invitation-setup suites were used for supporting validation.
They do not replace the hosted results or clear the listed launch gates.

## Next acceptance steps

1. Run the provided exact synthetic cleanup SQL and verify zero remaining IDs.
2. Have an authorized administrator apply the eight-character Auth minimum when
   the user elects to resolve that blocker; rerun direct and recovery policy tests.
3. Configure production SMTP and verify disposable invitation/recovery delivery.
4. Identify a safe existing signed recording and verify correct-clinic playback,
   wrong-clinic denial and expiry without making a paid call.

No COMPLETE status is justified until these applicable gates pass. The selected
scope has no successful runtime deployment to report; documentation/evidence
is the only Git change in this audit.

References: [Supabase Auth configuration API](https://supabase.com/docs/reference/api/v1-update-auth-service-config),
[password security](https://supabase.com/docs/guides/auth/password-security),
[default/custom SMTP limits](https://supabase.com/docs/guides/auth/auth-smtp).
