# Live Google Calendar acceptance

Verified 2026-11-24 UTC against the actual Apero production integration and the owner-authorized private **Apero Integration Acceptance** calendar for **Dr. Ahmed Qandil**. The primary personal calendar was never event-written.

## Root causes and corrections

The original Disconnected record was revoked history. The active, never-synced record selected the primary calendar and had an unprocessed initial pull: selection only queued work while cron correctly awaited acceptance. Repeated authorization inserted new records, repeat selection was not idempotent, and recovered jobs could retain Attention. PR8 serializes account-bound preparation/reconnection, reuses the existing active connection, finalizes calendar/practitioner selection idempotently, launches initial/retry work scoped to the validated connection, preserves leases/history and reports health only after actual synchronization.

Real acceptance then found Google's initial watch sync/1 callback could arrive after registration and invalidate the fresh snapshot. PR9 acknowledges channel startup without treating it as an event change. Real changes still invalidate availability; token/resource/expiry/replay guards and five-minute stale gates remain active.

Final recovery testing found the optional encrypted runtime configuration was copied into the bundle but omitted from manifest checksums. The handoff correction includes all three encrypted artifacts. A reproducing unit test and actual full integrity/restore check now pass.

## Actual production results

- One active Connected mapping to the verified non-primary private calendar; correct practitioner; no pending/dead jobs, connection errors or watch warnings at final audit. Revoked historical record preserved without credentials.
- Initial event snapshot, watch registration, real webhook204 delivery and actual expired-token refresh passed. Automatic scoped polling remained fresh across an overnight pause.
- Book created exactly one stable Google event with generic text and no patient details/attendees. Identical replay did not create another appointment/event; competing slot was rejected409.
- Reschedule updated the same event ID and correct times. Cancellation removed the event; repeat cancellation succeeded safely.
- A synthetic external busy interval removed the slot and blocked booking409. Removing it restored availability. The final future-slot busy/free cycle succeeded through production webhooks/scheduling, with **zero agent worker invocations during observation**.
- Stale availability rejected booking; a successful pull restored it. Safety gates were exercised, not bypassed.
- Cross-clinic key/mapping requests and browser privileged RPC calls were denied. Concurrent scoped workers respected the lease and completed one job.
- All created synthetic event IDs were individually confirmed absent/cancelled. Both temporary acceptance keys were revoked. The cancelled synthetic appointment/client remain as audit history. Nine pre-existing clinical tables matched the pre-release baseline excluding only exact new synthetic IDs.
- API and worker ACTIVE v3; webhook ACTIVE v2; existing other Edge versions unchanged. Owner published the dashboard and confirmed Connected; production assets and browser controls passed verification.

Google lists the private calendar timezone as Asia/Riyadh (UTC+03), matching Asia/Kuwait for this acceptance. A past-slot assertion after a nine-hour pause was corrected to use a fresh future slot; the expected exclusion of elapsed slots was preserved.

## Test and recovery evidence

19 provider/HTTP/crypto tests, 20 database integration scenarios, six native integration races, rendered dashboard controls,133 security tests and existing Retell/booking regressions passed. Native fresh/upgrade/restricted-owner migrations, real pg_cron and synthetic encrypted restore checks passed. PR8/9 and their main merges passed all five protected CI checks. The runtime backup unit suite passed10 tests, including a before/after regression for the missing configuration checksum.

Fresh snapshot checkpoint2026-11-24 06:58:42 UTC is encrypted, snapshot-consistent, fully authenticated and restore-tested.74 tables/747 logical columns/119 functions/28 policies/275 constraints matched, with additional RLS/trigger/index/column-ACL checks. Configuration ciphertext contains the seven actual integration settings and two worker Vault values; restoring them requires the private age identity. Disposable plaintext restored copies were removed.

See EXECUTION_STATE.md for exact source merges, migration ledger identifiers and private recovery location. The operations/docs handoff needs no additional Edge deployment or Lovable publication. All subsequent changes still require the existing five protected checks.

## Boundaries and outcome

The once/minute production schedule is pinned to this exact connection and non-primary calendar; no secret appears in its SQL. Supabase Free included quota was checked before enablement; quota evidence uses bounded measurements and does not claim a full monthly organization usage audit. Unknown backup runtime scope fails closed. Existing retention remains dry_run, Retell functions/configuration are preserved, and booking safety/exclusion constraints remain active.

All requested conditions for the authorized synthetic connection passed. No owner action remains. Future real-clinic/provider rollout, paid operations and destructive changes require separate authorization. Money spent: **$0**.
