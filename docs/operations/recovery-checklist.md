# Recovery operator checklist

Use [the full runbook](backups-and-recovery.md) and [existing monitoring](dental-zone-monitoring.md). **Current status: not launch-ready; no verified production recovery point/offsite set.** No incident command here authorizes an unreviewed production restore.

## Activate the selected system

Follow [AWS/GitHub setup](aws-github-backup-setup.md): deploy Bahrain CloudFormation bucket/roles, configure remaining protected environment values, verify two recovery keys, run database + Retell workflows, then execute the real isolated restore drill. GitHub environment/main-only policy and OIDC claim customization are configured; AWS/DB/key inputs are still missing. Do not mark complete from template/tests alone.

## Before opening / hourly while operating

- Named Apero recovery lead and substitute assigned; both can reach platform settings and restricted backup receipts, and one can reach independent recovery keys.
- Managed recovery point/window verified, PITR status known, independent final remote success within 75 minutes. Confirm scheduler/watcher are running, not just absence of errors.
- Check GitHub Actions → Production database backups / Retell recovery snapshots / Backup freshness monitor; final remote-success summary and source timestamp must be current. Check export, hash/decryption/archive verification, upload/read-back and last full restore drill. Writer success alone is insufficient. First missing/failed check is critical.
- No planned migration/config release without a verified fresh backup and pre-change config capture.
- If failed/stale: open incident, retain last good set, stop destructive releases, notify named Apero technical lead through established human process. No patient values in notes.

## Incident: stop → select → isolate → validate → approve → cut over

1. Record UTC discovery, affected clinic IDs/systems, last good release, suspect interval and lead/second approver. Secure compromised accounts if applicable.
2. Contain affected writes and automated intake using existing downtime/direct-clinic fallback; stop deploys and drain in-flight calls. Preserve damaged state; do not reset/delete/replay seeds or requests.
3. Select A small deletion / B corruption or bad migration / C database loss / D project loss / E Retell loss / F bad deployment in the full runbook. Identify earliest bad write.
4. Select backup before damage; record source time, set ID/hash/scope and expected data loss. If source/project is gone, use independent encrypted copy. If none exists, escalate to provider/support; do not invent successful recovery.
5. Recover only to isolated compatible environment first: encrypted disk, restricted people, blocked external egress, no production SMTP/carrier/provider secrets or paid calls. Verify both checksums, age decryption/authentication and archive decoding.
6. Restore reviewed role/schema/data/Auth/history subset; match platform versions/extensions. Stop on any restore error. For hosted Auth/Storage/roles collisions, use validated TOC/vendor-supported migration procedure; never ignore all errors.
7. Validate tables/counts, types, RPCs, triggers, policies/grants, constraints/FKs, Auth IDs/profile membership, two-clinic RLS, login/invitation/redirects, schedules/booking conflicts, follow-ups/idempotency and integrations. Record counts/booleans only. Reconcile lost interval with authorized clinic records.
8. Small deletion: review exact clinic/key-scoped repair against current data and newer bookings. Full recovery: approve tested restore/cutover with explicit rollback plan. Bad deployment: redeploy tested last-good release; only restore DB if data was damaged.
9. Two Apero approvers sign off recovery point, test results and loss. Freeze writes for cutover; update hosting/Edge/project/Retell bindings consistently, rotate/reissue keys and reauthenticate as needed. Keep telephone intake off until checks pass.
10. Verify staff access, booking/calendar and Open Requests, signed routing/auth denial checks, recording authorization and two clean five-minute monitoring windows. Do not replay all historical webhooks or booking requests.
11. Reopen clinic operations deliberately; record RPO/RTO actually achieved, remaining loss/repair owners. Remove recovered patient copies, revoke temporary accounts/keys, retain incident-selected backups only with expiry. Improve runbook after review.

## Project-loss essentials

- Independent DB/Auth/history/role archive and private age identity.
- Last-good Git source/lockfile/function bundles; seven functions and their actual `verify_jwt=false` + internal guards.
- New compatible Supabase project in approved region; Auth/SMTP/redirect/security/settings, keys, extensions/publications, future Storage bytes/policies.
- Separately escrowed custom secrets; replace built-in project keys/URLs.
- New hosting env and all Retell tool/webhook URLs/mappings; isolated full acceptance before cutover.
- Do not run seed-bearing `db/01_phase2_schema.sql` or reconcile migration history blindly.

## Retell-loss essentials

- Exact encrypted current/published snapshots, approved original KB document and custom voice source/replacement, clinic-specific mappings/secrets.
- Rebuild inactive draft agents/flows/KB, reapply language/voice/tools/webhooks and signed URL opt-in + **1,060,000 ms** expiry.
- Verify transfers and webhook events; keep per-clinic transfer enablement at its approved value.
- Test synthetic tools/tenant isolation, review/publish, then reconnect authorized telephony. Current Retell number inventory is empty.
- Config restoration does not recover provider-only recording bytes; follow existing patient-data policy.

## Retell publication gate

Run `retell-recovery.yml` manually on main with before-publication; wait for verified S3 success. Publish through the existing reviewed deployment process. Run again with after-publication and confirm version/receipt. Preserve original approved KB and voice assets separately; never snapshot recordings/transcripts as configuration.
