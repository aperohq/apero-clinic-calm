# Appointments / Calendar audit and local hardening

Date: 2026-10-02. Status: **BUILT LOCALLY — NEEDS PRODUCTION ACCEPTANCE**.

The subsequent migration safety fixes and operator instructions are recorded in
[migration-compatibility-fixes.md](migration-compatibility-fixes.md).

Scope: the existing weekly Calendar and Appointment Details dialog. No calendar
library, Day/Month view, separate appointment table, patient table, or parallel
booking engine was introduced. No deployment, push, hosted database write, or
production appointment modification was performed. Existing uncommitted work
in this workspace was retained. This report describes repository code and local
PostgreSQL/browser tests; it does not certify today's deployed schema or flow.

## 1. What already worked

`src/routes/calendar.tsx` renders `CalendarPage` through the existing `RouteShell`.
The page already queried Supabase appointments, clients, and staff; provided a
Sunday–Saturday week, previous/next/Today, staff filter, cards, empty state,
New Appointment, details, reschedule, and cancellation confirmation. These
were real CRUD operations, not placeholder buttons. Mutations invalidated
appointment queries and verified saved records. The clinic-time helpers
already converted local inputs to UTC and formatted stored instants in the
clinic timezone. The details dialog already linked the correct client and
practitioner and showed service, start time, and status.

`db/01_phase2_schema.sql` supplies appointments, clients, staff, staff service
arrays, weekly availability, clinic timezone, RLS, timestamp update triggers,
and cross-clinic reference guards. `db/06_staff_scheduling.sql` adds staff time
off and composite clinic/staff foreign keys. Existing role and privilege
migrations secure deployed owner/manager/staff operations. These policies
were preserved.

## 2. What was incomplete or unsafe

| Existing action | Before this task | Local result |
| --- | --- | --- |
| Calendar load | All appointments in one capped response; no refresh while open | Week overlap query, paged reads, automatic refresh |
| Card placement | Whole-hour row regardless of minutes | Exact local minute position |
| Duration/overlap | One row regardless of duration; cards obscured each other | Duration height and overlap columns; legacy overnight splitting |
| Loading/error | Imperative query-state reads could miss an error transition | Subscribed query-cache status, reliable retry |
| New appointment | Free-text service/time, frontend default 45 minutes, direct insert | Existing client, supported service, backend-returned slot/duration |
| Reschedule | Direct time update with no schedule/time-off guard | Shared slots and database validation, same ID/relationships/duration |
| Cancel | Real status update and confirmation, but overwrote existing notes | Retained notes, optional appended reason, concurrent-edit check |
| AI/dashboard rules | Same records, but independent slot-generation paths | Active AI handler and dashboard call one availability RPC |
| Concurrent booking | Repository SQL lacked an overlap exclusion constraint | Proposed exclusion constraint is the final database boundary |

The absence of a dashboard schedule/time-off write guard is demonstrable in
the original SQL and mutations: dashboard writes never called the voice RPC
or checked staff schedules. Existing reference isolation solved a different
problem and was left intact.

## 3. Files changed for this task

- `src/components/clinic-pages.tsx`: existing Calendar/dialog and query-state subscription.
- `src/lib/apero-store.ts`: week/paged queries, slot hook, guarded CRUD, invalidation and saved-row verification.
- `src/lib/calendar-layout.ts`: week dates, minute positions, duration, overnight segments, overlap lanes.
- `src/lib/clinic-time.ts`: valid clinic day boundaries when DST skips midnight.
- `src/lib/db-types.ts`: typed shared availability RPC.
- `supabase/functions/clinic-operations/index.ts`: shared slot RPC, signed duration, preserved integration/call authentication.
- `supabase/migrations/20261002190000_shared_appointment_availability.sql`: proposed non-destructive database rules.
- `tests/appointments.test.mjs`: real PostgreSQL booking/availability/security tests.
- `tests/calendar-ui.test.tsx`, `tests/run-calendar-tests.mjs`: local browser flow tests using real data hooks/SDK.
- `tests/helpers/clinic-database.mjs`: optional proposed migration and local GiST extension support.
- `tests/run-clinic-permission-tests.mjs`: reusable local Calendar HTTP fixtures and browser globals; existing permission tests still pass.
- `retell/master/tests/edge-isolation.test.mjs`: restored current handler dependency bindings and added shared-RPC/signed-duration coverage.
- `package.json`: `test:appointments` script; prior script changes retained.
- `db/audits/appointment_readiness.sql`: read-only production acceptance inventory, tested locally.
- `docs/appointments/production-hardening-report.md`: this report.

The other modified/untracked files present at the start were not task changes.

## 4. Calendar fixes

The existing layout, navigation, filter, white/black visual structure, modal,
card color rules, and horizontal mobile scroll remain. Cards use their clinic
minute positions and real durations; overlapping cards receive separate
columns and remain clickable. Bookings before/after ordinary working hours
extend the existing vertical grid. Legacy overnight appointments are split
across clinic dates, including appointments starting before the viewed week.
The repeated DST hour cannot make a valid same-day appointment disappear;
card height uses elapsed duration. The existing wall-clock grid does not add
a second repeated-hour axis.

The calendar queries intervals overlapping the selected clinic week, not UTC
calendar dates. Pagination avoids the default one-response row cap. Previous,
next, and Today change the backend window. Today highlighting and the current
week recompute when the clinic date changes. Empty, pending, error and retry
states are covered. The existing accessible horizontal scroll region and
mobile hint are retained; real-device visual acceptance remains required.

## 5. New appointment

The existing dialog selects an existing clinic client, active practitioner,
service from that practitioner's existing `staff.services`, clinic date, and
server-returned slot. There is no frontend slot generator or free-form time
entry. Slot duration comes from the clinic's existing active voice integration
`slot_minutes`, with the existing 45-minute fallback when none is configured.
Services do not have a separate duration schema, so no service-duration model
was invented. A successful save verifies the stored record, invalidates
appointments/slots, and opens the calendar week containing the booking.

## 6. Reschedule

Discovery excludes only an existing Booked appointment in the requested clinic
with the same practitioner/service and derives its original duration. The
mutation updates that appointment's timestamps only. The database guard
preserves ID, clinic, client, practitioner, service and elapsed duration. Failed
moves leave the original intact. Cancelled records are not silently rebooked.
The existing voice path also passes through that guard; moving to another
practitioner/service is consequently rejected. Availability includes weekly
hours, active staff, service support, time off, and conflicts.

## 7. Cancellation

The existing confirmation stage is retained. Cancellation updates status to
`Cancelled`; it never deletes an appointment or its client. A reason appends
to existing notes; an empty reason preserves them. The update compares the
last `updated_at` to avoid overwriting a concurrent notes edit. Saved status
and notes are verified. Cancelled cards are excluded from Calendar, while the
appointment record remains available to existing history views. Both shared
availability and the exclusion constraint exclude Cancelled records, reopening
the slot. Cancellation cannot also alter the appointment's time/relationships.

## 8. AI receptionist → Calendar

Repository production flow artifacts (`retell/dental-zone-flow.json` and
`retell/acceptance/published-v2.json`) point appointment tools to
`clinic-operations`. The path is:

`verified Retell integration/signature → call ownership → shared availability
RPC → signed/persisted checked slot → voice_apply_appointment →
public.appointments → Calendar's clinic-scoped query`.

The existing `voice_apply_appointment` implementation from `db/05` is retained.
Its patient verification, checked-slot ownership, idempotency and audit records
remain. A local PostgreSQL test calls the real voice RPC, verifies the existing
client ID and `Booked by Apero` source in `appointments`, and reads that row
under a dashboard user's RLS. Browser tests display an AI-source appointment.
Calendar polls every 30 seconds and refreshes on normal query focus behavior;
this is automatic visibility, not a new realtime subscription.

## 9. Dashboard → shared booking system

`existing AppointmentDialog → appointment_available_slots → existing
appointments INSERT/UPDATE under browser JWT/RLS → shared database guard and
exclusion constraint → AI's shared availability RPC`.

A PostgreSQL test creates a dashboard booking, reads the identical row as the
AI service role, proves its slot is unavailable to AI discovery, then proves
cancellation reopens it. The actual signed Edge slot adapter is tested to call
the same clinic/staff/service/date RPC and sign the returned duration. No second
booking table was introduced. `voice_checked_slots` and `voice_operations` are
existing authorization/audit tables, not another appointment source.

Legacy `check-availability` / `book-appointment` functions also read/write
`appointments`, use clinic timezone, and exclude Cancelled conflicts. They are
not referenced by the checked production flow artifacts and were not rewritten.
Their inserts would also receive the new shared database guard. Confirm actual
live tool routing during acceptance; legacy endpoint activation requires its
own compatibility check rather than assuming it is the active flow.

## 10. Client linkage

Dashboard booking uses the chosen existing client ID and inserts no client row.
Clinic reference guards and the new write guard verify that relationship.
AI retains the existing clinic-scoped, case-insensitive trimmed name plus
normalized local-phone-suffix matching using the integration's dialing prefix
and local number length. The test uses a formatted existing phone and canonical
AI phone, proving reuse of the existing client. Matching does not merge people
by phone alone. Historical duplicate patients or ambiguous same-name/same-phone
records are not consolidated; production acceptance should check those cases.

## 11. Availability behavior

The shared invoker RPC uses actual clinic timezone, practitioner services and
active state, weekly shifts, time off, overlapping appointments and original
reschedule duration. Its first slot retains the existing half-hour rounding,
then uses the configured duration cadence. Existing bookings of any status
other than Cancelled block overlaps, retaining current business semantics.
A final write guard rechecks discovery conditions; an exclusion constraint
protects concurrent appointment overlaps independently of the guard. The
clinic-scope check applies even when callers supply another clinic ID. Browser
roles cannot read private voice configuration: a scoped definer helper returns
only the configured booking duration. No configuration permissions were added.

No cross-midnight working-shift feature was invented. New bookings must fit one
existing same-day shift; legacy overnight rows remain visible in the calendar.
Changes to staff schedules/time off still use their existing module and policies.
The booking transaction validates the schedule visible at write time; simultaneous
schedule edits and booking writes need live PostgreSQL acceptance.

## 12. Timezone behavior

`clinics.timezone` is the source of truth. Database discovery returns UTC
`timestamptz` instants and real elapsed duration. Dashboard submits those instants
unchanged; it does not reconstruct them from the displayed label. AI signs the
start and duration and the existing checked-slot RPC verifies the full interval.
Calendar/date details format those same instants in the clinic timezone. Week
queries use valid local day boundaries, including skipped DST midnight.

Tests cover Kuwait local/UTC placement, another clinic timezone, nonexistent
DST local input, a repeated DST hour, skipped midnight, and exact elapsed slot
duration. On ambiguous DST hours the RPC offers a specific UTC instant; the
user's selected value carries that instant. A separate repeated-hour calendar
axis was not added. Browser timezone cannot change the persisted selection.

## 13. Permissions

Owner, Manager and Staff retain normal appointment read/create/update/cancel/
reschedule capabilities through deployed membership-based RLS. These are
verified using SET ROLE and signed-user claims in real local PostgreSQL and
role refreshes in the browser. Existing configuration privileges remain
unchanged. The voice mutation RPC remains service-role-only. Shared availability
is invoker/RLS-secured; anonymous EXECUTE is denied.

## 14. Cross-clinic isolation

Existing appointment RLS, cross-clinic relationship triggers, foreign keys,
voice integration resolution, call ownership and checked-slot constraints were
preserved. All three dashboard roles reject foreign appointment reads, updates,
cancellation and rescheduling; foreign clinic creation, client, practitioner,
service and reschedule exclusion requests are rejected. Local migration reruns
preserve the full RLS policy inventory. This verifies repository SQL, not
uninspected policies or additional objects in the hosted database.

## 15. Tests/results

| Check | Result |
| --- | --- |
| `npm run test:appointments` PostgreSQL suite | 18 passed |
| Calendar browser/data-hook suite | 16 passed |
| `npm run test:auth` | 29 passed |
| `npm run test:permissions` | 14 passed |
| `npm run test:permissions:ui` | 9 passed |
| `npm run test:security` | 133 passed |
| Actual Edge handler isolation/RPC adapter | 8 passed |
| Voice logic / call ownership / timing / resolution / routing | 8 / 3 / 3 / 3 / 5 passed |
| `npx tsc --noEmit` | Passed |
| `npm run build` | Passed |
| Targeted ESLint | 0 errors; existing Fast Refresh warning in clinic-pages |
| `git diff --check` | Passed |

249 test results passed across these suites. Targeted ESLint included the
changed TS/TSX implementation and browser tests, with `prettier/prettier` disabled
to preserve the existing compact source style. New test/helper files were
formatted. No production credentials or network are used by the tests.

Database tests execute actual SQL, RLS and functions in ephemeral PGlite
PostgreSQL. The browser suite uses the real Supabase SDK and data hooks against
local HTTP fixtures. Edge tests execute the handler with local adapters; the
new slot contract test uses a UTC formatting shim. These are not a substitute
for a Deno/Supabase gateway test with real Luxon or concurrent hosted sessions.
The concurrency boundary is verified by an exclusion-constraint test with the
schedule trigger disabled locally; true parallel transactions remain a live
acceptance requirement.

## 16. Migration and why

The single proposed migration
`20261002190000_shared_appointment_availability.sql` supplies the demonstrated
missing shared slot API and database booking guard, plus an atomic GiST overlap
constraint. It adds functions, a trigger, an extension if needed, and a
constraint to the existing appointments table. It changes no RLS expressions,
creates no booking table, deletes no rows, and rewrites no product records.
It is idempotent and tested locally. The exclusion constraint intentionally
fails if legacy conflicting ranges exist; those records must be reviewed
separately. Deployment may require a maintenance window for constraint/index
creation. The read-only readiness inventory helps compare existing deployed
constraints and avoid assumptions about a repository-only schema.

No completed/no-show action was added: appointment status is a plain text
column, and the audited appointment paths use Booked and Cancelled. The
Completed badge elsewhere also serves conversations; it is not evidence of
a canonical appointment transition. Live status inventory is required before
introducing another appointment action. Existing historical text statuses are
not rewritten.

## 17. Still needs live production acceptance

1. Run the read-only readiness inventory; compare deployed functions, RLS,
   grants, statuses, timezones and existing overlap constraints with repository
   assumptions. Check invalid/overlapping legacy intervals before migration.
2. Separately review/authorize migration and coordinated frontend/Edge release;
   the local frontend and updated Edge availability require the shared RPC.
   Existing unexpired old signed tokens remain readable; new tokens carry duration.
3. Use designated acceptance accounts/fixtures for Owner, Manager and Staff
   and two clinics. Verify direct API read/mutation/reference rejection under
   their actual JWTs and gateway behavior.
4. Make an actual Retell booking and observe the same appointment/client in
   Calendar; make a dashboard booking and confirm AI availability excludes it.
   Validate reschedule and confirmed cancellation in both directions.
5. Run genuinely concurrent booking attempts and concurrent schedule/time-off
   changes in hosted PostgreSQL. Confirm one slot cannot be double-booked and
   review migration locking/performance with real clinic volume.
6. Check actual clinic timezone on browser devices, DST where applicable,
   formatted phone matching and ambiguous historical patient records.
7. Inspect real desktop and narrow/mobile rendering, short/long/overlapping
   cards, scroll accessibility and modal controls. Local DOM tests do not
   certify browser layout or visual appearance.

No acceptance calls, patient cleanup, deployment or production mutations were
performed as part of this task.

## 18. Final status

**BUILT LOCALLY — NEEDS PRODUCTION ACCEPTANCE**.
