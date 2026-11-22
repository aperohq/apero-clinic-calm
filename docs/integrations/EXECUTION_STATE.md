# Resume state

Updated 2026-11-22. Active implementation worktree: `/tmp/apero-integrations-worktree`, branch `feat/integration-system`, based on protected `origin/main` `ab7fc81711e9c66c45ae35f9b5d9efa5c51b7734`. The original `/home/nour/apero-clinic-calm` checkout contains substantial pre-existing changes and early integration copies; do not commit or overwrite its unrelated changes. Resume engineering in the isolated worktree. No history was rewritten.

## Completed implementation

Comprehensive execution prompt and all fourteen roadmap entries are tracked. New integration migration, clinic key lifecycle, API, Google OAuth/token lifecycle, calendar selection, synchronization/outbox, webhook/poll recovery, conflicts, reusable adapters, dashboard, auditing/retention/offboarding, tests and release documentation are implemented. Google/worker frontend and backend release switches default off. No scheduler was enabled. Retell source and live configuration are unchanged.

## Validation

- `test:integrations`: 17 provider/HTTP/crypto tests, 17 real PostgreSQL/WASM security/behavior scenarios and rendered React controls.
- Native integration races: duplicate idempotency, competing bookings, snapshot-before-booking and booking-before-snapshot all pass.
- Original native appointment race acceptance passed.
- Full native migration chain passed fresh, existing-upgrade and restricted-owner modes; pg_cron and encrypted synthetic restore passed in public/extension schema layouts.
- TypeScript, integration handler typecheck, lint and production build passed. The final enabled-flag production build also passed.
- Chromium with synthetic data and production CSS passed 320/375/768/1440 widths; screenshots/results under `evidence/`.
- The full release run passed 27 of 28 suites; its sole Account lifecycle fixture failure (new unmocked Supabase import) was corrected. The entire targeted stabilization suite then passed, including the Account lifecycle and demo offboarding tests. Combined local evidence covers all 28 suites. The post-fix hosted regression check must still pass at the pushed SHA.

## GitHub / deployment state

Implementation commit: `0bd9a868fdd00acf10c7816ef8d526c8cbbbb24a`. PR: https://github.com/aperohq/apero-clinic-calm/pull/6. All five protected hosted checks passed at that implementation SHA: quality, regression, windows-components, native-database and supabase-bootstrap. Exact links are in `evidence/github-source-ci.json`. This documentation-only follow-up records the source validation; the protected workflow must also pass at the final PR head before an ordinary merge.

Repository public; no repository webhooks; admin enforcement and strict required checks remain enabled. No security check, protection or history was bypassed. GitHub feature push/PR ran only synthetic CI on standard free public runners. Source merge is authorized by the user's execution directive and is separate from production publication: release switches default off, no migration/function deployment or scheduler runs from these PR/main application checks, and Lovable publication is a separate action. Production backup/retention/recovery schedules were not modified.

## Resume without repeating engineering

Read PR #6's current state once. If it is merged, skip completed implementation, tests and GitHub work and proceed only with the external release prerequisites. If it remains open, finish its current required checks, resolve any genuine failure and merge normally after green checks, without bypasses or history rewrites. Final CI on documentation commit `5a3dfd0` exposed an unrelated default-port collision starting the local Supabase Inbucket container (host port 54324 already occupied). The bootstrap harness now allocates distinct available host ports for every numeric port setting; all services, managed migrations, Auth, exclusion and real cron checks remain enabled. Two allocator contract tests cover service preservation, duplicates and failure bounds. This CI harness correction must pass the current required checks before merging.

The implementation and acceptance package are complete locally; do not restart the roadmap or repeat completed investigations. The original checkout's copy of this state can contain a newer final merge result after this committed evidence snapshot.

Production migration, three new function deployments, server secret installation, feature activation, worker scheduling, real Google consent and clinic/provider acceptance remain unperformed. The exact consolidated external prerequisites are in APPROVALS_REQUIRED.md and the validated sequence is in RELEASE_RUNBOOK.md. A named clinic software connector remains blocked on provider/account identification; the reusable adapter infrastructure is implemented.

No Google credentials or real accounts were used. No live appointment, provider, Retell, database migration or secret installation occurred. Money spent: $0.
