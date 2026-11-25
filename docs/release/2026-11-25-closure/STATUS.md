# Targeted technical closure — 2026-11-25

Production baseline remains `cd858f56cf87269e0bc70e25fceaca0dd8602c98`. Historical acceptance at `7d41243` remains applicable; its 341 scenarios were not repeated.

PR [#12](https://github.com/aperohq/apero-clinic-calm/pull/12) publishes the four existing acceptance commits and backup CI fix. A demonstrated mandatory CI failure (implicit Python text encoding on Windows) was corrected in `ea04185`. All five required checks passed at that exact head: quality, regression, native-database, supabase-bootstrap and windows-components ([run](https://github.com/aperohq/apero-clinic-calm/actions/runs/45613205901)). No protected merge or production deployment has occurred.

| Task  | Closure status | Actual remaining requirement                                                                                                                                                                                               |
| ----- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-031 | BLOCKED        | Grouped approval pending for dedicated hosted synthetic Manager fixtures and generated-content playback. Prepared scripts are not browser acceptance evidence.                                                             |
| T-063 | BLOCKED        | Same approval pending for two isolated hosted synthetic tenants and Manager authorization checks.                                                                                                                          |
| T-064 | BLOCKED        | Same approval pending for the production minimum-password setting and hosted synthetic MFA/recovery/session execution. Invitation/recovery email delivery is TRANSFERRED to the email infrastructure workstream.           |
| T-065 | BLOCKED        | Fix published in protected PR; merge approval pending. Existing authorized storage, credentials and zero-additional-cost confirmation are unavailable. Recurring backups remain disabled; no scheduled backup is claimed.  |
| T-066 | BLOCKED        | Existing isolated restore evidence retained. Fresh operational custody/access and current-production recovery verification require approval plus an accessible authorized backup. Managed API lists no recoverable backup. |
| T-073 | BLOCKED        | Grouped approval pending for the bounded synthetic lifecycle/appointment/session mutations and exact cleanup. No production fixtures have been created.                                                                    |

## New targeted checks

- UTF-8 regression guard: 2/2 PASS; backup CI runtime tests with actual age: 8/8 PASS.
- Both targeted execution scripts pass Node syntax and ESLint checks. Dry-run reports PREPARED_NO_NETWORK. Production policy mode fails closed before network activity when approval is absent. These are preparation/safety checks, not hosted acceptance results.
- Fresh read-only backup/configuration/schema metadata: [backup-current-metadata.json](backup-current-metadata.json). Production-backups has zero secrets, BACKUPS_ENABLED unset, and only region/database-name/port variables. No AWS credentials or configuration are available. Managed-backup API returns an empty backup list; this does not prove operational recoverability.

## Execution boundary

The existing single grouped approval request covers the password policy, five disposable Auth users in two isolated synthetic clinics, hosted MFA/session/lifecycle/appointment checks, exact cleanup, protected merge and approved zero-cost backup setup. It has not been answered. Tool availability or the active goal is not approval. Scripts require a private approval receipt tied to the run and project before any production write.

After approval, the exact password setting is Supabase project `svoybvzvmygszklcmudh` → Authentication → Email provider → Minimum password length → **8** → Save, or the approved Management API PATCH `/v1/projects/svoybvzvmygszklcmudh/config/auth` with only `{"password_min_length":8}`. Verification must include an actual server rejection of a seven-character synthetic password.

For backups, the founder/infrastructure custodian must identify the existing authorized S3 bucket and OIDC writer role, confirm existing storage allowance/no additional spending, and install the missing protected `production-backups` values: BACKUP_S3_BUCKET, BACKUP_AWS_ROLE_ARN, BACKUP_AGE_RECIPIENTS, BACKUP_DB_HOST and BACKUP_DB_USER; plus secrets BACKUP_DB_PASSWORD, BACKUP_DB_CA_CERT and BACKUP_INTEGRATION_RECOVERY_JSON. Existing region/database/port values also need confirmation against that destination. Recovery requires separately accessible age identity custody and restore authorization. Only then enable BACKUPS_ENABLED=true, run the existing database workflow, and verify encrypted object/checksum/freshness followed by isolated recovery. Do not install provider credentials or operate excluded provider workflows as part of this closure.

T-072, T-075, email infrastructure/delivery, Retell/provider recording retrieval and external engineer responsibilities remain TRANSFERRED. Generated WAV playback covers the published player only; it cannot establish provider retrieval success.

New-goal safety totals: money spent 0; production writes 0; external service writes limited to GitHub branch/PR/CI publication; production deployments 0; real customer/patient records accessed 0; Retell operations 0. Recommendation: **NOT READY** until the mandatory hosted acceptance, password enforcement and operational backup/recovery requirements are verified.
