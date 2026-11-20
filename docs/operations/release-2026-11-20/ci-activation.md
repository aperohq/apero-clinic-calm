# GitHub activation boundary

No push, pull request, workflow run or branch-setting change has occurred. This document is the exact next-step plan after founder approval, not permission to execute it.

## Candidate wiring and permissions

The candidate's only Actions file is `application-checks.yml`. It runs on pushes to `main` and `release/**`, and on pull requests. Thus an approved push of `release/stabilization-2026-11-20` will immediately start all five jobs. Creating a PR can start another run; approve the expected run count/budget rather than assuming one billable execution.

- `quality`: Node 24, npm lockfile, all three configured TypeScript checks, full lint with zero warnings, production build using placeholders.
- `regression`: Linux Node 24 and Python 3.12, explicit local/mock suites and pinned/ranged requirements already used locally.
- `windows-components`: fresh Windows npm installation, junction/player/analytics/CLI/lifecycle coverage. Linux node_modules are never reused there.
- `native-database`: Ubuntu PostgreSQL 16, pg_cron and age, disposable Unix-socket clusters, real races, actual cron work and genuine encrypted synthetic restores.
- `supabase-bootstrap`: pinned CLI 3.0.0 and runner Docker; an unlinked temporary project gets migrations only, no source `.env`/`.temp`, then a seed-free reset and cron/exclusion checks.

Permissions are `contents: read`; checkout does not persist credentials. No OIDC, deployment token, hosted Supabase secret, Retell key, AWS identity or mail credential is supplied. No deployment/provider/backup workflow is included. The new release trigger is the only intentional difference from the stabilized source workflow; it has not been triggered.

Linux jobs need package/image downloads and Windows needs platform-native npm dependencies. Hosted runner time and cache usage may be billable. Confirm repository visibility, account plan, included minutes, budgets and actual runner SKU before pushing. There are no artifact-upload steps. See [cost assumptions](staging-design.md).

## Exact approval and activation sequence

1. Review the commit/file manifest, local results and migration runbook. Confirm this candidate branch is **not** Lovable's currently active sync branch; inspect its Git settings. Keep the production editor/backend connection unchanged. No force push or history rewrite is permitted.
2. Confirm who may authorize GitHub billing and set an initial CI spending/run budget. Approve the first push plus the expected PR-triggered run, or approve only the first push and defer PR creation.
3. Read-only fetch/reconcile remote `main` before pushing. The candidate is based on local `8b47787`; remote drift has not been certified here. If remote has advanced, merge additively on the isolated branch, resolve only reviewed conflicts, and rerun the candidate checks. Never rebase/amend published commits.
4. After those approvals, the operator may push the exact reviewed branch normally:

   ```sh
   git push --set-upstream origin release/stabilization-2026-11-20
   ```

   This command is intentionally not executed by the agent. It triggers CI and may sync Lovable if its active branch was changed, which is why the prior check is required.
5. Review all five remote results at the exact pushed SHA, especially Windows and managed Supabase. Do not replace a red or skipped check with local/WASM evidence. Correct failures in new commits and obtain approval for any further billable runs.
6. After approval to create the PR, open a **draft** PR from the release branch to `main`. Include the release approval package and staging plan; do not merge or turn it into a deployment automatically.
7. In GitHub **Settings → Rules → Rulesets**, create/review a branch ruleset targeting `main` (and later `staging` if adopted). Require a PR, at least one founder/reviewer approval, current reviewed checks, and resolved conversations; block force pushes and deletion. Do not add an automation bypass casually.
8. Select the five checks from the GitHub Actions app after their first runs: **`quality`, `regression`, `windows-components`, `native-database`, `supabase-bootstrap`**. Require all five and an up-to-date branch before merging. Confirm the actual observed check names; the job IDs above are stable. No path filter skips these jobs.
9. Coordinate Lovable's editor workflow before enforcing protection: direct pushes to a protected active branch can be rejected, with Lovable using a sync branch. Review/merge its changes through the same process rather than disabling checks. [Official Lovable branch/sync behavior](https://docs.lovable.dev/integrations/github).
10. Approve staging provisioning and deployment separately. Merge/production publish, production migration/history repair, Retell publication or calls, real mail, provider deletion and actual backup restore are separate actions and remain unauthorized.

No auto-merge, deployment automation or hosted secret installation is part of this candidate. Required checks are not active merely because a YAML file exists; remote runs and repository rules must actually be configured and verified.
