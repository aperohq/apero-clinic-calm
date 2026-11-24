# Clinic onboarding and account lifecycle acceptance

## A. Executive summary

**IMPLEMENTED / NOT DEPLOYED.** Apero now has a trusted, atomic administrative clinic intake/provisioning path, deterministic readiness with explicit review and activation decisions, protected account restoration, lifecycle-aware portal/API authorization, durable audit records, and local acceptance coverage. Existing clinic/team/settings/retention architecture was reused.

The original checkout remains dirty and preserved at `8b47787` on `feat/api-calendar-integrations`. Read-only upstream verification confirmed main `4d076546de1744c6e8845edc2e19df3f769d1f40`. The isolated review branch `feat/clinic-onboarding-hardening` is based on that verified commit in `/tmp/apero-onboarding-review`.

No production access or changes, real invitations, emails, calls, provider changes, paid infrastructure, push, PR, merge to main, or deployment occurred. Real clinic UAT and production acceptance are open.

## B. Roadmap evidence

| Roadmap | Local result                                                                                                                                                                                               | Acceptance still open                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| T-024   | VERIFIED: native PostgreSQL applies all 33 migrations; concurrency, legal hold, demo FKs, sessionless revocation, historical notes and erasure/audit regression                                            | Production migration review and deployed evidence                                           |
| T-031   | VERIFIED: real Chromium synthetic panels at 375/768/1440; no overflow, confirmation, keyboard containment, sanitized errors and retry                                                                      | Whole deployed-route acceptance and representative UAT                                      |
| T-035   | IMPLEMENTED / NOT DEPLOYED: private offline intake artifact, trusted atomic provisioning, key/contact/owner duplicate checks, interrupted retry, explicit practitioner shifts, synthetic/data-review gates | Real Tally export mapping, clinic-approved schedules and controlled live account enrollment |
| T-063   | VERIFIED locally: two clinics with distinct Owner/Manager/Staff, grants/RLS, recording URL column protection, stale claims, suspension and credential isolation                                            | Production RLS/Auth evidence                                                                |
| T-064   | IMPLEMENTED / NOT DEPLOYED: restoration guards, ban/deletion checks, retained-token denial, read-only owner MFA readiness; existing recovery/invite flows reused                                           | Hosted Auth policy, actual MFA enrollment/step-up/recovery rehearsal                        |
| T-072   | IMPLEMENTED / NOT DEPLOYED: configuration, technical review, external review and explicit activation states; consent/fingerprint/security gates; suspension/reactivation/closure                           | External integration/telephone acceptance, release decision and paying-clinic activation    |
| T-073   | VERIFIED locally: deterministic SQL/SDK/UI tests, native concurrent transactions, Chromium synthetic account workflows and integrated browser/SDK/native panel rehearsal; dedicated CI prepared            | Remote CI and full deployed Auth/PostgREST/browser acceptance                               |
| T-075   | UAT checklist prepared                                                                                                                                                                                     | EXTERNAL DEPENDENCY: no representative has signed off                                       |

No roadmap item requiring external or production evidence is closed.

## C. Existing functionality reused

- Existing `clinics`, `profiles`, Owner/Manager/Staff enum, one clinic per Auth identity, tenant helpers, RLS and restricted column grants.
- Existing team invitation reservations, lease/rate limits, safe duplicate handling, role/revoke RPCs and Auth recovery/invitation setup.
- Canonical clinic settings validator, seven-day public hours, practitioner service arrays, weekly availability and dated time off.
- Existing retention approvals, legal holds, durable deletion ledger, sessionless maintenance revocation, note-author FK nulling and demo-session offboarding guards.
- Existing integration key/scopes/audit model and API mutation implementation. Only database credential authorization boundaries changed; provider/Calendar functionality was not expanded.
- Existing React Query, Supabase SDK, design system, happy-dom and disposable PostgreSQL infrastructure.

## D. Changes and files

- `supabase/migrations/20261124100000_clinic_onboarding.sql`: intake/audit tables, validation, `provision_clinic`, explicit existing-clinic registration and legacy offboarding admission.
- `20261124102000_clinic_activation.sql`: lifecycle-aware tenant helpers, security catalog admission, readiness, consent/review fingerprints, explicit lifecycle decisions and configuration locks.
- `20261124110000_clinic_member_reactivation.sql`: protected restoration and membership audit; preserves existing narrow sessionless retention exception.
- `20261124111000_suspended_team_management.sql`: guarded existing team RPCs and private originals.
- `20261124112000_integration_access_lifecycle.sql`: lifecycle-aware owner/key authorization, permanent key revocation on suspension/closure and clinic-before-key mutation admission.
- `package.json` / `package-lock.json`: scoped Zod 4.6.7, Vite 8.1.6 and source-map-js 1.2.4 advisory fixes; rationale in [DEPENDENCY_SECURITY.md](DEPENDENCY_SECURITY.md).
- `scripts/onboarding/prepare-intake.mjs`, `test-local.mjs`: offline SQL preparation and portable synthetic scope runner.
- `src/components/clinic-readiness-panel.tsx`, `src/lib/clinic-readiness.ts`, Account route, existing account-access panel and RPC types: readiness/error/retry, restoration confirmation and owner MFA status.
- `tests/onboarding-*.mjs`, `member-reactivation.test.mjs`, readiness UI and targeted team harness changes: SQL, native and browser acceptance.
- `.github/workflows/clinic-onboarding-checks.yml`: portable, native and browser PR checks; read-only repository permissions, synthetic inputs, no deployment or production secrets.
- `ADMINISTRATIVE_INTAKE.md`, `ACCOUNT_ACCEPTANCE.md`, `UAT_ACCEPTANCE.md`, execution tracker and evidence artifacts.

## E. Database and security behavior

Provisioning requires trusted server execution. It associates a verified, usable existing Auth owner, validates Unicode/configuration/service duration/eligibility/explicit schedules, configures closures, and inserts clinic, owner, practitioners, hours and audit in one transaction. Identical retries return the same clinic; changed payload reuse and duplicate owner/contact attempts fail. A late failure leaves no partial clinic or membership. Existing-clinic registration validates the saved owner, clinic and complete active roster/schedules without recreating data. Old offboarding state also blocks active legacy profiles and operator/API admission. No browser service-role credential or public provisioning endpoint is introduced.

Readiness validates current configuration, active scheduled service mappings, closures, team confirmation, synthetic classification and reviewed client/appointment contents. Related notes and provider/recording contents still require the operator cleanup assessment; they are not independently certified by those parent-row fingerprints. Core RLS/anonymous grants, protected membership mutation and administrative RPC execution are checked before readiness can pass. Technical review binds the current configuration/membership/data fingerprint and consent revision; drift requires review again. Missing or malformed configuration and disabled enforcement cannot produce a false ready result.

Only trusted, explicitly authorized lifecycle decisions can activate. Technical review and external-review states perform no automatic activation. Suspension/closure denies portal authorization for retained JWTs; existing API keys are revoked and do not revive on reactivation. Reactivation restores configuration access and requires a new activation decision. Closure is terminal here and does not erase records or bypass holds.

Native concurrent tests verify clinic-before-key locking and fresh authorization after waiting. Owner restoration remains same-clinic, confirmed, role-preserving, ban/deletion-aware and audited. Browser ownership transfer, self/owner removal and direct role mutation remain prohibited.

## F. Validation and results

Final evidence is linked from `EXECUTION_TRACKER.md` and stored in `validation-evidence/` and `responsive-evidence/`.

- Portable scope runner: six database/CLI test files passed, readiness UI contract passed, Team UI **19/19**.
- Full-schema access/recording-column matrix: **15/15**.
- Existing integration credential database boundary suite: **21/21** locally, also included in the passing scope runner.
- Native PostgreSQL **16.15**, **10/10**: 33 migrations, documented intake/retry/Unicode, both API-write/suspension orderings, stale-RLS configuration write, operator invitation race, Owner/team lock ordering, legacy offboarding, demo/notes/legal-hold/durable-erasure/audit preservation.
- Real Chromium **159.0.8154.6**, Playwright **1.65.1**: readiness/restoration/error/retry/keyboard/role controls at **375/768/1440**; zero external requests. These are real panels/CSS with synthetic Auth/DB responses, not a claim about deployed whole routes.
- Integrated Chromium → real Supabase SDK → native PostgreSQL panel rehearsal passed: readiness stages, cross-clinic denial, browser provisioning/activation denial, role changes, revocation/restoration persistence and retained-session/clinic-suspension denial. Only Auth issuance/transport are synthetic; zero external requests.
- Production-dependency audit: **3 high findings → zero reported vulnerabilities** after scoped patches; before/after registry audit evidence saved.
- Application and clinic-user Edge TypeScript checks passed; production build passed; focused changed-code ESLint, formatting and diff checks passed.
- Existing local account/invitation/hardening test files passed; invitation setup **8/8** valid and **3/3** invalid/expired; permission UI **9/9**; Settings UI **33/33**.
- Regression failures found during implementation (fixture claims, incomplete guards, stale review and lock ordering) were repaired and relevant checks rerun. Old failed logs are not acceptance evidence.

The broad Auth runner was stopped after discovery of excluded voice hooks in its shared suite; partial output is not full Auth acceptance. Full release/provider/voice suites were not run. Native schema application does not invoke provider/voice flows; lifecycle demo fixtures exercise database FK/retention behavior only.

## G. Git, PR and CI

Reviewed local commits: `b07f82b` — atomic intake/lifecycle authorization and SQL/native contracts; `77ad18f` — readiness/account UI and synthetic acceptance/CI; `284e600` — audited dependency patches, SHA-256 review fingerprints and temporary-schema defenses. The documentation/evidence commit follows those implementation commits. The review branch is local and based on verified upstream main. No push or PR was opened. No remote CI execution is claimed. Existing PR/main CI includes excluded suites, and repository instructions warn that connected-branch pushes sync to Lovable. Publication safety cannot be assumed from local workflow inspection alone.

The original staged `.env` deletion and unrelated changes remain untouched. New implementation is also available in the original working checkout for review; isolated commits contain only task scope.

## H. Deployment status

**IMPLEMENTED / NOT DEPLOYED** for all five migrations, frontend changes and CI additions. Local native migrations ran only in fresh disposable Unix-socket clusters, with synthetic data and explicit teardown. Temporary native/browser tooling was extracted or installed under `/tmp` without system package/service changes. Existing Zod/Vite/source-map-js versions were subsequently patched in the review branch; no new application dependency names were added.

Apply approved migrations in timestamp order before UI rollout. No Supabase project was linked, migrated or reconfigured. Real production state is UNKNOWN.

## I. Remaining blockers and external dependencies

- Production/staging deployment, deployed RLS/session evidence, hosted Auth policy and real MFA/recovery acceptance require authorized access and separate approval.
- Real Tally export mapping and practitioner schedule confirmation require clinic/operator input. Existing schema supports one practitioner interval per weekday; a practitioner working two separate same-day shifts needs an approved scheduling extension. Public split hours and explicitly selected practitioner shifts are supported.
- Registering an existing clinic is explicit and does not recreate its data. It gates existing API keys until separate activation review; production enrollment needs a planned rollout/approval, not automatic backfill.
- The service-duration catalog is validated and retained; it does not replace existing appointment/provider duration computation. Scheduling-duration compatibility must be verified before external release approval. This work does not change excluded voice configuration to match the catalog.
- Retell, live telephone, routing, provider-side shutdown and live integration acceptance remain **EXTERNAL / UNKNOWN**. Portal/API suspension must not be represented as stopping telephone routing or every background integration worker.
- No real email was sent. Delivery/SMTP setup is out of scope; controlled account/invite/recovery acceptance remains open.
- T-075 requires actual clinic representatives. Synthetic tests cannot provide business or production activation approval.

## J. Explicit approvals required

Production migrations; production account/ownership or credential actions; provider/integration changes; real invitations/emails; paying-clinic activation; any paid/billable operation; and publication that could deploy or start billable CI. None is implied by this local implementation. A reviewed release/PR publication decision is still required because Lovable and existing CI may act on pushes/PRs.

## K. Risks, rollback and next launch actions

Review the five migrations and evidence; authorize staging/production rollout separately; rehearse deployed Auth/MFA/recovery and tenant checks with synthetic accounts; confirm duration/schedule and external voice/integration readiness; obtain representative acceptance; then make an explicit activation decision per clinic before launch.

Rollback UI first and revoke new action RPC privileges if necessary. Preserve intake and audit evidence. Do not drop lifecycle-aware tenant helpers or restore old credential grants: that can restore suspended access. Do not un-revoke old API keys; issue fresh authorized credentials after reactivation. New audit UUIDs intentionally survive erasure, and their retention policy needs operational review. Historical deleted authors retain note content/timestamps/associations with a null author FK, matching the existing privacy-preserving design. No destructive production rollback or cleanup is authorized.
