# Apero PR #11 — production database-only deployment

**VERIFIED: the five authorized migrations and five transactional ledger entries are deployed.** Target `svoybvzvmygszklcmudh`, database `postgres`, PostgreSQL 17.6, region `ap-northeast-1`; approved source `9dfbe744e800c810118bb699bacc370a0844f7d0`. Verification completed **2026-11-24T18:40:05.354876+00:00**. No automatic rollback/replay, merge, dashboard publication or activation occurred.

| Version | Migration | Result |
| --- | --- | --- |
| `20261124100000` | `clinic_onboarding` | COMMITTED / VERIFIED |
| `20261124102000` | `clinic_activation` | COMMITTED / VERIFIED |
| `20261124110000` | `clinic_member_reactivation` | COMMITTED / VERIFIED |
| `20261124111000` | `suspended_team_management` | COMMITTED / VERIFIED |
| `20261124112000` | `integration_access_lifecycle` | COMMITTED / VERIFIED |

## Admission and execution

The corrected preflight verified the actual libpq SSL connection using client `\conninfo`, with **sslmode=verify-full** and the approved CA. Pooler backend `pg_stat_ssl` was not used as client TLS proof. The approved project/connection identity, immutable PR/source/staged hashes, eight existing passing CI checks, exact 25-row starting history, pristine prerequisite schema against the verified backup, and authenticated backup access all passed. No tests or unrelated audits were repeated.

Each approved file executed once in order, with its exact source-version/name/text ledger INSERT inside the same transaction. Its ledger prefix was checked before the next file. All five committed without SQL error or timeout. Final history contains **30 rows**; full-row fingerprints of the **25 pre-existing entries match**. No legacy repair, renumbering, old migration replay, seed or whole-directory push occurred.

Recovery point reused under the founder's approval: **2026-11-24 18:05:23.564321 UTC**, encrypted bundle `onboarding-20261124T180521Z/20261124T180533Z-3662ab8f33b64c3ab2b6cd20d2cf0cc6`. Ciphertext hashes and recovery-key authentication were rechecked before execution. Prior PG17 restore: 2.77 seconds including row counts, 3.09 seconds with full verification; not a full hosted-cutover RTO. Founder is sole operator, rollback owner and custodian; independent custody remains unverified, as explicitly acknowledged.

## Production verification

- Read-only postflight security contract returned **[]**. Three new tables have RLS and no anonymous access or direct browser writes; all seven expected release triggers are enabled.
- Provisioning/registration/lifecycle decision RPCs: browser/anonymous denied, trusted service allowed. Readiness/restoration browser grants present; private original RPCs denied to anonymous, browser and service roles. Browser updates to profile clinic/auth identity, role, revocation and email remain denied; permitted name/phone edits retain their grants.
- Read-only SQL-claims checks covered **10 existing identities**: 5 Owners, 1 Manager, 3 Staff and 1 unusable identity. Expected clinic/profile/role admission passed; foreign-clinic membership, clinic, practitioner and appointment reads were denied. Unknown identity denied. Six permitted team reads and five owner readiness checks passed. Legacy clinics honestly return onboarding_incomplete rather than auto-activation.
- PostgREST resolves the new readiness RPC and returns **401 / 42501 permission denial** for an anonymous request, demonstrating visibility and authorization rather than a missing-function/cache error. No service credential or real JWT was fetched for this probe.
- **13 existing RPC argument/return/owner contracts** remain compatible. Existing **747 columns, 275 constraints, 28 policies and 74 table ACL records** are preserved; **107 unrelated function fingerprints** are unchanged. Existing appointment columns, booking constraints and policy definitions are unchanged.
- Before/after aggregate counts match for clinics, memberships, clients, appointments, practitioners and historical notes. No clinical row content was exported into test logs, and no test appointment/account/clinic writes or real invitations were performed. These checks prove schema/contract/count compatibility and live read-only admission; they do not assert that a full hosted write workflow was exercised.
- Temporary execution login revoked after postflight: zero unexpired CLI roles/connections, saved credentials rejected, private temporary credential files removed. Original dirty working tree preserved; reviewed branch remains clean at the approved SHA.

## Remaining release boundary

**Database deployment is complete; dashboard release is not.** Hosted signed-JWT sign-in/session/MFA/recovery and full browser acceptance were not run. New provisioning, restoration and lifecycle mutations were verified by existing CI and deployed grants/contracts; no live mutation fixtures were authorized or introduced here. Do not infer a clinic UAT or paying-clinic activation pass.

Obtain separate authorization before PR #11 merge. Verify the intended Lovable main synchronization/preview under its approved scope, then obtain separate dashboard publication approval. Retell/SIP/provider changes, real invitations, clinic activation and paid infrastructure remain excluded.

No rollback was needed. If a later incident occurs, hold frontend release, preserve guards/audits and investigate a reviewed forward repair. Any production restore/cutover remains a separate explicit incident decision with checkpoint/write-loss reconciliation; the migration approval does not authorize restoring over production.
