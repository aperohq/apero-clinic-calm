# Activate Apero's selected AWS/GitHub backup system

2026-10-06. Architecture is unchanged: Supabase managed layer + independent age-encrypted PostgreSQL exports + configuration recovery. User selected AWS S3 Bahrain (`me-south-1`), GitHub Actions hourly execution, and the existing 48-hour/35-day/12-week/12-month retention classes.

**Credential-dependent pause:** Codex can access GitHub, but no AWS login or production DB password exists in this workspace; repository/environment backup secrets/variables are empty. Bucket existence/security is unverified. Do not paste secrets into chat. Configure them in the protected GitHub environment and confirm the non-secret setup is ready; then continue first-backup/drill verification.

## Shortest activation steps

1. In an Apero-owned AWS account, activate **Middle East (Bahrain)** if needed. In IAM → Identity providers, use/create `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`. Identify an existing designated recovery/Identity Center role protected by individual MFA; it must permit `sts:AssumeRole` on the new recovery role. Clinic identities must not have it.
2. In **CloudFormation in me-south-1**, create stack `apero-production-backups` using `operations/aws/production-backups.cloudformation.json`. Supply `GitHubOidcProviderArn` and `RecoveryPrincipalArn`; acknowledge IAM creation. The bucket name is deterministically `apero-production-backups-ACCOUNT_ID-me-south-1`. Read outputs `BucketName`, `BackupWriterRoleArn`, `RecoveryOperatorRoleArn`. Set account-level S3 Block Public Access too. Keep bucket and stack admin permissions outside the writer/recovery roles.
3. Open the already-created GitHub environment **production-backups** (main-only branch policy already configured) and populate the remaining exact values below. Bahrain region, DB port 5432 and DB name postgres are already set. Hourly backups need unattended execution: do not require per-run human approval on this environment. Restrict repo administrators, protect main and workflow/operations files from unreviewed changes. Generate two independent age identities on the custodians' secure machines, put only their public recipients in GitHub, and confirm both can recover their keys.
4. Leave `BACKUPS_ENABLED` unset or `false` during setup. Run **Production database backups** manually on main with `setup_test=true`, then **Retell recovery snapshots** manually with the same explicit override. Require green runs with verified S3 version/read-back markers. Download the first verified database set with the recovery role to an approved encrypted host and run the real isolated drill below. Record evidence and key-custodian confirmation. After configuration and the real drill pass, set the **production-backups** environment variable `BACKUPS_ENABLED` to exactly `true`. Review the next two hourly scheduled runs and the freshness workflow before marking complete.

OIDC customization and main-only environment policy are applied. A real GitHub workflow preflight verified the exact JWT subject/audience on 2026-10-06, then failed as expected at missing AWS configuration before obtaining any AWS/DB access. To reproduce the subject setting from an authorized checkout:

```bash
gh api --method PUT repos/aperohq/apero-clinic-calm/actions/oidc/customization/sub \
  --input operations/aws/github-oidc-subject.json
```

This is repository-wide subject customization; review any future unrelated OIDC integrations before using the same repository. Existing status was default immutable subject, and no existing workflow/backup secrets/variables were found. The new subject avoids mutable repository names for account identity and requires the exact reusable workflow on main:

```text
repository_id:1373129122:ref:refs/heads/main:job_workflow_ref:aperohq/apero-clinic-calm/.github/workflows/_production-backup.yml@refs/heads/main
```

Audience must equal `sts.amazonaws.com`. The template has no wildcard repo/branch/workflow trust. Only the reusable executor can obtain this subject; main write/admin permission is therefore recovery-critical. No permanent AWS access keys are used. [GitHub custom subject requirements](https://docs.github.com/en/actions/reference/security/oidc).

## GitHub environment variables and secrets

GitHub repository Settings → Environments → **production-backups** → Environment variables/secrets. Environment-scoped values are preferred over repository-wide secrets; inherited reusable jobs receive the environment's values.

| Type | Name | Exact purpose |
|---|---|---|
| Variable | `BACKUPS_ENABLED` | Exactly `true` activates scheduled jobs; unset or any other value disables execution |
| Variable | `BACKUP_AWS_REGION` | `me-south-1` |
| Variable | `BACKUP_S3_BUCKET` | CloudFormation `BucketName` output; no URL |
| Variable | `BACKUP_AWS_ROLE_ARN` | `BackupWriterRoleArn` output |
| Variable | `BACKUP_AGE_RECIPIENTS` | Two `age1…` public recipients, one per line; **no private key** |
| Variable | `BACKUP_DB_HOST` | Supabase Connect **session pooler** host, or direct host with runner IPv6 support; not transaction pooler |
| Variable | `BACKUP_DB_PORT` | `5432` for selected session/direct connection |
| Variable | `BACKUP_DB_NAME` | `postgres` |
| Variable | `BACKUP_DB_USER` | Exact Connect user: session pooler normally `postgres.svoybvzvmygszklcmudh`; direct normally `postgres`. Confirm from Connect. |
| Secret | `BACKUP_DB_PASSWORD` | Actual production DB login password, not Supabase access token/service-role key |
| Secret | `BACKUP_DB_CA_CERT` | Trusted database CA certificate PEM from Supabase's connection/SSL settings, validated against selected host; must support `verify-full` |
| Secret | `BACKUP_RETELL_API_KEY` | Production workspace API key for configuration GETs only; replace/partition keys as workspaces grow |

No `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, private age identity, credential URL or patient fixture belongs in GitHub configuration. DB login currently needs full dump/Auth/catalog access. It is invoked with transaction read-only and no patient SQL output; credentials remain privileged outside that session. A future narrowly provisioned dump role must pass the complete Auth/RLS/role export drill before replacing it; do not invent such a role by weakening exports now.

## Bucket, IAM and retention details

CloudFormation defines Block Public Access (all four flags), BucketOwnerEnforced/no ACLs, versioning, SSE-S3 `AES256`, TLS-only, Governance Object Lock and a deny for non-`.age` uploads. Non-writer/recovery identities are denied object retrieval/write/delete, including clinic/dashboard identities even if they later receive broad identity permissions. Account/bucket administrators can change policies and remain privileged; restrict them separately. Bucket is retained on stack deletion/replacement. No website configuration, public URL, shared password or access-key user is created.

Writer policy: only bucket security/lifecycle inspection, prefix-limited listing, encrypted-object `PutObject`/initial retention, `GetObject`/`GetObjectVersion` for read-back. No delete, lock bypass, bucket-policy/encryption/versioning change, IAM or unrelated account privileges. Recovery policy: read/list/version retrieval + controls inspection only; no writes/deletes/config changes. Recovery role trusts the supplied recovery principal, never the GitHub writer; enforce human MFA in that source principal/Identity Center. Revoke individual sessions/source-role entitlement, not shared passwords.

Object keys:

```text
hourly/database/YYYY-MM-DD/RUN_ID/{database.dump.age,roles.sql.age,manifest.json.age,receipt.json.age}
daily/database/YYYY-MM-DD/RUN_ID/…
weekly/database/MONDAY_DATE/RUN_ID/…
monthly/database/YYYY-MM/RUN_ID/…
# Same retention layout with /retell/ instead of /database/:
daily/retell/YYYY-MM-DD/RUN_ID/{retell.json.age,receipt.json.age}
```

One database dump per execution, encrypted once, uploaded under each required class. The first **successful** run of a UTC day/week/month promotes the same ciphertext, so missing the chosen midnight boundary does not omit that period's copy. Weekly periods start Monday UTC; monthly periods start on the first. Manual runs also promote missing periods; immutable UUID run keys and `IfNoneMatch=*` prevent overwrites. Already verified period markers prevent repeat promotion; incomplete sets never count. Workflow concurrency serializes each scope.

| Prefix | Current-version expiration | Initial Governance lock |
|---|---|---|
| `hourly/` | 2 days (at least 48h) | 2 days from upload |
| `daily/` | 35 days | 35 days |
| `weekly/` | 84 days (12 weeks) | 84 days |
| `monthly/` | 366 days (never less than 12 calendar months) | 366 days |

All classes expire noncurrent versions after **one day noncurrent, only after that version's original Object Lock expires**. This prevents early deletion after an overwrite while avoiding another full retention interval after normal expiration. Expired delete markers and incomplete multipart uploads are cleaned. S3 day-based expiration rounds to UTC midnight and deletion is asynchronous; actual deletion may be later, never earlier. Physical retention includes lock/expiry scheduling lag, rather than an exact-to-the-second deletion promise. [S3 lifecycle timing](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html).

Every run verifies bucket region, public-access flags/policy status, versioning, encryption, Object Lock and matching lifecycle rules before exporting. Each PUT supplies SSE-S3, SHA-256, lock and a unique key. Each uploaded version is streamed back and compared by size/hash/metadata/retention; no ETag assumption. Receipts and manifests are encrypted too. Receipt metadata contains only safe timestamp/scope/run ID/hash/state. Hourly receipt is uploaded last after required class verification. Payloads larger than 5 GiB fail with a documented adapter-size gate; add tested multipart support before approaching this threshold, rather than dropping backup coverage.

## Execution, privacy and monitoring

The reusable executor checks `BACKUPS_ENABLED` **before checkout, OIDC, configuration checks, tool installation, AWS authentication or database/Retell access**. Unset, `false`, `True`, whitespace or any value other than exactly `true` produces a clean inactive run for all three workflows. Its log and job summary explicitly say production backups are not yet activated and no backup/freshness verification was performed. No upload, receipt or freshness timestamp is created. A green inactive run is **not** evidence of a successful backup.

Manual dispatch remains available. Its optional `setup_test` checkbox defaults to false; explicitly selecting it permits a real setup/test execution while schedules stay disabled, and genuine execution failures still fail the run. This override is accepted only for `workflow_dispatch`. Once enabled, normal manual dispatch needs no override. To activate, use **Settings → Environments → production-backups → Environment variables → BACKUPS_ENABLED = true**. Repository variables also work if no environment value overrides them; keep one authoritative environment value. To pause execution intentionally, set it to `false`; disabled monitoring does not prove protection or freshness.


- **Production database backups:** `17 * * * *` UTC; manual dispatch on main. Off-minute reduces queue contention. GitHub scheduling can delay; this is not a guaranteed hourly SLA.
- **Retell recovery snapshots:** `37 0 * * *` UTC; manual before/after publish.
- **Backup freshness monitor:** `7,37 * * * *` UTC; fails when the newest verified DB source timestamp is older than **75 minutes**, missing or future-dated. It checks both today's/yesterday's encrypted receipt metadata. Export/upload completion delay counts against freshness/RPO.
- Reusable executor is main-only, scoped to `production-backups`, with 45-minute timeout, immutable action SHAs, read-only checkout credentials and OIDC-only AWS access. No PR trigger, GitHub artifact upload, cache of backup data or patient output.
- PostgreSQL 17 clients use the signed official PGDG repository; runtime boto3/psycopg versions are pinned. Writer's existing schema/Vault/external-job guards remain. Source row counts/structure are captured in the same exported read-only snapshot used by pg_dump, avoiding a false mismatch due to concurrent bookings.
- Permanent public recipients plus a per-job age recipient encrypt the archive. The ephemeral private identity verifies decryption, TOC and full archive decoding, then is destroyed. Custodian keys are never fetched into CI. Only encrypted artifacts reach S3. Temporary credential/key files are in tmpfs; swap/core dumps are disabled, and success/failure cleanup removes staging and identities. GitHub removes the ephemeral VM afterward.
- Operator checks GitHub **Actions → Production database backups**, **Retell recovery snapshots**, and **Backup freshness monitor**; read the job summary (safe UTC/set identifier/checksum result). A green export step without final remote success is not a backup. CLI: `gh run list --repo aperohq/apero-clinic-calm --workflow production-backups.yml --limit 5`.
- `backup_failed`, `backup_integrity_failed`, `backup_upload_verification_failed`, `backup_stale_or_missing` fail the workflow. Safe stage categories distinguish configuration/export/integrity/upload/freshness. Any failure is critical; preserve last-good versions and block destructive releases while protection is stale.
- Enable individual GitHub Actions failure notifications. Named operator/substitute checks at clinic opening and hourly, and after releases. The scheduled watcher shares GitHub's failure domain, so manual checks must detect absent workflows/GitHub outage too. No new paid monitoring vendor.

## Retell publication and recovery assets

Nightly uses active `voice_integrations`, reads both current and published agents, matching versioned flows, tools, KB metadata, secure URLs, voice/language/settings and clinic-specific routing (including transfer/phone config). Only GET configuration endpoints are used; no calls, recordings or transcripts are requested. Integration mappings are encrypted and contain clinic/provider routing, never client/patient tables. Unknown/missing active mapping is a hard failure.

For each publish, run Retell recovery snapshots manually with `publication_stage=before-publication`, wait for success, publish through the existing reviewed process, then run with `after-publication` and verify success. The input labels the GitHub run; timestamps and agent versions inside the encrypted snapshot identify the boundary. There is currently no single repository-owned automated publisher to wrap; temporary deployment scripts must not silently bypass this checklist. No live agent behavior was changed by this task.

KB references/metadata are recoverable; original uploaded document bytes and custom voice audio are still provider-only unless separately escrowed. Preserve approved originals encrypted in the same classified config store through a reviewed asset capture; do not declare recording/voice/document bytes backed up from their URLs alone. Before declaring Retell complete, verify current snapshot and original-document/voice-source custody or approve a documented replacement voice. Do not archive recordings/transcripts under this configuration workflow.

## Key custody

Primary and backup named recovery custodians each generate an independent age identity on an encrypted trusted machine. Encrypt every backup for both public recipients. Store each private identity in an independently accessible, restricted Apero recovery vault or offline encrypted escrow, with individual MFA where applicable. Never put private identities in Git, GitHub secrets/artifacts, or the S3 backup bucket. Custodians validate each key against the first real S3 archive; record only custodian names, verification date and public fingerprints.

If primary is absent, backup custodian retrieves their own key and assumes the designated recovery role. If both keys are lost, backups cannot be recovered. If a key is exposed, replace future recipients, revoke relevant access and retain old identities in restricted escrow until those encrypted sets expire. Re-encryption of retained sets is a separately controlled process; recipient rotation cannot revoke a previously downloaded old ciphertext/key pair.

## Real first-backup and restore drill

After configuration, manually dispatch database backup with `setup_test=true` while schedules remain disabled. It must produce green final remote-success summary and `hourly/database/.../receipt.json.age` with verified source timestamp. Verify bucket controls from AWS and the two recovery custodians' access. Record UTC/set/version/checksum evidence without decrypted contents. Then let two scheduled hourly jobs pass.

On an approved recovery host with encrypted disk, Docker, age and PostgreSQL 17 tool support, disable swap/core dumps. Assume `RecoveryOperatorRoleArn` through individual MFA/Identity Center. Retrieve the **exact verified** database bundle's three ciphertext files into a 0700 directory, not into Git or a cloud-synced home. Credentials remain in the AWS CLI/session provider chain.

```bash
# BUCKET, BUNDLE_PREFIX and RECOVERY_DIRECTORY are non-secret approved locations.
# Download explicit objects; no public links or plaintext export.
aws s3 cp "s3://$BUCKET/$BUNDLE_PREFIX/database.dump.age" "$RECOVERY_DIRECTORY/database.dump.age" --region me-south-1
aws s3 cp "s3://$BUCKET/$BUNDLE_PREFIX/roles.sql.age" "$RECOVERY_DIRECTORY/roles.sql.age" --region me-south-1
aws s3 cp "s3://$BUCKET/$BUNDLE_PREFIX/manifest.json.age" "$RECOVERY_DIRECTORY/manifest.json.age" --region me-south-1
python3 scripts/operations/restore_drill.py \
  --bundle "$RECOVERY_DIRECTORY" \
  --identity "$CUSTODIAN_IDENTITY_FILE" --confirm-isolated-host
```

The drill downloads its PostgreSQL image **before** patient data is introduced, creates a new `drill_admin` database in a disposable container, network `none`, no ports, read-only root and tmpfs data. It has no source DB login/provider secrets. Decryption streams directly into isolated role/schema/data restoration; it never writes SQL/role dumps. Validates same-snapshot row counts/table presence, columns/defaults, constraints, function definitions/ACLs, triggers, RLS/policies, Auth schema/data, appointment/client/staff relationships, unbound-user denial and known-member cross-clinic invisibility. Counts alone do not pass the drill.

The container is destroyed in `finally`; cleanup failure fails the drill. After success remove downloaded ciphertext staging if desired; retain the custodian key securely. For forced termination/host crash, verify no `apero-drill-*` container remains and remove it before considering cleanup complete. If standard PostgreSQL lacks a required Supabase extension/managed object, the drill fails safely; use a reviewed pinned compatible Supabase Postgres image via `--image` and rerun. **No green real drill is claimed until actually executed.** No production connection or production restore exists in this script.

Record real-backup object/version/time/read-back evidence, real-drill aggregate result/duration/cleanup and both key tests in `backups-recovery-evidence.json`. Then re-evaluate every completion gate. Database success alone does not prove bucket/key/Retell custody or managed-backup status.

## Supabase managed backup decision

Rechecked 2026-10-06: `walg_enabled=true`, `pitr_enabled=false`, `backups=[]`, `physical_backup_data={}`. No usable recovery point or plan entitlement proven. Owner checks **Supabase project → Database → Backups → Scheduled backups / Point in Time**, and organization **Billing → Subscription**. Record actual plan, newest/earliest usable point and retention.

PITR is a paid add-on on eligible Pro/Team/Enterprise plans, requiring Small compute or greater; seven-day PITR is approximately $100/month plus any compute upgrade. **DECISION NEEDED** after Owner confirms actual plan/quote; not purchased or enabled. Independent S3 jobs do not depend on PITR. [Supabase backup/PITR capabilities](https://supabase.com/docs/guides/platform/backups).

When the first important production Supabase Storage bucket is introduced, add object-byte exports/version manifests and verify recovery before using it; SQL metadata does not protect deleted bytes. No bucket was created for this task.

## Current activation evidence

[Preflight run 37456410617](https://github.com/aperohq/apero-clinic-calm/actions/runs/37456410617): checkout and real OIDC subject/audience verification passed; AWS configuration check failed because bucket/role values are unset. Tool install, STS and DB/export/upload steps were skipped; cleanup and visible critical failure passed. This validates failure observability and exact OIDC subject, not a functioning production backup. No AWS account/bucket or patient state was accessed.
