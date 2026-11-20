# Apero Batch 3 — local release approval package

Prepared November 20, 2026. **Local preparation is complete. External integration is awaiting approval.** No push, PR, merge, GitHub Actions trigger, hosted resource, deployment, production/database operation, actual backup access, provider call, paid simulation or real email occurred. **Money spent: $0.**

## Candidate and commit list

- Branch: `release/stabilization-2026-11-20`
- Separate worktree: `/tmp/apero-release-candidate-20261120`
- Base: `8b47787ce607ee156b94cbbe8e16039b2ed5a404`. Existing history is preserved; remote drift has not been certified.
- Tested runtime commit: `5aed7e5e677a81333a6e0835d4a4ffe76700eaa4`. This approval package is a subsequent documentation-only commit; its own identifier is available from `git log -1` and the final handoff.

| Commit | Logical group | Changed paths |
|---|---|---:|
| `8ec21ba` | chore: exclude local credentials and normalize repository text | 5 |
| `88ff887` | db: establish schema-only bootstrap and lifecycle prerequisites | 14 |
| `b7cc500` | db: stabilize deletion revocation scheduling and retention | 8 |
| `0e49d23` | fix: harden voice operations tenant boundaries and lifecycle handling | 35 |
| `701faea` | fix: preserve dashboard sessions forms and media lifecycle | 65 |
| `3c7ddd2` | test: add stabilization regressions and isolated native validation | 79 |
| `5aed7e5` | ci: gate release branches with application and native checks | 2 |

[Exact runtime commit/file manifest](runtime-commits.json). The eight Batch 2 review patches were independently reapplied to a scratch copy of their original checkpoint: **139/139 files reconstructed byte-for-byte**. The release includes 116 of those patch paths; 23 historical/unrelated paths are intentionally excluded. The runtime release is broader than formatting: it includes the necessary Batch 1 fixes and prerequisite files. [Patch integrity evidence](patch-integrity.json).

## Included and excluded files

The seven runtime commits change **208 paths**, including `.env` removal from tracking. They select **294 stabilized source files** including unchanged dependencies. [Exact changed paths](included-files.txt), [excluded untracked source paths](excluded-source-files.txt).

Included: active dashboard/auth components; clinic/voice/webhook/legacy handler fixes; canonical database changes; all **22** migration files; scoped tests and native/synthetic restore harnesses; necessary offline Retell master/transformer/compact booking fixture dependencies; operations Python helpers needed by tests; and the single application-checks workflow. The static retention policy and SQL schedule are prerequisites and included for review; no hosted scheduler was activated. Nine specially prepared migrations retain their Batch 2 hashes.

Excluded: local `.env`, secrets, private recovery archives, linked Supabase `.temp`, `.sql.save`, unrelated historical Retell drafts/acceptance traces, handoff/legal material, AWS infrastructure and autonomous backup/retention GitHub workflows. The candidate tracks `.env.example` placeholders only. Existing public-key history is retained without rewriting it.

All copied runtime content matches the intended stabilized checkout byte-for-byte **except one reviewed workflow change**: pushes to `release/**` now trigger the checks alongside `main`. No functional fix was reimplemented in Batch 3. [Source parity and preservation](preservation-and-parity.json).

A heuristic scan of all **387 runtime tracked files** found no unresolved credential candidates; two test files contain reviewed synthetic secret sentinels. The compact flow fixture is configuration, not call/recording data. Unknown secret formats are not certified by pattern matching. [Tracked scan](tracked-secret-scan.json), [selected-source scan](secret-scan.json).

## Original repository preservation

The original checkout remains on `main` at the same base SHA with **113 tracked status entries and 296 untracked files**. Its only staged change remains the pre-existing `.env` tracking removal. Its status matches the Batch 3 start capture exactly; all **588** completion-checkpoint source hashes, including local `.env`, match. Both durable Batch 2 recovery archives were independently verified against their manifests. No original tracked/untracked file was overwritten, reset, cleaned or discarded. The worktree's metadata registration and new local branch/commits are additive.

The candidate uses an ignored `node_modules` symlink to the existing installation. Tests/build used candidate source and candidate working directory; a fresh independent dependency installation is still exercised by CI. The original dependency directory was not reinstalled or changed.

## Candidate verification

| Gate | Result | Scope / remaining limitation |
|---|---|---|
| Full lint | **PASS: 0 errors, 0 warnings** | Full rules, `--max-warnings=0`; no formatting rule disabled |
| Configured TypeScript | **PASS** | Application, demo, clinic-user Edge configs; not a claim of complete Deno checking |
| Production build | **PASS** | Placeholder Supabase settings; existing bundle-size warning |
| Application/handler/database suites | **PASS** | All 25 selected npm scripts; auth/lifecycle/UI, signed/mock handlers, RLS/roles/retention/offboarding/booking/migrations and voice fixtures |
| Python | **PASS** | Operations 30/30 and UTF-8 2/2; Retell fixtures also run within application scripts |
| Native concurrency | **PASS** | PostgreSQL 16.15; 80 races, both exclusion configurations, owner/manager/staff, cross-clinic denial; zero committed overlaps; dashboard 9 and voice 10 deadlocks reproduced/handled |
| Native SQL / pg_cron | **PASS** | All 22 migrations, fresh and existing-upgrade; real cron worker; preserved upgrade data; minimal Auth SQL shim |
| Genuine synthetic backup/restore | **PASS** | `pg_dump → age → pg_restore`; public/extensions btree_gist, Arabic rows, structure/ACL/RLS/exclusions; no real backup/plaintext dump |
| Workflow validation | **PASS locally** | actionlint; no remote workflow execution |
| Native Windows | **Not run** | Prepared CI job; native Windows Node unavailable here |
| Full Supabase Docker bootstrap | **Not run** | Prepared CI job; Docker/Supabase local runtime unavailable here |

The release runner completed all **27 groups with zero failures**, and was rerun at the committed runtime SHA. Native tests also ran against the actual candidate after runtime commits. No check was weakened to hide failure. Two heuristic secret-scan assertions initially flagged synthetic fixture strings; exact fixture allowlisting resolved those findings without changing source/tests. [Application results](committed-runtime-application-results.json), [checks and log hashes](release-checks.json), [native concurrency summary](native-concurrency-summary.json), [native migrations/restore](native-migration-results.json).

## CI activation and Windows requirement

The candidate contains one read-only, secret-free release workflow with five required jobs: `quality`, `regression`, `windows-components`, `native-database`, `supabase-bootstrap`. It runs on PRs and pushes to `main` or `release/**`. The prepared Windows and full managed-Supabase jobs remain **unexecuted release gates**. Local PostgreSQL and mocked/WASM tests do not replace them.

Before an approved push, confirm Lovable's active sync branch, read-only reconcile remote `main`, and approve possible CI charges. After the first approved runs, configure the actual observed five GitHub Actions checks as required in a main-branch ruleset with PR review, up-to-date checks, resolved conversations and no force pushes/deletion. A YAML file alone does not enforce a merge gate. [Exact activation steps, permissions, runners and command](ci-activation.md).

## Migration rollout readiness

The **nine prepared files** are the fresh-only baseline `20260930000000`, then eight fixes in this order: `20261120100000` (notes), `20261120101000` (request RLS), `20261120102000` (revocation), `20261120103000` (demo cleanup), `20261120104000` (practitioner reschedule), `20261120105000` (bounded availability), `20261120110000` (phone RPC/index), `20261120111000` (retention/holds). [Exact filenames and hashes](migration-checksums.json), [complete 22-file order](all-migrations.txt).

A fresh approved staging project needs the **entire 22-file chain**, not just nine files. An established database must never execute the baseline; inspect actual history/schema/owners/ACLs first and separately approve any history repair. Hosted schema compatibility has not been verified. FK replacements and the phone index require lock measurements. Keep retention dry-run and provider workers inactive.

Deploy RPC migrations before dependent Edge handlers: `clinic-operations` needs `appointment_search_slots`; `retell-webhook` and legacy `book-appointment` need `clinic_clients_by_phone`. Then validate backend security and deploy dashboard changes. Retain additive RPCs/indexes and historical notes/holds/ledgers during an application rollback; use corrective migrations rather than destructive downs. [Staging-first sequence, exact signatures, security and recovery](migration-rollout.md).

## Staging recommendation and cost

Use a **separate Supabase project plus a separate Cloudflare Worker frontend** with synthetic-only users/data and staging-only credentials. This matches the current Nitro Cloudflare build target. Keep production Lovable/Git/Supabase connections unchanged. Existing account plans, Free slots and staging infrastructure have not been confirmed; no additional service was created.

Conditional estimate: **+$15/month plus usage/CI** for an extra Micro project in an existing paid Supabase organization and a new Paid Workers account; **$30/month plus usage/CI** for a new Supabase Pro organization plus Workers. Free options require account/workload eligibility. Vercel is an alternative after adapter validation; a new Pro seat is $20/month plus usage. CI planning estimate is $0.15–$1/full run, not measured hosted runtime; release push and PR can cause two runs. No one-time service setup charge is assumed for standard vendor hostnames; domains, SMTP, backup add-ons, tax and labor are excluded estimates. Published price sources and all assumptions are in [staging design](staging-design.md).

That document lists all browser/server/Edge environment settings, Auth redirects, account requirements, mock-only Retell constraints and rollback steps. Keep demo/provider mappings inactive and invitation/reset sending unavailable until an approved non-delivering sink exists. No production users, recordings, Auth rows or backups are needed.

## Remaining blockers and approvals

1. **Founder review** of the candidate scope/commits, especially included prerequisite migrations and runtime changes from the prior dirty checkout.
2. Confirm Lovable active branch, remote main drift and GitHub account billing/runner eligibility before integration. Remote changes require additive reconciliation and new tests.
3. **Approve exact branch push and CI run budget**; PR creation and its additional CI run require approval too. No push/PR/merge has occurred.
4. Pass actual Windows and Docker-backed Supabase checks, then approve/configure required branch protections.
5. **Approve staging provider/account choice, budget, provisioning and deployment.** Verify project separation, actual managed schema/version/owners, migration history, locks and recovery before any hosted SQL.
6. Production merge/publish/migrations, credential changes, Retell publication/calls, real mail, provider deletion, actual backups/restores and paid infrastructure remain separately approval-gated.

There is no remaining failure in the executed local gates. Hosted acceptance and the two environment-specific jobs are not certified. **Total money spent: $0.**
