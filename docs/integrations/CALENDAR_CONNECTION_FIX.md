# Google Calendar lifecycle correction

Production diagnosis, 2026-11-23: the disconnected row is revoked history, not an active duplicate. The active Dr. Ahmed Qandil mapping selected `apero.hq@gmail.com`, which Google identifies as primary. Its initial pull had zero attempts: the worker schedule was intentionally held pending acceptance and selection/retry only queued work. No synchronization had succeeded. Do not process that primary mapping.

The account owner has created and authorized the private **Apero Integration Acceptance** calendar. Google lists it as non-primary with owner access; the returned timezone Asia/Riyadh is UTC+03, equivalent to Asia/Kuwait for this acceptance. Preserve historical records and credentials; correct only the unstarted mapping after verifying the returned calendar ID.

## Corrections

- Owner/account-bound preparation serializes repeated OAuth into an existing active connection before encrypting tokens under its ID. Explicit reconnection targets are bound to the OAuth state and cannot cross clinics/accounts. Disconnected history is retained; reconnect creates or reuses one active successor. Other valid mappings remain untouched.
- Identical calendar selections are idempotent. An unstarted selection can be corrected, but established mappings require explicit disconnect. Live leases cannot be overwritten. Unique calendar/practitioner indexes remain in force.
- Selection and retry invoke a worker scoped to the validated connection. Initial sync no longer waits for cron. Scoped/global workers share the same claim/lease logic, and retries cannot reset running work.
- Successful snapshots/retries restore Connected only when freshness and conflict checks pass. A missing optional watch is reported separately and retried later; polling remains authoritative. Five-minute stale/horizon gates and booking exclusion constraints are unchanged.
- The dashboard distinguishes history, pending selection, queued/running sync, Attention and Connected; shows account/calendar/practitioner identity and primary-calendar warnings; prevents overlapping actions and refreshes status. Failed OAuth leaves recovery controls usable.
- Scheduled work is operator-only and pinned to the authorized connection AND non-primary calendar ID. Mapping changes/disconnection cannot redirect the cron into a primary calendar. Vault holds the worker credential; no bearer appears in cron.command.

## Deployment and recovery

Apply only `20261123210000_calendar_connection_lifecycle.sql` after a verified fresh encrypted production restore and compatibility check. Deploy integration-api and integration-worker from the protected merged fix; existing webhook and Retell source do not require redeployment. Publish the same frontend through the existing Lovable project.

Before cron: use only the authorized synthetic calendar for actual initial pull, booking, replay, move/cancel, busy/conflict and refresh acceptance. Confirm included quotas and the $0 cap. Only then install the available pg_net extension, the two named worker Vault settings and the reviewed scoped once/minute cron. Verify real cron responses and advancing last_synced_at before declaring ongoing health.

The backup preflight retains strict schema/job/Vault guards. It permits only the fixed retention job plus the validated scoped integration job, exactly two named/validated Vault settings and the known unlogged pg_net queues. New/unknown schemas, jobs, Vault secrets or persistent net tables still fail closed. With this runtime enabled, `INTEGRATION_RECOVERY_CONFIG` must name a private, verified age-encrypted copy of the actual integration settings; that ciphertext is included and authenticated in the backup. Do not dump decrypted Vault values. Restore transient net queues by reinstalling pg_net, restore integration configuration through the secret manager/Vault, and re-enable only the recorded scoped cron after a fresh sync. No backup service/plan upgrade is required or authorized.

Rollback: pause cron first, restore the captured prior Edge bundles, and use `operations/integrations/rollback-calendar-lifecycle.sql` if required. It restores prior RPC bodies while retaining added metadata, history, ciphertext, outbox and all booking safety predicates/constraints. Do not delete connections or primary-calendar events. Prefer a forward correction if real provider state already changed.

## Regression evidence

Provider/HTTP/crypto tests cover immediate scoped selection, account identity, optional watch failure, token refresh, Google failures/backoff and existing idempotent event mutations. PostgreSQL tests cover reconnect/history/isolation, repeated selection, failed initial sync and stale recovery. Native races cover concurrent OAuth preparation, concurrent selection, duplicate booking and snapshot/booking serialization. Rendered UI checks cover repeated actions, primary warnings, identity/history, failed authorization recovery and role/clinic isolation. Run existing security/Retell regressions and all protected CI checks before deployment. Actual production execution results belong in EXECUTION_STATE.md; this document is not a claim of deployment or real acceptance.

## Live watch startup race

Real acceptance registered a Google watch successfully. Its initial `sync` message (message number1) arrived after registration and invalidated the just-saved snapshot. Google specifies that this message only announces channel startup and can arrive before or after the watch response: https://developers.google.com/workspace/calendar/api/guides/push#sync-message. The focused follow-up migration acknowledges sync/1 without changing freshness or enqueueing another pull. Real exists/not_exists messages still invalidate availability; resource/token/expiry/sequence checks and stale booking gates remain active. The regression exercises both delivery orders, replay, forged identity, invalid sync numbers and a subsequent real change. No Edge or frontend source needs redeployment for this SQL-only correction.
