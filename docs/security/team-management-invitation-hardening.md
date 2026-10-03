# APERO Team invitation hardening

2026-10-03 — **SAFE TO DEPLOY**, subject to the coordinated production steps
below and hosted acceptance. Built and verified locally only. Nothing deployed,
pushed or changed in production; no paid call or external service was introduced.

## 1. Invitation race root cause

The old email-availability check committed before Supabase Auth generation.
Two clinics could pass that check, then one could establish membership while
the other's generation rotated the pending Auth token. Profile uniqueness
prevented reassignment, but the losing request had already touched Auth.

## 2. Shared rate-limit design

The existing non-destructive Team migration now contains two private tables:
`clinic_invitation_budgets` for clinic/Owner admission counters, and
`clinic_invitation_claims` for normalized email ownership, target budget,
cooldown and the current attempt lease. No in-memory rate authority is used.
Atomic PostgreSQL UPSERTs and row locks enforce fixed one-hour windows:

| Scope | Limit |
| --- | ---: |
| Owner | 30 admitted/attempted administration requests per hour |
| Clinic, across Owners and operator provisioning | 60 per hour |
| Normalized target email, across Owners/operator provisioning | 5 admitted attempts per hour |

Clinic/Owner counters include duplicate and unavailable-account requests after
validating the active Owner, so failed attempts cannot bypass their budgets.
Email admission is counted before privileged Auth work and is not refunded on
provider failure. Foreign/global account failures remain generic. The private
email budget's details are never returned to the browser.

## 3. Resend cooldown behavior

Owners must wait 60 seconds between admitted attempts for the same email.
The first invite also establishes that cooldown. Concurrent requests cannot
bypass it: the reservation row is locked and updated in the same transaction.
A request in progress additionally holds a 90-second attempt lease. Successful
or known-failed requests make one best-effort finish call to release that lease,
while retaining the cooldown and permanent clinic ownership. If cleanup cannot
complete, same-clinic retries recover after the lease expires.

The browser receives HTTP 429 with `invite_recent` or `rate_limited`, and shows
only a safe wait message. It receives no ledger timestamps, token, Auth identity
or rate-limit internals. Manager/Staff/revoked requests fail authorization first.

## 4. Serialization and race fix

`reserve_clinic_invitation` obtains a transaction advisory lock keyed by the
normalized email, checks existing membership/Auth state, and writes a persistent
unique email-to-clinic claim **before any Auth Admin operation**. Only its
winning request gets an attempt token. A competing clinic fails generically
without generating a link or sending email.

The transaction lock is intentionally not treated as an HTTP-spanning lock.
The committed claim spans generation, membership creation and delivery. Its
clinic ownership never expires or transfers automatically: aborting a fetch
cannot prove that upstream Auth stopped processing. Only the attempt lease
expires, allowing same-clinic recovery without exposing another clinic's invite.
Stale cleanup is token-scoped and cannot clear a newer attempt.

A second profile trigger takes the same email advisory lock on identity inserts
or changes, and rejects membership in a clinic other than the claim owner. It
checks both stored profile email and the authoritative Auth email. This closes
the reproduced concurrent profile-insertion gap, including direct legacy
profile inserts. Existing sensitive-field guard and RLS remain in place.

Supported Owner invite/resend and operator invite/explicit association all use
this same reservation authority. Existing verified external identities still
require explicit operator association. Revoked access is never restored by
invitation work. A claim for an abandoned/wrong-clinic operation is intentionally
not transferable by another Owner; exceptional reconciliation is a trusted
operator workflow after reviewing Auth/profile/in-flight state. No automatic
claim deletion or ownership takeover is provided.

## 5. Total request-work bound

The Owner Edge boundary enforces a 45-second total deadline, including streamed
body reads and outbound response processing; each fetch is limited to 15 seconds.
It stops new work after the deadline. The body remains limited to 4,096 bytes;
reads are also capped to prevent unlimited empty-chunk work, and cancellation
is not awaited indefinitely. Reservation/claim-trigger lock waits are limited
to two seconds.

| Request | Auth Admin calls | DB HTTP operations | Total outbound HTTP calls | `generateLink` calls |
| --- | ---: | ---: | ---: | ---: |
| Owner invite | 2 | 5 | 8 | 1 |
| Owner resend | 1 | 4 | 6 | 0 |
| Operator invite/associate | 1 | At most 6 | At most 7 | 1 / 0 |

Owner totals additionally include one independent Auth `getUser` call, which is
not an Auth Admin call. Invite's two Admin calls are one `generateLink` and one
Auth invitation mailer; the mailer issues the actual emailed verification link.
Database counts are HTTP queries/RPC invocations; their SQL bodies contain a
fixed sequence of statements and no loops or automatic retries.

The Edge transport independently caps eight calls, five database calls, and
one call to each allowed Auth endpoint. Repeated Auth generation/mailer calls
are rejected even if the SDK attempts one. There are no automatic application
retries. The old full-directory backend pagination loop is removed. Operator
provisioning keeps its bounded SELECT/INSERT/verify sequence and existing
30-second fetch timeouts, with reservation and finish added around it.

## 6. Migration changes

Extended `supabase/migrations/20261003160000_clinic_team_management.sql` rather
than creating another identity system or requiring an external service:

- Two private tables with RLS enabled and browser/PUBLIC/anonymous grants revoked.
- A unique non-null attempt-token index and normalized profile-email lookup index.
- Private `take_clinic_invitation_budget`, service-only `reserve_clinic_invitation`
  and `finish_clinic_invitation`, and private trigger function
  `guard_clinic_invitation_claim`.
- The profile INSERT/identity-change claim guard trigger.

Every added function is SECURITY DEFINER with fixed `public, pg_temp` search
path and explicit grants/revocations. The budget helper and trigger function
have no direct anonymous/authenticated/service execution grant; they are used
inside privileged functions/triggers. Reserve/finish are service-only; reserve
independently revalidates an active Owner or requires the trusted operator path.
No migration DML deletes or rewrites profiles/Auth users/history. A local
before/after comparison confirmed all 16 existing product tables and Auth users
unchanged, existing RLS policies/flags unchanged, active-user compatibility,
retained-Owner revocation and service-role access. Reapplication preserves
claims/budgets and revocation markers. Existing migration prerequisites remain
required: profile RLS, enabled sensitive-field guard and restricted grants.

## 7. Edge/backend changes

The existing handler authenticates with `getUser`, resolves the live Owner under
RLS, validates the existing strict schema, then reserves its target in one RPC.
The RPC derives the Owner clinic and performs targeted membership lookup.
Resend obtains only its validated own-clinic pending target from that private
response. It rechecks Owner/target through the existing membership RPC before
mailing. Shared provisioning wraps operator generation/association with the
same claim, and accepts the already-created server reservation for Owner work.
Credentials remain server-only. CORS, byte limits, restricted roles and safe
errors are preserved. Frontend changes only add the two safe wait messages;
there is no Team redesign or new management feature.

Files changed for this hardening:

- Existing Team migration.
- `supabase/functions/_shared/clinic-users.ts` and `request-security.ts`.
- `supabase/functions/manage-clinic-users/function.ts` and `handler.ts`.
- `src/lib/team-management.ts` safe error messages.
- Team invitation/UI tests and runner, provisioning/CLI fixtures, isolation
  inventory, shared request-security tests, and the `test:team` command.
- New `tests/team-invitation-hardening.test.mjs` and this report.

Pre-existing unrelated workspace changes are preserved.

## 8. Cross-clinic race result

PASS. Concurrent Edge requests with one normalized email produced exactly one
successful invitation, one profile in the winning clinic, one Auth generation
and one mail call. The losing request gained no membership and invoked no Auth
Admin operation. Same-clinic concurrent invites produced no duplicate; concurrent
resends admitted one send. Database tests also deny foreign direct profile
insertion after a claim and verify operator/Owner competition, lease expiry and
stale-cleanup protection.

Tests use real PostgreSQL/WASM with actual constraints/functions/RLS and the real
Supabase SDK. PGlite has one connection, so HTTP requests interleave between
atomic database transactions; provider/SMTP calls are local fixtures. No hosted
Auth/SMTP or native Deno runtime was contacted or claimed verified.

## 9. Tests/results

**409 passing local results, zero failures**:

| Suite | Passing results |
| --- | ---: |
| Team database | 15 |
| Owner Edge invitation, races and bounds | 26 |
| Shared admission/serialization authority | 13 |
| Team UI | 17 |
| Auth / invite setup | 29 / 11 |
| Operator provisioning / CLI | 23 / 24 |
| Database permissions / UI permissions | 14 / 9 |
| Clinic isolation/security | 133 |
| Appointment database / Calendar | 18 / 19 |
| Appointment conflicts / migration safety | 12 / 30 |
| Voice Edge isolation | 11 |
| Shared request-body security | 5 |

Frontend TypeScript, backend/Edge implementation TypeScript, production build,
targeted lint and `git diff --check`: PASS. Zero lint errors; three existing Fast
Refresh warnings. Existing compact-format files were linted with only Prettier's
rule disabled; changed Team code/tests used normal formatting/lint rules.
Additional migration/catalog/retained-Owner checks passed. Browser build scan
contains no service-key environment marker or private invitation RPC names.
Native Deno/gateway, live email delivery and redirects remain hosted acceptance
checks. Logs and catalog evidence are `/tmp/apero-hardening-*.log`,
`/tmp/apero-hardening-catalog.json` and `/tmp/apero-hardening-results.json`.

## 10. Existing invite/setup compatibility

PASS locally. Owner invites Manager/Staff; accepted/pending status, resend after
cooldown, expired-link handling, `/account/setup`, role changes, revocation and
retained-session denial still work. Operator verified-account association and
private action-link output remain supported. No portal/practitioner linkage,
practitioner creation/deletion or scheduling change was introduced.

## 11. Paid/external services

None added. Limits and ownership use the existing PostgreSQL/Supabase backend.
Existing Supabase email delivery is reused. No Redis, custom SMTP or telephony
call was introduced.

## 12. Required production steps — not performed

1. Review and apply the complete amended Team migration as one privileged SQL
   transaction, with the existing RLS/guard/grant prerequisites installed.
2. Coordinate replacement of both `manage-clinic-users` and
   `provision-clinic-user` with the shared hardening code, and update the private
   operator CLI/helper. Do not run old invitation tools during/after this release;
   an old Auth generator cannot participate in the new reservation protocol.
3. Publish the existing frontend with the two safe wait messages when the backend
   is ready. Existing redirect/CORS/portal-origin configuration remains required.
4. Verify hosted grants/RLS/native Edge runtime, disposable invite/setup/resend,
   cooldown/rates, concurrent isolation and failure recovery. Preserve all real
   accounts and operational history; do not rerun appointment migrations or paid
   voice acceptance.

SQL Editor compatibility is retained: all changes are ordinary SQL/PLpgSQL in
BEGIN/COMMIT with a PostgREST schema reload. Nothing was applied here.

## 13. Final verdict

**SAFE TO DEPLOY** — the four audited invitation-hardening issues are resolved
locally. Production deployment and acceptance are still required and were not
performed or authorized by this task.
