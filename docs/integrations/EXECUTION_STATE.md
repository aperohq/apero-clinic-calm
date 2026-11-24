# Integration execution state

Updated 2026-11-24 UTC. The approved synthetic Google Calendar release is live and acceptance passed. Do not restart development, rerun OAuth, reconnect the primary calendar, or replace the active mapping.

## Live state

- One active **Connected** connection: private **Apero Integration Acceptance**, Google account apero.hq@gmail.com, practitioner **Dr. Ahmed Qandil**. Revoked Disconnected history remains intentionally visible and has no credentials. There is no duplicate active mapping.
- Actual Google initial pull, watch startup/change delivery, access-token refresh, booking, replay, rescheduling, cancellation and external busy/free recovery passed. Automatic once/minute scoped polling continued successfully overnight. No pending/dead jobs at the final audit; freshness is current, and connection/watch errors are null.
- API and worker are ACTIVE **version 3**; google-calendar-webhook remains ACTIVE **version 2**. Existing other Edge Function versions, Retell configuration and clinical records were preserved.
- Lovable publication was performed by the owner, who confirmed **“Published and shows Connected”**. Production UI assets and browser checks verify the focused controls. No further publication action is required for the SQL or recovery-only follow-ups.
- Both temporary acceptance API keys are revoked. All created synthetic Google events are removed/cancelled; no primary-calendar event was written. The cancelled synthetic appointment/client remain as audit history.

## Protected source and migrations

- PR #8: https://github.com/aperohq/apero-clinic-calm/pull/8. Lifecycle commit `220e305`, recovery commit `ce60f0d`, normal merge `4c0f316700f2adf3b6e37965f293966e4472dfaa`.
- PR #9: https://github.com/aperohq/apero-clinic-calm/pull/9. Watch startup correction `120b8c4`, normal merge `3ccb8b36b957617b58f7dbce08ffc9ca5a2a3bb8`.
- All five protected checks passed for both PRs and their main merges: quality, regression, windows-components, native-database and supabase-bootstrap. Protections and admin enforcement remain intact.
- Lifecycle source `20261123210000_calendar_connection_lifecycle.sql` is recorded in production ledger as `20261123205654`; SHA256 `b1eb8f244c81d3479debe3701d7b2b5054bd8049ae787f51cb2ae19b04240b65`.
- Watch source `20261123220000_calendar_watch_initial_ack.sql` is recorded as `20261123211023`; SHA256 `75711126c280649d53adb44953cb670d0d2aa622abc190e455fc52f480c5609e`. Actual function body, grants and owner were verified. Do not reapply a migration solely because the managed ledger timestamp differs from its source filename.
- The final handoff includes the runtime backup manifest correction: all three encrypted artifacts, including integration configuration, receive checksums. Its regression reproduces the previous invalid-manifest failure and passes with the correction. No product redeploy is needed for that operations-only change.

## Recovery and safeguards

Fresh encrypted snapshot checkpoint **2026-11-24 06:58:42 UTC** passed full-stream integrity authentication and actual isolated restoration: 74 tables, 747 logical columns, 119 functions, 28 policies and 275 constraints. Additional comparisons matched 74 RLS flags, 49 triggers, 223 indexes and 37 column ACLs. Managed Auth's two dropped column slots were explicitly accounted for; all logical column order/properties and effective privileges matched. Seven integration settings and two Vault settings are recoverable in separately authenticated ciphertext. No credentials or database row contents are committed.

Private recovery location on the operator host: `/home/nour/apero-production-recovery/integration-20261124T065842Z/`. The existing age identity remains separate under `/home/nour/.local/share/apero-recovery-keys/`; keep it private. Detailed private operator result: `/tmp/apero-calendar-release/final-recovery/production-backup-result.json`. The temporary plaintext restored copies were stopped and removed. Restore with integration flags and cron disabled; reinstate only the recorded scoped mapping after a fresh successful pull and acceptance.

Rollback: first pause the integration cron, retain stale-booking gates, then restore the saved prior Edge bundles and reviewed SQL bodies if needed. Preserve added metadata, connection history, credentials and outbox; never delete production connections to hide history. The existing retention job remains dry_run and both booking exclusion constraints remain intact. See CALENDAR_CONNECTION_FIX.md and RELEASE_RUNBOOK.md for the reviewed procedure.

The worker cron contains only the pinned non-primary connection/calendar IDs. Bearer secrets are stored in Vault. API exposure of net/Vault schemas and browser execution of the secret scheduler were tested and denied; managed Supabase-internal pg_net grants were not weakened or escalated. An unknown schema, cron, Vault setting or durable net table still fails backup preflight closed.

## Resume guidance and remaining scope

No owner action remains for this authorized synthetic connection. Use LIVE_CALENDAR_ACCEPTANCE.md and evidence/calendar-live-release.json as the final acceptance record. If resuming, perform a read-only health check; do not repeat live writes or open a second connection. A future real-clinic rollout, different calendar/provider, paid resource or destructive operation requires its own authorization.

The original checkout has unrelated pre-existing staged/untracked changes; preserve them. Integration corrections were made in isolated worktrees; no published history was rewritten. The final recovery/docs branch uses `/tmp/apero-calendar-handoff` and the existing protected workflow.

Money spent: **$0**. No Retell calls or real-clinic/primary-calendar event writes were made.
