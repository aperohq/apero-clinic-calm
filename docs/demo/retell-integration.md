# Private Apero voice demo

Release preparation does not deploy, apply migrations, enable calls, create
bookings, or change the live agent. GitHub review and production publication
are separate steps; every production action requires explicit approval.

## Scope and architecture

`/voice-demo` retains Lovable's page, classes, shader palette and layout. `/demo`
uses the same DemoAccess gate and redirects to `/voice-demo`. Both fail closed
until Supabase session/profile checks and the new Edge access check succeed.
The demo is absent from dashboard navigation and sends noindex metadata.

The root AuthProvider supplies the session and current database profile. The
frontend requires the configured Dental Zone reference, non-revoked Owner role,
matching session user, no account errors and no password recovery. It is only a
presentation gate. The Edge handler verifies the bearer through Auth getUser,
reads the matching profile under the user's JWT/RLS, then reads the private
integration with service-role credentials. Every create/stop/recovery request repeats
these checks. The database RPC also rechecks Owner membership.

The browser dynamically imports pinned `retell-client-js-sdk@3.0.3`. Its
RetellClient.createWebCall uses the supported custom-fetch API to send only
`operation` and a generated request UUID to the Edge Function. SDK request
headers/bodies are never forwarded. There is no generic provider proxy, agent
override, live transcript connection, or private Retell key in the browser.
Only the SDK's create and stop REST paths are accepted by the custom fetch.
WebRTC signaling/media connect directly to Retell using a short-lived call token.

The server exclusively selects agent `agent_b84b2766efeb85afc809147d7a`, version
16 and conversation flow `conversation_flow_43f53e5e8531`, version 16. The published
version was confirmed through a read-only Retell lookup during preflight. Each
creation verifies that exact version is still published. No latest/draft fallback.
No agent overrides or dynamic variables alter the booking flow. The configured
agent retains Arabic/English, clinic questions and its existing booking tools.

Read-only Supabase MCP verification on 2026-11-01 confirmed Dental Zone clinic
`11111111-1111-4111-8111-111111111111`, its active integration, and one non-revoked
Owner linked to a confirmed, unbanned Auth account. Production authorization,
booking RPCs and privileges support this implementation, and neither demo
migration is applied. The intended presenter must still sign in normally;
metadata verification is not a browser/media or end-to-end booking test.
No local-only changes from the original dirty checkout were copied or required.

## Session and failure behavior

An additive, unapplied migration creates private `demo_call_sessions` and one
service-role-only RPC. Browser roles have neither table access nor RPC access.
An advisory transaction lock and unique partial index enforce one outstanding
call per clinic across Owners, tabs and Edge instances. At most six reservations
per clinic/hour are allowed. Failed attempts count. Cancellations before creation
leave a tombstone so a delayed creation cannot resurrect the call. Only the
creating authenticated Owner can stop their call. Explicitly enrolled recovery
operators must also be active Dental Zone Owners; they can reconcile a session
only after the server verifies a matching terminal Retell call.

The row is reserved before provider creation and the call ID attached before the
connection token is returned. Stop looks up that ID server-side; callers cannot
supply a provider call ID. Locks are released only on provider-confirmed terminal
status, or an explicit creation rejection before a call was created. No timer
expires a possibly active call. Network timeouts, malformed provider responses,
or failed attachment can require operator reconciliation and block new calls.

Unmount, End Call, pagehide, SDK failure and SDK end all disconnect local audio
and attempt authenticated server cleanup. Pending request IDs (not tokens) are
stored per user in sessionStorage for cleanup after reload. The Retry cleanup
control retries unresolved cleanup. Browser crashes, offline unload, logout or
revoked membership can prevent server cleanup; do not claim guaranteed remote
termination. Use the authenticated operator recovery operation documented in
[recovery.md](recovery.md). It verifies agent, version, web-call type, metadata
and terminal status, and atomically releases the lock with an audit entry. It
never stops candidate calls and never clears an unresolved lock on elapsed time
alone. Do not manually change ended flags or stop arbitrary telephone calls.

SDK audio snapshots measure the remote agent track. RMS drives a smoothed shader
uniform. Ready, Connecting, Active, Muted, Ended and Error reflect lifecycle state;
there are no simulated speaking timers or precise Speaking/Listening claims.
Reduced motion freezes the shader. Muting affects only the microphone. Enable
speaker audio offers a user-gesture playback retry if autoplay was blocked.

## Configuration (do not enable before live verification)

Existing frontend public configuration:

- VITE_SUPABASE_URL
- VITE_SUPABASE_PUBLISHABLE_KEY

Edge runtime configuration:

- SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (runtime project credentials)
- APERO_PORTAL_ORIGIN: exact authorized origin, with no trailing slash/path
- APERO_DEMO_CLINIC_ID: verified Dental Zone clinic UUID, matching the repository reference
- APERO_DEMO_AGENT_VERSION: `16`
- APERO_DEMO_ENABLED: must be `true` for NEW call creation only. Absent/false
  blocks creation; authenticated access verification, owned cleanup and privileged
  operator recovery remain available with the other required configuration intact.
- The private key named by active voice_integrations.secret_env_name, currently
  expected to be RETELL_API_KEY. Never use a VITE_ variable for this key.

Supabase MCP authentication succeeded during the final production review. This
does not establish that the separate CLI management token or deployment channel
is authenticated. Secret existence and runtime demo configuration were not
verifiable through the available MCP metadata tools. No private secret values
have been written in this implementation or instructions.

## Required approval-gated deployment sequence

1. Confirm the intended presenter through normal sign-in and check private secret
   existence/runtime configuration without exposing values. Authenticate the
   selected deployment channel separately. The production clinic, Owner structure,
   active integration, agent/flow, booking RPCs and deployed handlers passed
   read-only verification on 2026-11-01; recheck if production changes before
   deployment. This implementation does not deploy or repair existing booking
   components.
2. Review and explicitly approve applying ONLY
   `supabase/migrations/20261031120000_demo_call_sessions.sql`, followed by
   `supabase/migrations/20261101120000_demo_call_recovery.sql`. Do not run a blanket
   migration push: older pending migrations are outside this task. Check grants,
   table/RPC permissions, and the unique index after application. Operator
   enrollment is a separate explicit database-administrator action; see recovery.md.
3. Configure secrets and exact allowed origin with demo disabled. Explicitly
   approve deployment of ONLY `demo-call` (its local config disables gateway JWT
   validation because the handler independently verifies Auth getUser).
4. Explicitly approve publishing the isolated frontend build through the existing
   hosting workflow. Git synchronization alone is not a Lovable publish.
5. While creation remains disabled, check unauthenticated, foreign clinic, revoked,
   Staff and Manager denials; confirm the Dental Zone Owner can access BOTH routes.
   Verify operator enrollment privately. These access probes must not create calls.
   Then explicitly approve enabling NEW calls.
6. Obtain separate explicit approval for the first real browser call.

## First controlled browser test (requires explicit approval)

Use the actual HTTPS presentation origin, a verified Dental Zone Owner, and the
meeting laptop/browser. Open `/demo`, allow microphone access, Start Conversation,
and ask clinic questions in Arabic and English. Do NOT request a booking in this
first audio test. Verify remote audio, audio-reactive orb, microphone mute/unmute,
playback retry, End Call, repeated Start clicks, navigation during connection,
page exit, and cleanup/reconnection. Verify provider termination and that no
appointment was created. Calls may be recorded under existing agent settings.

Booking testing needs a separate explicit approval and clinic-coordinated future
slot/test identity/test phone number, with normal cancellation afterwards. Demo
metadata does not isolate schedules. Booking uses the existing real tool path;
confirmed appointments are expected to appear in the same clinic's dashboard,
subject to live backend compatibility. No end-to-end audio or booking success
has been verified by local tests.

## Local verification

- npm run test:demo: mocked HTTP/provider/SDK transports plus real disposable
  PostgreSQL (PGlite) execution of the new migration and session RPC.
- npx tsc --noEmit: app type check (run after build generates the new route).
- Edge handler: standalone TypeScript check with ES2022/DOM libraries.
- Targeted ESLint for all new/changed TypeScript sources.
- npm run build: client/server compilation, no deployment.

Tests do not validate real browser media, hosted auth, provider compatibility at
runtime, production booking or native PostgreSQL concurrency under load. The
provider package/source was checked against official documentation:
https://github.com/RetellAI/retell-client-js-sdk
https://docs.retellai.com/api-references/create-web-call
https://docs.retellai.com/api-references/stop-call
