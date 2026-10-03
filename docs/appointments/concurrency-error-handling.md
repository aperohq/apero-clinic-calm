# Appointment concurrency error handling

Date: 2026-10-03. Status: **READY FOR PRODUCTION DEPLOYMENT** (local validation;
no deployment or production connection performed).

## Root cause and change

Genuinely simultaneous GiST exclusion checks can choose a deadlock victim with
SQLSTATE `40P01` instead of `23P01`. The database always prevented double
bookings, but dashboard mutations forwarded the raw message and the voice RPC
caught only `exclusion_violation`, resulting in generic Edge `database_error`.

`src/lib/appointment-conflicts.ts` normalizes `23P01` and `40P01` to the existing
guard message, `That time is unavailable. Refresh available slots.` It logs only
the operation label and SQLSTATE and keeps the original error as an internal
cause. Only the appointment INSERT and reschedule UPDATE hooks call it; reads,
verification reads, cancellation and unrelated mutations remain unchanged.
The existing dialog catch clears the selected slot and refreshes availability.

The reviewed shared-availability migration now also replaces the existing
`voice_apply_appointment` with its same per-clinic integration/phone logic,
arguments, JSON return type, SECURITY DEFINER, fixed search_path and service-role
permissions. A flag is set immediately before the protected appointment INSERT
or reschedule UPDATE. The existing exception block returns the existing
`{success:false,error_type:"slot_conflict"}` for a deadlock only when this flag
is set; earlier client/lock errors are rethrown. Journal writes remain outside
that block and propagate normally. PostgreSQL rolls back the block before the
handler returns, including any new client and failed appointment write. Logs
contain the stable operation label/SQLSTATE, without returning SQL diagnostics.

The Edge handler already passes this canonical RPC result through to Retell,
so no handler/routing/credential change was needed. Unclassified errors,
including deadlocks outside the protected write, remain `database_error`.

No automatic retry was added. The surrounding RPC includes patient matching,
call/checked-slot locks and journal/state side effects; expanding transaction
retries is unnecessary to return a safe conflict. The caller can refresh slots
and make a new choice. No public contract, exclusion constraint, availability
predicate, booking guard, RLS policy or clinic reference guard was weakened.

## Acceptance and regressions

The same isolated native PostgreSQL 17.11 cluster was used, with TCP disabled
and two separate writer backends **53651 / 53652** plus a monitor. The migration
was applied only to its disposable database. Test-only barriers pause both
writers after prechecks; recorded transaction-ID waits and invisible
uncommitted appointments prove database exclusion authority.

All **80 collision races** passed (20 per scenario): dashboard/dashboard,
dashboard/voice, voice/voice and reschedule/booking. Each scenario ran ten times
with both old/new exclusions and ten with the new exclusion alone. The runs
reproduced **13 dashboard deadlocks and 8 voice deadlocks**, all normalized to
the expected conflict. Every collision left exactly one active booking, clean
rollback and no duplicate patient. Failed reschedules preserved original times.
Adjacent booking and cancellation/availability/rebook passed in both modes.
Owner, Manager, Staff and cross-clinic acceptance also passed.

Focused tests cover both SQLSTATEs, rollback of newly-created clients,
unchanged failed reschedules, generic internal errors, client/journal deadlocks,
public RPC security/permissions, real dashboard hooks/dialog behavior and the
actual Edge handler's canonical result/generic-error boundary. Migration
compatibility, appointments, voice, isolation, permission and auth suites were
rerun along with TypeScript, production build, targeted lint and diff checking.
All **300 test results passed**, in addition to the 80 native collision races.
TypeScript, production build, targeted lint and `git diff --check` passed. Lint
retained the existing compact store formatting by disabling only its Prettier
rule; other targeted rules and new-file formatting passed. The build retained
its existing `inlineDynamicImports` configuration warning.

Current machine-readable evidence:
[concurrency-acceptance-evidence.json](concurrency-acceptance-evidence.json).
The earlier failing acceptance and evidence are preserved in
[concurrency-acceptance.md](concurrency-acceptance.md).

## Repeat and cleanup

`npm run test:appointment-conflicts` runs the focused local regressions.
`npm run test:appointment-concurrency` uses only the documented disposable Unix
socket/database; it rejects a different data directory and never reads a remote
database URL or production credentials. See the earlier acceptance report for
cluster setup details. It deliberately requires real dashboard and voice
deadlocks to be reproduced before accepting a passing run.

Test instrumentation was removed and all connections closed. The disposable
database and synthetic roles were dropped, and the PostgreSQL server stopped.
Local binaries, logs and evidence remain under `/tmp`. Production data was not
accessed or modified; nothing was deployed or pushed.
