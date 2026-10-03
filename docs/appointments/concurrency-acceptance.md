# Multi-session appointment concurrency acceptance

Date: 2026-10-03. Verdict: **STILL NEEDS CHANGES**.

This is the historical acceptance before the error-handling fix. The passing
follow-up is recorded in [concurrency-error-handling.md](concurrency-error-handling.md).

No production connection, production data access, production migration, code
deployment, or push occurred during this acceptance. The reviewed migration
and application code were not modified. Changes are the repeatable acceptance
harness and this report/evidence.

## Environment and proof

No configured non-production staging database or installed PostgreSQL server
was found. Official checksum-verified PostgreSQL 17.11 binaries were extracted
under `/tmp/apero-concurrency-postgres`. The disposable database was named
`apero_concurrency_acceptance`. PostgreSQL listened only on a private Unix
socket, with TCP disabled. This matches production's PostgreSQL major version;
production's reported minor version was 17.6.

`tests/appointments-concurrency.test.mjs` connects only to this hardcoded Unix
socket/database and verifies the server data directory before creating fixtures.
It never reads production credentials or accepts a remote connection URL. The
repository prerequisites, reviewed migration, real RLS roles and synthetic
clinics/patients were installed only in this disposable database. Supabase Auth
claims were locally shimmed; appointment SQL, RPCs, indexes and transactions
ran in native PostgreSQL, without query mocks or PGlite.

The completed matrix used writer backend IDs **53103 / 53104** and independent
monitor backend **53098**. A test-only BEFORE trigger, ordered after the booking
guard, paused both writers after their unchanged availability checks. Releasing
the shared barrier let both sessions reach the exclusion indexes concurrently.
`pg_stat_activity` / `pg_blocking_pids` captured transaction-ID waits between the
writers. Availability still reported the slot free while the winning booking
was uncommitted. This proves the failure came from the database exclusion,
rather than a later availability pre-check.

The production preflight's old `appointments_no_staff_overlap` definition was
recreated from its metadata, without copying production rows. Each collision
scenario ran three times with both old/new constraints, then three times with
only the new constraint: **24 collision races**. Adjacent booking and cancel /
rebook scenarios ran in each constraint mode. Additional real PostgreSQL checks
verified Owner, Manager and Staff load/create/reschedule/cancel, shared slots,
existing patient linkage, voice permissions and cross-clinic rejection.

## Results

| Scenario | Database integrity | Application-facing acceptance |
| --- | --- | --- |
| Dashboard vs dashboard | PASS; exactly one booking | FAIL; an earlier probe exposed SQLSTATE `40P01` |
| Dashboard vs voice | PASS; exactly one booking in all six completed races | PASS; competing dashboard received `23P01` |
| Voice vs voice | PASS; exactly one booking | FAIL; two of six completed races surfaced `40P01` instead of `slot_conflict` |
| Reschedule vs booking | PASS; exactly one destination booking; failed moves preserve original times | FAIL; two of six completed races surfaced `40P01` |
| Adjacent dashboard / voice bookings | PASS; both succeed in both modes | PASS |
| Cancel / availability / voice rebook | PASS; history retained, slot reopened, new booking succeeds | PASS |

Every completed collision left exactly one active appointment at the contested
slot, no double bookings, no duplicate clients and a usable losing connection
after rollback. Failed voice operations left no success/idempotency record and
preserved their checked-slot state. The final database contained no idle or
aborted transactions. Role and isolation checks passed for all three roles.

Ordinary collisions produce dashboard SQLSTATE `23P01` or the voice RPC's
`{success:false,error_type:"slot_conflict"}`. Truly simultaneous exclusion-index
checks can instead deadlock: PostgreSQL selects a victim with SQLSTATE `40P01`,
releases its writes, and allows its peer to succeed. Server logs explicitly
identify the exclusion-check context. This occurred with both constraints and
with the new constraint alone, so the old/new definitions do not conflict
incorrectly. Adjacency and cancellation predicates also agree in both modes.

## Required follow-up

Preserve the exclusion constraint. Add focused handling for the observed
`40P01` path without changing public contracts or weakening isolation:

- The current `voice_apply_appointment` catches `exclusion_violation` only.
  Deadlock victims escape that handler; the Edge booking caller currently maps
  RPC errors to generic `database_error`. Normalize this collision/retry path
  safely, or use a bounded whole-operation retry with existing idempotency.
- Dashboard mutations currently throw the database error without specific
  deadlock classification. Provide an understandable retry/conflict response
  after rollback rather than exposing a raw deadlock message.
- Add regressions and rerun this genuine multi-session matrix. Earlier safety
  and read-only data preflight results do not cover this newly observed path.

This is an error-handling acceptance gap; database double-booking protection,
canonical cancellation, existing RPC success contracts and isolation passed.
No application or migration fix was silently applied as part of acceptance.

## Cleanup and evidence

The test-only gate trigger/function were removed, all connections closed, the
disposable database and synthetic roles dropped, and PostgreSQL stopped. Its
socket and PID file are absent. Downloaded binaries, local logs and evidence
remain under `/tmp`; there is no running server or retained test database.

Machine-readable completed results are in
[concurrency-acceptance-before-fix.json](concurrency-acceptance-before-fix.json).
The reviewed migration SHA-256 remained
`397542358ba162ce11d48f0c15c06b4efca4ea3ed45b0c65077e472026a23b51`.

To repeat, initialize/start PostgreSQL 17 with the same local path, Unix socket,
port `55437`, user `nour`, and disposable database name, then run
`node tests/appointments-concurrency.test.mjs`. A fresh cluster/database is
required. The suite intentionally exits nonzero when the deadlock response
gap is reproduced. Always drop the disposable database and stop the server
after collecting evidence.
