# Shared appointment migration compatibility fixes

Local proposal, 2026-10-02. No deployment, production connection, or production
appointment mutation was performed. The public RPC signatures and application
code are unchanged by these compatibility fixes.

## Operator preflight and installation

Run `db/audits/appointment_readiness.sql` separately with operator access. It uses
an explicit read-only transaction and reports appointment IDs, clinic and staff
IDs, conflicting pairs, invalid intervals, cancellation spelling variants,
unsupported reschedule durations, references, timezone settings, constraints,
indexes, policies, triggers and function permissions. It contains no cleanup.

The migration repeats blocking data checks under an appointments table lock,
before persistent structural changes, in the same transaction as installation.
Noncanonical cancellation spellings, non-cancelled reversed/non-finite intervals,
and positive overlapping non-cancelled appointments abort installation with
record IDs in the PostgreSQL error detail. An operator must review blockers
separately; the migration never chooses which appointment to cancel or repairs
times. Cancelled overlaps and cancelled reversed intervals do not block the
constraint. Zero-length ranges are empty for the exclusion constraint.

Arrange a maintenance window: `ACCESS EXCLUSIVE` blocks appointment reads and
writes until commit or rollback. A failed statement aborts the transaction;
issue `ROLLBACK` before retrying on a session left in the aborted state. Do not
execute fragments or omit the opening `BEGIN` / closing `COMMIT`. A read-only
preflight alone does not prove the deployed schema matches the repository or
replace hosted acceptance, including multi-session concurrent booking tests.

## Compatibility behavior

- Authorized cancellation and metadata-only updates preserve all protected
  identity and time fields, even for malformed historical intervals. New
  bookings and reschedules still require finite positive intervals. Invalid
  legacy times cannot be repaired through ordinary appointment updates.
- Whole-minute legacy reschedules preserve their exact elapsed duration,
  independently of the configured creation duration. Fractional-minute,
  sub-minute and over-24-hour legacy durations fail with SQLSTATE `22023`
  before returning slots. No duration or historical row is rewritten. There
  is no canonical per-service duration column; none is added here.
- Staff/client foreign-key `ON DELETE SET NULL` remains intact. The guard
  accepts only nested nulling after the referenced record has disappeared,
  with every other appointment field unchanged apart from `updated_at`.
  Existing checked voice slots can independently restrict staff deletion;
  those restrictions remain in force. Historical appointments are retained.
- A same-named overlap constraint must match PostgreSQL's generated expected
  definition, exclusion operators, target table, GiST index and index validity
  metadata. A mismatch aborts without dropping it. An exact match is reusable.
- The final nondeferrable GiST exclusion uses clinic, practitioner and
  `tstzrange(start_time,end_time,'[)')`, excluding exactly `Cancelled`. It remains
  the database authority for dashboard, voice and reschedule writes, including
  races past availability checks. No RLS or existing voice RPC is replaced.

## Local regression coverage

`npm run test:appointment-migration` exercises rollback/data preservation,
preflight blockers and record IDs, cancelled history, status variants,
Owner/Manager/Staff safe legacy updates and rejection of protected-field changes,
exact and unsupported durations, normal creation/rescheduling, staff/client
deletion contracts, retained voice restrictions, incompatible constraint
definitions, repeat installation, and database exclusion independent of the
schedule trigger. Concurrent submissions use PGlite's single connection; a
real multi-session hosted concurrency acceptance check remains necessary.
