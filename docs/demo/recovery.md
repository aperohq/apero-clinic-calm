# Demo disablement and recovery

These instructions describe approval-gated production actions. No migration,
enrollment, deployment, live call, termination, or database reconciliation was
performed during development. All development provider/HTTP responses are mocks.

## Disable switch

`APERO_DEMO_ENABLED=false` (or absent) blocks only new `create` operations. It does
not bypass authentication, membership, origin, configuration or ownership checks.
Authenticated `access`, owned `stop`, and privileged `recover` still work. Keep
runtime credentials, the verified clinic/version, integration mapping and Retell
key intact so cleanup remains possible. Do not delete shared secrets to disable
the demo. Already-started creation requests may still finish; identify and clean
those sessions normally. Before rollback, disable new creation and reconcile all
outstanding sessions, then roll back the frontend. Retain private audit records.

## Database setup (separate approval required)

After production identity/schema verification, review and apply ONLY these files,
in order, if not already installed:

1. `supabase/migrations/20261031120000_demo_call_sessions.sql`
2. `supabase/migrations/20261101120000_demo_call_recovery.sql`

The second migration is additive. It creates private `demo_recovery_operators`,
append-only `demo_call_recovery_audit`, and service-role-only `demo_recover_session`.
It does not change the original session RPC, booking tables, tools or dashboard.
No operator is seeded, and there is no self-enrollment endpoint. Browser roles
cannot read/write enrollment/audit tables or call either privileged session RPC.
The Edge function's own service role can read the tables but cannot enroll an
operator or rewrite/delete audit records; audit writes go through the definer RPC.

A database administrator must verify the intended operator's Auth user UUID and
active Dental Zone Owner profile, then explicitly approve enrollment. Example,
with BOTH placeholders replaced by the verified values (never infer identity
from email/user metadata):

```sql
INSERT INTO public.demo_recovery_operators(auth_user_id, clinic_id)
SELECT auth_user_id, clinic_id
FROM public.profiles
WHERE auth_user_id = '<VERIFIED_OPERATOR_AUTH_UUID>'::uuid
  AND clinic_id = '<VERIFIED_DENTAL_ZONE_UUID>'::uuid
  AND role = 'owner' AND revoked_at IS NULL
ON CONFLICT (auth_user_id, clinic_id) DO UPDATE SET active = true;
```

Expect exactly one affected row. Enrollment alone is insufficient: the Edge
handler and RPC recheck current non-revoked Owner membership on each recovery
step. Disabling enrollment or revoking/demoting the Owner denies recovery.
Keep the allowlist small and remove enrollment after it is no longer needed,
through a separately approved administrator action.

## Presenter cleanup for a known call

1. End Call disconnects local microphone/speaker media and sends an authenticated
   owned `stop` operation. It remains available when creation is disabled.
2. Before any Stop Call request, the server retrieves the exact saved call ID and
   verifies `call_id`, agent ID, approved version 16, `call_type=web_call`, and
   metadata `source=apero_private_demo` plus the exact `demo_session_id`.
3. A matching ended/error call releases its lock without another termination.
   A matching registered/ongoing call may be stopped; the server then retrieves
   it again. A successful stop response alone never releases the lock.
4. If Retell is unavailable, identity/metadata differ, status is unrecognized,
   or the call is still active, retain the lock and use Retry cleanup. A successful
   retry clears the old warning and pending ID, and returns the UI to Ready.
5. Browser unload/crash/offline/logout can prevent cleanup. A session ID, never
   a credential, is retained per user/tab for retry after reload when possible.
   If browser state is lost or the creating Owner is revoked, use operator recovery.

## Privileged reconciliation endpoint

Use an approved operator tool with an ordinary, current Supabase user access
token obtained through normal sign-in. Never use, copy into a browser, or expose a
service-role key. Do not paste access tokens in chat, tickets or command logs.
The request must originate from the configured portal origin (browser sets Origin;
a non-browser approved operator client must send that exact header explicitly).

```
POST https://<PROJECT_REF>.supabase.co/functions/v1/demo-call
Origin: <EXACT_APERO_PORTAL_ORIGIN>
Authorization: Bearer <OPERATOR_USER_ACCESS_TOKEN>
apikey: <PUBLIC_PROJECT_PUBLISHABLE_KEY>
Content-Type: application/json

{"operation":"recover","requestId":"<EXACT_DEMO_SESSION_UUID>"}
```

Do not call the underlying privileged RPC directly from the browser. The Edge
handler authenticates the user and checks clinic Owner membership. The database
RPC additionally checks explicit operator enrollment before provider inspection.
The request cannot select an agent, version, user, clinic, force-release flag,
provider status or generic URL. Operator recovery NEVER sends a Stop Call request.

## Unknown creation outcome: exact procedure

1. Disable NEW creation, keep cleanup credentials/configuration intact, and obtain
   the exact locked request UUID from the pending presenter session or an
   authorized read-only `demo_call_sessions` inspection. Do not clear the lock.
2. As an enrolled active Owner, send `recover` with that UUID. If its call ID is
   saved, the server uses that value and refuses conflicting candidate IDs.
3. If response is `409 operator_intervention_required`, the call ID is unknown.
   An authorized operator must privately inspect Retell call history for the
   configured Dental Zone agent and metadata `demo_session_id=<REQUEST_UUID>`
   with `source=apero_private_demo`. Use timestamps only to narrow the search,
   never as proof of call termination or ownership. Do not export transcripts,
   patient data, access tokens or recordings.
4. If a unique matching call is found, repeat the endpoint request with:

   ```json
   {
     "operation": "recover",
     "requestId": "<EXACT_DEMO_SESSION_UUID>",
     "candidateCallId": "<MATCHING_RETELL_CALL_ID>"
   }
   ```

5. The server independently fetches that call. It releases the lock ONLY if all
   identifiers, version, call type, metadata and terminal status match. Binding
   the previously unknown call ID, marking the session ended, and recording the
   operator/time/provider status are one database transaction. An audit failure
   rolls the release back. No provider payload or private key is returned.
6. `409 provider_active` means the call is registered/ongoing. It is NOT released
   or terminated by recovery. Have the creating authorized presenter retry owned
   cleanup if possible. Otherwise obtain explicit approval for an authorized
   Retell operator to terminate ONLY the independently identified demo call in
   Retell, then retry recovery and let the server confirm terminal status.
7. `409 provider_identity_mismatch`, `candidate_conflict` or `provider_status_unknown`
   means stop and investigate. `503 provider_unavailable` includes 404, expired
   provider access, timeouts and unreadable responses. A missing/deleted call is
   NOT proof that creation never happened. Keep the lock and obtain provider
   support/verified call evidence. No force-release, empty search, expiry timer
   or broad SQL UPDATE is an approved recovery mechanism.
8. If a call cannot be uniquely identified, or evidence remains unavailable,
   retain the lock and report manual intervention is required. Do not try another
   call or delete session rows to get past the lock. Multiple matching provider
   calls require investigation; do not choose an arbitrary candidate.
9. On `{ "recovered": true }`, review the private audit and session row. The
   original presenter can then Retry cleanup (even while creation is disabled)
   to clear their local pending state. Enable new creation only after approval.

Read-only operator verification, with the exact UUID substituted:

```sql
SELECT request_id, call_id, cancel_requested, ended, created_at
FROM public.demo_call_sessions
WHERE request_id = '<EXACT_DEMO_SESSION_UUID>'::uuid;

SELECT created_at, actor_user_id, request_id, provider_call_id,
       provider_status, outcome
FROM public.demo_call_recovery_audit
WHERE request_id = '<EXACT_DEMO_SESSION_UUID>'::uuid
ORDER BY id;
```

Audit attempts are persisted before provider inspection. Failures/active states
are recorded without releasing a lock; successful release and its `recovered`
event are atomic. Only configuration/identifier/status fields are recorded, no
patient content, provider error bodies or credentials. Database administrators
remain trusted; these are application-level append-only records, not an external
tamper-proof ledger. An interrupted attempt can leave a `requested` event without
a final outcome; retry the endpoint, never infer success from that event.

## Verification limits

Local tests use disposable PostgreSQL (PGlite), mocked Retell HTTP/SDK responses,
and synthetic operators. They cover disabled creation with authorized cleanup,
termination failure/retry, identity mismatch, ambiguous outcomes, active-call
retention, operator denials, atomic audit rollback and UI warning reset. Read-only production review on 2026-11-01 confirmed the clinic, Owner membership
structure, booking privileges and absence of demo object conflicts. Secret/runtime
configuration, the intended operator's normal sign-in, post-migration grants,
provider metadata during real calls, media and deployment still require approved
verification. No real calls or bookings were used in these tests.
