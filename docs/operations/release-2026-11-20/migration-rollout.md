# Staging-first migration and integration runbook

This is a reviewable plan, not authorization to operate a hosted database. Batch 2 did not alter any of the nine SQL files; checksums are in `migration-checksums.json`. Both native canonical-schema scenarios applied all 22 migrations, including pg_cron, using PostgreSQL 16.15 and a minimal Auth SQL shim. This does not certify the actual hosted schema or replace the pending managed Supabase CI job.

## Migration review

| Version | Dependencies and existing-database behavior | Security / locking / replay | Recovery |
|---|---|---|---|
| 20260930000000 | Fresh schema only; refuses an existing clinics table. Omits owner, patient and live-integration seeds. Older source scripts remain archival inputs. | Earlier timestamp is intentional. Never execute this file on an established database. It contains legacy transactional segments and is not a general idempotent repair script. | A failed fresh bootstrap is reset only in its disposable local project. Existing-database history reconciliation requires explicit approval. |
| 20261120100000 | Existing profiles/client_notes guard and SET NULL author FK. Replaces only the guard. | FK nulling requires actual author absence; tenant/client restrictions remain. Function replacement is replayable; the version is still applied once. | Retain original function/ACL definitions. Prefer a corrective migration; do not discard historical notes or restore the broken trigger casually. |
| 20261120101000 | Existing voice_requests and current-clinic/role helpers. Adds canonical owner/manager policy. | Column grant remains status-only; both USING and WITH CHECK are clinic/role scoped. Drop/recreate policy is replayable. | Restore captured policy/ACL only if needed to contain a regression; no request data is rewritten. |
| 20261120102000 | Team-management profiles.revoked_at and existing membership helpers. | SECURITY INVOKER permits sessionless revocation only for the profiles table owner and only revocation/timestamp changes. Interactive callers retain membership checks. Verify function and table owners in staging. | Capture prior guard definition and ownership. Disable affected maintenance entry points before any deliberate rollback of this fix. |
| 20261120103000 | Demo table, Auth FK with canonical name, retention lifecycle and provider ledger. | FK replacement/trigger installation take locks. Active demos block deletion; completed rows retain clinic scope and may lose user linkage. Orphaned rows cannot be manipulated by a replacement owner. | Do not restore NOT NULL until orphaned rows are explicitly reconciled. Never delete historical rows merely to make a down migration succeed. |
| 20261120104000 | Shared appointment guard, availability RPCs and exclusion constraints. | Only service-role practitioner changes are added; client, clinic, service, duration, schedule and overlap checks remain. Native race acceptance includes this guard. | Restore captured guard via a corrective migration if required; retain exclusion constraints. No automatic appointment rewrite. |
| 20261120105000 | Shared appointment_available_slots and clinic/staff scheduling configuration. | One RPC with 30-day, 50-practitioner and 12-result limits. Caller clinic is checked and only eligible active staff are searched. Preferred-time results are prioritized before limiting. | Retain RPC while any deployed Edge version uses it. Roll back dependent Edge code before removing or changing the RPC signature. |
| 20261120110000 | Clients table and server role. Adds immutable phone normalization, expression index and service-only lookup. | Clinic prefix on index; query returns at most two matches, so ambiguity cannot pick an arbitrary patient. Ordinary CREATE INDEX takes a write-blocking lock: benchmark duration/size in staging and approve a production window. Country-specific expression indexes need separate review. | Leave the additive index/functions in place while rolling back Edge code. Drop only after all dependent versions are retired. |
| 20261120111000 | Retention view, clock/hold/ledger functions, demo-aware offboarding and appointments table. | Adds maintenance-only preservation date, deletion guard and hold-aware offboarding. Old Booked eligibility uses both end and update age; active work, clinic holds, dry-run and custody gates remain. Existing rows receive a null preservation field; no purge is run by this migration. | Preserve hold data and ledger/custody records. A DDL rollback cannot recover data after an independently approved purge. Do not enable retention as part of deployment. |

Additive CREATE TABLE/COLUMN/FUNCTION/INDEX operations are intentionally versioned once, rather than made silently tolerant of incompatible objects. Reapplying the entire chain manually to an established database is unsupported. Native fresh and upgrade fixtures verify ordering; they do not establish whether a hosted version is already recorded.

## Before approving hosted staging changes

1. Review the Batch 1 prerequisites and Batch 2 commit groups on an isolated integration branch. Do not include unrelated Retell drafts, backup schedules, provider jobs, evidence downloads or `.env`. Do not push the Lovable-connected branch before approval.
2. Run the prepared local/mock, native, Windows and Supabase CI checks. Require `quality`, `regression`, `windows-components`, `native-database`, and `supabase-bootstrap` in branch protection after approved integration. The latter two environment jobs are not substitutes for each other.
3. Capture read-only staging version history and schema metadata, not patient content. At minimum inspect `supabase_migrations.schema_migrations`, `pg_constraint`, `pg_policies`, `pg_proc` owners/ACLs, column grants, schema CREATE privileges and installed extension versions/schemas. Compare the canonical schema at the recorded versions plus reviewed pending changes. Treat missing or custom-named prerequisite FKs/tables/functions as blockers.
4. Verify authenticated/anon cannot CREATE in public or alter sensitive membership fields, and cannot execute retention/offboarding administration. Check function/table ownership for sessionless revocation. Confirm request status-only grants and expected clinic policies.
5. Verify the retention control remains dry-run, and independently check legal holds, provider work and schedules. If cleanup is enabled or the staging database contains real patient data, halt for a separately approved test/data-handling plan. This runbook authorizes no purge, real call or provider deletion.
6. Approve a staging recovery point and capture current guard/policy/function definitions and version checksums. Access to actual backups and any hosted rollback/restore require explicit authorization.

Example read-only metadata queries, run by an authorized operator on the explicitly selected staging database:

```sql
select version from supabase_migrations.schema_migrations order by version;
select extname, extversion, extnamespace::regnamespace from pg_extension;
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' order by tablename, policyname;
select has_schema_privilege('authenticated','public','CREATE') as browser_can_create;
select conname, pg_get_constraintdef(oid)
from pg_constraint where conrelid in
  (to_regclass('public.client_notes'), to_regclass('public.demo_call_sessions'),
   to_regclass('public.appointments'));
```

## Exact order after explicit staging approval

The CI job pins CLI **3.0.0**, creates a new temporary unlinked project and invokes `supabase db reset --no-seed` with no hosted target. CLI v3 defaults to local and uses explicit `--remote` for hosted targets; older target flags were removed or deprecated. See the [official v3 changelog](https://supabase.com/changelog/supabase-cli-v3) and [reset reference](https://supabase.com/docs/reference/cli/supabase-db-reset). Do not copy v2 deployment commands blindly.

1. Confirm the approved staging ref, migration history and schema comparison. Do not use an implicit linked target or copy repository `.temp`/`.env` into the disposable CI project.
2. **Fresh staging:** apply the whole reviewed ordered chain on the explicitly approved empty staging database. **Established staging:** do not execute the fresh baseline. Only after the compatibility review approves the expected schema and all known deltas, reconcile the baseline's history record. An operator may use the following template, but only for the approved staging ref:

   ```sh
   supabase migration repair 20260930000000 --status applied --remote=APPROVED_STAGING_REF --yes
   ```

   If any older migrations are missing or schema drift is unaccounted for, stop. Do not mark other versions applied automatically.
3. Have the operator review pending versions, then apply only the approved pending SQL in ascending order. A reviewed staging command template is:

   ```sh
   supabase db push --remote=APPROVED_STAGING_REF --yes
   ```

   The command must not be run if its pending set includes an unreviewed prerequisite, schedule or unrelated migration. All eight November migrations must follow their older dependencies. Inspect locks and errors after each transaction; do not continue after a failed migration/history check.
4. Verify RLS/grants/owners and service RPC signatures again using synthetic accounts and two staging clinics. Test note-author deletion, sessionless revocation, ledger replay, ended/active demo behavior, request owner/manager/staff/cross-clinic permissions, preservation holds and offboarding. Exercise only mocked provider steps unless separately approved.
5. Deploy the reviewed Edge versions **after** their RPCs exist. `clinic-operations` requires `appointment_search_slots(uuid,uuid[],text,date,integer,time,time,uuid,time)`; `retell-webhook` and legacy `book-appointment` require `clinic_clients_by_phone(uuid,text,text,integer)`. `check-availability` also needs the reviewed duration/service/error-contract code, without a new lookup RPC. Keep existing RPCs during a rollback window.
6. Deploy dashboard changes only after backend checks. Verify background auth failure/recovery/revocation, demo token refresh, profile form preservation, long recording playback/reauthorization and manager Team navigation.
7. Verify Retell handling of `search_timeout` with retry allowed; distinguish it from a genuine calendar outage. Do not republish agents or run paid calls without separate approval. Inventory legacy consumers before any retirement.
8. Obtain a separate production decision only after the complete staging evidence, managed version compatibility and recovery plan are reviewed. No production command is authorized by this document.

## Rollback and compatibility policy

Each November SQL file is transactional. Stop on failure and inspect its recorded version; never re-run history repair as an error workaround. Prefer additive corrective migrations. Capture old definitions/ACLs before changing them; do not write an automatic destructive down migration. Roll back application/Edge consumers first while retaining additive RPCs and indexes. Preserve note history, nullable demo authors, hold fields and deletion ledgers. Never use a database restore to undo a UI regression without a separately approved recovery plan.

The native validation used PostgreSQL 16.15. It is genuine PostgreSQL, not WASM; it still does not certify a different hosted major version or managed Auth service. The Docker-backed Supabase job and native Windows job remain required, unexecuted checks in this environment.
