# Final execution handoff — November25,2026

**Independent acceptance execution is complete. Technical release recommendation: NOT READY.** Remaining requirements are documented founder/external dependencies. No running test, real-clinic activation, consent or representative signature is represented as complete.

Worktree `/tmp/apero-final-acceptance`; branch `acceptance/final-production-20261124`; application baseline main `cd858f56cf87269e0bc70e25fceaca0dd8602c98`, revalidated unchanged after the final test. Original dirty checkout `/home/nour/apero-clinic-calm` remains on `feat/api-calendar-integrations` at `8b47787`; staged `.env` deletion is preserved. No published history was rewritten.

## Commits and review state

- `1f2e9f4` — native account/appointment, browser, genuine expiry, read-only inventory and recovery harnesses.
- `3e5fc52` — missing database-backup CI recovery input fixed; one database-only protected secret reference and eight regressions;37/37 combined tests passed, zero skipped. Local preparation; not installed or activated.
- `630b18a` — actual native Auth MFA enrollment/challenge/backup-factor recovery;21/21 assertions, complete cleanup.
- Final evidence/documentation and the matrix generator follow these commits. The final response records that commit SHA; `git log -4 acceptance/final-production-20261124` identifies the full chain without a self-referential hash inside its own contents.

No push, PR, merge or production deployment occurred. [Prepared PR body](PR_BODY.md). Existing PR CI invokes excluded voice suites through `.github/workflows/application-checks.yml`; protected publication requires coordination with their authorized owner. No checks were bypassed. Eight PR11 and five required main checks were verified for the application baseline; new local commits have no remote CI run.

## Terminal evidence

- Six portable SQL/CLI file wrappers, readiness contract and Team UI19/19 passed.
- Native lifecycle10/10 and focused Manager/appointments10/10 passed; each total includes one wrapper.
- Isolated component browser155/155 and public production anonymous30/30 passed.
- Actual hosted Owner/Staff routes60/60 passed. Original70 checks recorded68 passes and two premature logout DOM counts. Corrected focused10/10 passed; original evidence is retained and only those timing assertions are superseded.
- Actual hosted natural expiry5/5 passed: unchanged3600s JWT rejected401 after3698s, refresh200, same-clinic recovery200, local logout204 and refresh rejection. Unified session15312 completed exit0; no expiry process remains to resume.
- Five synthetic sign-ins, one refresh and five local sign-outs occurred across current hosted runs; no business/membership/credential/factor/configuration/schema mutation occurred.
- Actual native Auth v2.198.0,77 internal Auth migrations and21 MFA assertions passed in a no-egress namespace. Production health reports the same version tag; binary/configuration identity and hosted Apero MFA are not inferred. Cleanup proved zero identities/factors/sessions, absent Auth PID, removed PostgreSQL socket/cluster and private tmpfs.
- Backup safety37/37; three33-migration modes; two synthetic encrypted restore variants; six isolated artifact/configuration/transaction/runtime recovery scenarios passed.
- Prior authorized checkpoint ciphertexts match recorded hashes/private permissions; no new real-data decryption/copy occurred. That checkpoint predates onboarding and does not establish recurring protection or hosted cutover RTO.

The matrix contains341 rows:327 PASS,11 BLOCKED,1 FAIL,1 UNVERIFIED,1 NOT APPLICABLE. Rows combine grouped/historical evidence, individual assertions and gates; they are not additive test counts. All15 task IDs are represented. The FAIL is server password minimum6 versus required8. Mail delivery and recurring backups remain P1 operational gates. Hosted Manager/MFA/mutations, recovery custody/objectives, genuine consent/UAT and external readiness remain dependencies.

## Packet verification and use

[README](README.md) contains the A–I report and all15 task statuses. [Deliverables index](evidence/deliverables-index.json) maps all15 requested artifacts to combined documents. Matrix, UAT/signatures, inventory, activation cleanup, backup/rollback procedures, P0/P1 register, freeze and founder actions are linked there.

`MANIFEST.sha256` covers every packet file except itself. Source scope/continuity, tool provenance, executed logs, metadata, safe-pattern scan and completion audit are under `evidence/`. Final local verification checks checksums, links, task/status coverage and source hashes; behavioral acceptance is supported by executed logs, not file existence alone.

Frontend SHA remains founder-attested, supported by matching accepted Account/Team artifact hashes. Full private runtime value equivalence remains unverified: seven expected secret names exist, but sanitized historical records lack comparable per-setting digests. No value field was exported to invent a match.

Spending, external calendar/storage/message writes, real patient access, Retell operations, production deployments/rollbacks, real clinic activation and unauthorized production backup copies are zero. Local synthetic servers/fixtures and current hosted test sessions completed cleanup. Reopen only affected acceptance after an authorized change; preserve tenant/session/lifecycle guards and audit history.
