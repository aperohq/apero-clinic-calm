# Activation and synthetic cleanup — T-035 / T-072

Use executed lifecycle evidence in [account-security.md](account-security.md); no real clinic was activated by this assignment. Existing implementation and consent revision requirements are reused without new legal terms.

The supported progression is incomplete onboarding → configuration complete → technically ready → awaiting external review → explicit trusted activation. Configuration validity alone is not activation. Review fingerprints bind current configuration, team/data review and consent revision. Drift requires a fresh review. Only the trusted administrative decision path can activate; browser Owners, Managers and Staff cannot invoke it. Synthetic-classified clinics are prohibited from live activation. Suspension denies clinic admission and revokes enrolled API keys; restoration does not revive those keys or silently reactivate the clinic. Closure remains terminal in this workflow.

## Isolated procedure

1. Initialize a fresh disposable local database with the current migrations; do not load a production backup or environment credentials.
2. Generate a unique run identifier and an explicit manifest of invented Auth identities, clinic/member/practitioner/client/appointment IDs. Prefix display names with `APERO ACCEPTANCE <run>` and use reserved test addresses. Classification labels are supporting evidence, never sufficient deletion authority.
3. Provision through the trusted path, retry with the same stable key, test invalid payloads and transactional rollback, then perform authorized lifecycle/readiness checks. Keep SQL claims versus hosted JWT results distinct.
4. Verify explicit approval gates, denied browser activation and synthetic activation refusal. Do not remove the synthetic flag to demonstrate a live activation. Consent test revisions are isolated fixtures, not customer approvals.
5. Before cleanup, verify the database is the exact disposable local cluster/run and each fixture manifest ID belongs to that run. Stop on any unknown row, legal hold, unexpected reference or provider binding. Inventory dependent rows and retained audit/erasure records first.
6. Close test sessions, stop workers and remove the whole disposable cluster using its existing test teardown. For a shared isolated database use a reviewed transaction restricted to exact manifest IDs and dependency order; roll back if affected counts differ. Never use name-prefix deletion, phone matching, `TRUNCATE`, unbounded clinic deletion or a production deletion worker as a shortcut.
7. Verify no run-scoped active clinics, memberships, Auth sessions, clients, appointments, jobs or temporary credentials remain; expected durable identifier-only audit records may remain under the established retention contract. Verify other-tenant sentinel rows and legal holds unchanged. Close database connections; verify server PID/socket absent. Retain only sanitized test results and manifest hashes.

## Production boundary

Existing synthetic production identities/calendar fixtures predate this assignment and were **not deleted**. Historical cleanup candidates in `docs/operations/access-auth-synthetic-cleanup.sql` are not authorized deletion instructions for this run: first reconcile exact IDs and remaining references against the current database under founder approval. The named integration acceptance calendar is preserved; no event, account, mapping or token is changed. Never delete from production merely because a record appears synthetic.

Founder action: nominate the exact candidate IDs and retention/legal-hold review, approve the bounded cleanup transaction and its expected counts, approve any linked account/calendar changes separately, and authorize execution. Verify zero exact candidate rows and unchanged non-candidate sentinels/aggregates afterward; retain transaction outcome and surviving audit references without patient content. Actual consent and real-clinic activation require the clinic's authorized representative plus explicit founder authorization.
