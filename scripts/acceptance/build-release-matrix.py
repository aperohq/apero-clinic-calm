"""Assemble executed evidence and explicit acceptance gaps; never infer a test pass."""
import csv
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKET = ROOT / 'docs/release/2026-11-24'
EVIDENCE = PACKET / 'evidence'
rows = json.loads((EVIDENCE / 'account-scenarios.json').read_text())


def add(sid, tasks, requirement, priority, environment, preconditions, expected, actual, status, evidence, dependency=''):
    rows.append(dict(scenario_id=sid, roadmap_task_ids=tasks.split(','), requirement=requirement,
                     priority=priority, environment=environment, preconditions=preconditions,
                     expected_outcome=expected, actual_outcome=actual, status=status,
                     evidence_reference=evidence, remaining_dependency=dependency or None))


for filename, prefix, env in [('browser-results.json', 'UI', 'Isolated Chromium / actual components, synthetic Auth/database'),
                              ('browser-production-public.json', 'PUBLIC', 'Production Chromium / fresh anonymous context')]:
    result = json.loads((EVIDENCE / filename).read_text())
    assert not result.get('fatal') and not result['errors'], filename
    for index, check in enumerate(result['tests'], 1):
        assert check['status'] in ['PASS', 'FAIL']
        add(f'{prefix}-{index:03}', 'T-031,T-073', check['id'], 'P1', env,
            'Main cd858f5; network guard active; fixtures admitted for local execution; no business writes',
            'Expected navigation/data/control behavior and bounded viewport geometry',
            json.dumps(check, ensure_ascii=False), check['status'], 'evidence/' + filename)

superseded_harness_assertions = []
focus_path = EVIDENCE / 'browser-hosted-logout-focus.json'
focus = json.loads(focus_path.read_text()) if focus_path.exists() else None
for filename, prefix in [('browser-hosted-results.json', 'HOSTED'), ('browser-hosted-logout-focus.json', 'LOGOUT')]:
    hosted_path = EVIDENCE / filename
    if not hosted_path.exists():
        continue
    result = json.loads(hosted_path.read_text())
    assert result.get('finished_at') and not result['page_errors'], filename
    for index, check in enumerate(result['tests'], 1):
        if (filename == 'browser-hosted-results.json' and check['status'] == 'FAIL'
                and check['id'].startswith('HOSTED-LOGOUT:') and focus
                and any(t['id'] == check['id'] and t['status'] == 'PASS' for t in focus['tests'])):
            superseded_harness_assertions.append({'id': check['id'], 'reason': 'Premature DOM count before login hydration; corrected focused runtime check passed', 'original_evidence': filename, 'replacement': focus_path.name})
            continue
        add(f'{prefix}-{index:03}', 'T-031,T-063,T-064,T-073', check['id'], 'P1',
            'Production Chromium / existing admitted synthetic Owner or Staff',
            'Exact closed-world fixture admission; hosted sign-in; no provider/business writes',
            check.get('expected', 'Role-appropriate route/data behavior and no document overflow'),
            json.dumps(check, ensure_ascii=False), check['status'], 'evidence/' + filename,
            check.get('dependency', '') if check['status'] == 'PASS' else 'Investigate actual hosted check failure; never infer a pass')

mfa_path = EVIDENCE / 'mfa-runtime.json'
if mfa_path.exists():
    mfa = json.loads(mfa_path.read_text())
    assert mfa['status'] == 'PASS' and mfa.get('finished_at') and len(mfa['tests']) == 21
    for check in mfa['tests']:
        add(check['id'], 'T-064,T-073', 'Actual standalone Auth protocol: ' + check['id'], 'P1',
            'Native Auth v2.198.0 / actual disposable PostgreSQL / no-egress namespace',
            'Official checksum-verified binary;77 Auth migrations; invented identity and factors only',
            'Provider enrollment/challenge/AAL/recovery restrictions and isolation behave as specified',
            json.dumps(check), check['status'], 'evidence/mfa-runtime.json',
            'Standalone provider acceptance; hosted Apero UI/factor changes and real-owner recovery remain separate')
    cleanup = mfa['cleanup']
    assert all(cleanup[key] for key in ['synthetic_user_deleted','auth_process_stopped','auth_pid_absent','private_tmpfs_removed','postgresql_stopped','postgresql_socket_removed','synthetic_cluster_removed'])
    assert all(value == 0 for value in cleanup['remaining'].values())
    add('MFA-CLEANUP', 'T-064', 'Actual isolated MFA fixture cleanup', 'P1',
        'Disposable native Auth/PostgreSQL fixture', 'Completed actual protocol checks',
        'Zero identities/factors/sessions; stopped processes and removed tmpfs/socket',
        json.dumps(cleanup), 'PASS', 'evidence/mfa-runtime.json')

for filename in ['recovery-rollback.txt', 'recovery-runtime.txt']:
    result = json.loads((EVIDENCE / filename).read_text())
    for check in result['results']:
        add(check['scenario'], 'T-077', 'Isolated rollback/recovery: ' + check['scenario'], 'P1',
            'Disposable local source/config/native DB or compiled runtime',
            'Main cd858f5; synthetic inputs only; controlled damaged artifact or transaction',
            'Restore compatible artifact/transaction and preserve security boundaries',
            json.dumps(check), check['status'], 'evidence/' + filename)

cases = [
('BACKUP-SCHEDULE','T-065','Recurring backups execute and verify fresh protected artifacts','P1','GitHub production-backups environment','Existing schedule; read-only variables/secrets/job inspection','Actual export/encrypt/upload/read-back and freshness','BACKUPS_ENABLED unset; execution skipped; no environment secrets','BLOCKED','recovery.md','F-03: approved configuration, runtime input, credentials/custody/cost allowance and observed scheduled runs'),
('BACKUP-SAFETY','T-065','Disabled/missing/stale/tampered prerequisites fail closed','P1','Local Python synthetic subprocess/storage','Existing isolated test suites','Unsafe export, upload, scope, TLS, receipt and restore prerequisites rejected','29 original safety tests plus8 focused CI regressions passed (37/37); genuine dual-recipient age verification','PASS','recovery.md',''),
('BACKUP-CI-INPUT','T-065','CI materializes reviewed integration recovery envelope for custodian and temporary verifier','P1','Local synthetic CI plus genuine age encryption','No DB/AWS/provider calls; reviewed v1 JSON and separate generated identities','Valid input reaches archive verifier; missing/invalid input fails; no plaintext files/log secrets','Reproduced original private_path_required; fixed missing plumbing;8 targeted and37 combined tests passed; local commit3e5fc52 not installed','PASS','evidence/recovery-ci-fix-summary.json','Protected publication/current approved settings/credentials still needed before operation'),
('BACKUP-INTEGRITY','T-066','Existing authorized ciphertext retains integrity/private permissions','P1','Existing encrypted artifacts, no new decrypt/copy','Historical checkpoint18:05 UTC; three recorded files','All sizes/hashes match','Three matching private ciphertexts independently rehashed','PASS','evidence/recovery-historical-verification.json',''),
('BACKUP-HISTORICAL-RESTORE','T-066','Existing genuine restore evidence remains valid at its recorded scope','P1','Historical isolated PG17.12 / tmpfs','Authorized pre-onboarding checkpoint18:05 UTC','Compatible restored data/catalog/ACL; no active network','74 tables/747 columns/119 functions; full verification3.09s; encrypted inputs authenticated; tmpfs cleanup','PASS','evidence/recovery-historical-verification.json','Does not establish current checkpoint freshness, custody or hosted cutover RTO'),
('BACKUP-CURRENT-SCHEMA','T-066,T-024','Current schema encrypted backup/restore compatibility','P1','Isolated native PostgreSQL16.15','Fresh, upgrade, restricted-owner modes; synthetic Arabic data','33 migrations and actual encrypted restores preserve schema/data/RLS/constraints','Three modes and two btree_gist placement restores passed; cleanup complete','PASS','evidence/native-migrations.json','PG16 synthetic compatibility, not new production PG17 checkpoint'),
('BACKUP-CUSTODY','T-065,T-066','Independent recoverability and approved RPO/RTO','P1','Operational approval','Existing sole-operator checkpoint','Independent accessible custodian/offsite set and agreed recovery objectives','Independent custody and operational RPO/RTO not demonstrated','BLOCKED','recovery.md','F-03/F-07: founder and recovery custodian'),
('AUTH-POLICY','T-064','Hosted password minimum agrees with eight-character application requirement','P1','Production read-only config and historical direct-policy acceptance','No account/config mutation','Server rejects passwords below8','Fresh password_min_length6; historical six-character acceptance unresolved','FAIL','evidence/production-metadata.json','F-01: narrow approved policy change and controlled retest'),
('AUTH-MAIL','T-064,T-073','Production invitation/recovery transport operational','P1','Production metadata and historical delivery attempt','No new emails sent','Approved synthetic invite/recovery delivered and accepted','Custom SMTP absent; historical invitation502; current real delivery not attempted','BLOCKED','release-gates.md','F-02: external mail setup and authorized disposable recipient'),
('AUTH-NATURAL-EXPIRY','T-064','Actual elapsed hosted JWT expiry and recovery behavior','P1','Hosted Auth','Designated expiring synthetic session','Expired token cannot restore protected access','Malformed/expired-token local/historical checks exist; no natural3600s expiry observation in current run','UNVERIFIED','account-security.md','Controlled hosted expiry observation; no production policy shortening'),
('SEC-HOSTED-MANAGER','T-063,T-073','Real-JWT Manager allow/deny and cross-clinic behavior','P1','Production Auth/API/browser','Existing approved Manager credentials required','Permitted operations work; account/settings/foreign operations denied','Native two-clinic Manager runtime and historical SQL-claims pass; no usable approved Manager browser fixture','BLOCKED','account-security.md','F-04: designated synthetic Manager access; no implicit role change'),
('SEC-HOSTED-MUTATIONS','T-024,T-063,T-064,T-073','Controlled live retained-session lifecycle and appointment writes','P1','Production Auth/PostgREST','Approved exact disposable mutation manifest without providers/notifications','Own allowed mutations persist; forbidden mutations fail; revoked/suspended retained sessions denied','Current native runtime passed; no new production membership/appointment/factor writes authorized','BLOCKED','account-security.md','F-04: exact hosted mutation approval and cleanup'),
('REC-PRODUCTION-ROLLBACK','T-077','Actual hosted rollback/cutover','P1','Production Lovable/Supabase','Separate incident/deployment approval','Approved target restored and hosted authentication/tenants verified','No production rollback performed; isolated compiled frontend/Edge/native/config rehearsals passed','NOT APPLICABLE','recovery.md','Actual production rollback is neither authorized nor required merely to rehearse; hosted cutover remains unverified'),
('REL-GITHUB','T-076','Actual main/PR/required checks match release baseline','P1','GitHub read-only API','Current repo/PR11','Exact main cd858f5, merged PR11, eight PR and five required main checks green','Authoritative metadata matches','PASS','deployment-inventory.md',''),
('REL-DATABASE','T-024,T-076','Exact five onboarding source texts deployed; current grants safe','P0','Production metadata-only SQL','Read-only ledger/catalog access','Five SHA256 values match main; selected grants/RLS deny unauthorized roles','All five exact source hashes match; ten tables RLS and anonymous table/column denied;13 RPC/profile grants verified','PASS','evidence/production-schema-comparison.json','Catalog checks are not hosted write acceptance'),
('REL-FRONTEND','T-076','Published frontend artifact continuity and provenance','P1','Public serving + historical founder attestation','Accepted published Account/Team route chunks','Current accepted routes remain byte-identical; publication attribution retained','Both lazy route hashes match; Login and ten entry assets200; exact SHA founder-attested','PASS','evidence/published-route-continuity.json','No independent server Git-SHA attestation; not full-build byte equivalence'),
('REL-EDGE','T-076','Relevant deployed API/Calendar/account Edge versions recorded','P1','Production Management metadata','Read-only function inventory','ACTIVE versions and bundle digests reconciled','API3/worker3/Google webhook2; manage10/provision13/recording10; current digests recorded','PASS','evidence/production-metadata.json','Not a complete deployed source-file byte comparison'),
('REL-CONFIG-EQUIVALENCE','T-076','All private runtime settings byte-equivalent to approved baseline','P1','Restricted production configuration','Secret-safe comparison authority','All relevant configured values independently match approved source','Public target/Auth allowlist/versions and all7 integration secret names verified (explicit digest field absent); prior sanitized record has no per-setting baseline digests; full private values not exported or independently compared','UNVERIFIED','deployment-inventory.md','Release-owner restricted configuration attestation/comparison during approved change; never export values'),
('INTEGRATION-REUSE','T-073,T-076','Prior live API/Google Calendar acceptance remains applicable','P1','Historical actual dedicated-calendar live run','Same deployed API3/worker3/webhook2','Booking/replay/conflict/move/cancel/busy-free/refresh/isolation pass','Historical actual live acceptance retained; versions match; new lifecycle boundaries passed isolated tests','PASS','../../integrations/evidence/calendar-live-release.json','No new external Calendar writes; current provider event contents not inspected'),
('E2E-LOCAL-REUSE','T-073','Existing real browser→SDK→native lifecycle E2E evidence applies','P1','Historical isolated Chromium/Supabase SDK/native PostgreSQL','27 historical source hashes match current baseline','Real panels/SDK/RPC persisted role/revoke/restore/readiness and denied foreign/suspended claims','Historical integrated evidence retained; all27 source fingerprints match main','PASS','evidence/historical-source-continuity.json','Auth issuance/transport synthetic; no hosted mutation claim'),
('LIVE-HISTORICAL','T-031,T-063,T-064,T-073','Existing bounded signed-JWT Owner/Staff live acceptance remains applicable','P1','Historical actual published browser and hosted Auth','Three admitted synthetic identities, two clinics; same accepted route artifacts','Valid login,15 cross-clinic read denials, role restrictions, account/dialog/readiness/calendar display','50 primary+9 follow-up assertions passed; current Account/Team hashes identical; counts reused not newly executed','PASS','evidence/historical-live-acceptance.json','Manager, MFA challenge/recovery and committed production mutations were outside that historical scope'),
('RECORDING-PROVIDER','T-031,T-073','Successful safe hosted recording playback and expiry','P1','External media integration','Identified existing authorized synthetic provider media','Authorized playback works and expires; foreign access denied','UI denial/error and column protection passed; no safe provider media accessed','BLOCKED','dashboard.md','External engineer supplies existing authorized synthetic playback acceptance; no calls/Retell operations in this assignment'),
('ACT-PRODUCTION-CLEANUP','T-035,T-072','Existing production synthetic fixture cleanup approved and verified','P2','Production exact candidate list','Founder-approved IDs/counts/hold and reference review','Delete only approved candidates; preserve other clinic/audit/holds','Cleanup procedure prepared; existing production fixtures preserved; no deletion authorized','BLOCKED','activation-cleanup.md','F-08: exact candidate approval and authorized transaction'),
('UAT-REPRESENTATIVE','T-075','Genuine clinic representative acceptance and Apero signature','P1','Clinic representative UAT','Named testers and approved isolated environment','Actual outcome/pass-fail/feedback recorded; genuine signatures','17 execution-ready role scenarios and signature fields prepared; not executed by representative','BLOCKED','UAT.md','F-05: clinic representatives and release owner'),
('FREEZE-PACKET','T-074,T-078,T-079','Matrix, P0/P1 register, freeze criteria and final packet prepared','P1','Repository documentation','Executed evidence reconciled with all15 assigned IDs','Traceable statuses and genuine dependencies; no unsupported release signoff','Prepared; independent work indexed; unresolved gates explicit','PASS','README.md;release-gates.md;matrix.csv','Founder final release/activation decision remains separate'),
]
for case in cases:
    add(*case)

expiry_path = EVIDENCE / 'hosted-session-expiry.json'
if expiry_path.exists():
    expiry = json.loads(expiry_path.read_text())
    completed = expiry.get('phase') == 'passed' and expiry.get('finished_at') and expiry.get('cleanup', {}).get('http') == 204 and expiry.get('cleanup', {}).get('refresh_rejected')
    entry = next(row for row in rows if row['scenario_id'] == 'AUTH-NATURAL-EXPIRY')
    if completed:
        assert len(expiry['checks']) == 5 and all(check['status'] == 'PASS' for check in expiry['checks'])
        entry.update(status='PASS', actual_outcome='Actual unchanged3600s JWT expired naturally; access401, refresh200 and own-clinic recovery200; local logout204 and captured refresh rejected', evidence_reference='evidence/hosted-session-expiry.json', remaining_dependency=None)
        for check in expiry['checks']:
            add(check['id'], 'T-064,T-073', 'Hosted natural session expiry: ' + check['id'], 'P1',
                'Production hosted Auth/PostgREST / existing admitted synthetic Owner',
                'Actual3600s expiry elapsed; no policy/account/provider changes',
                'Correct identity/lifetime, allowed before expiry, denied after expiry, normal refresh and same-clinic recovery',
                json.dumps(check), check['status'], 'evidence/hosted-session-expiry.json')
    elif expiry.get('phase') == 'failed':
        entry.update(status='FAIL', actual_outcome=json.dumps({'phase':expiry['phase'], 'checks':expiry['checks'], 'cleanup':expiry.get('cleanup')}), evidence_reference='evidence/hosted-session-expiry.json', remaining_dependency='Investigate actual expiry/recovery or harness failure before release')
    else:
        entry.update(actual_outcome='Active bounded real expiry test; expected probe ' + expiry.get('expected_probe_at', 'pending'), evidence_reference='evidence/hosted-session-expiry.json', remaining_dependency='Running test must finish; no founder action or production policy change needed')

ids = [row['scenario_id'] for row in rows]
assert len(ids) == len(set(ids)), 'Duplicate scenario ID'
statuses = {'PASS', 'FAIL', 'UNVERIFIED', 'BLOCKED', 'NOT APPLICABLE'}
assert all(row['status'] in statuses for row in rows)
tasks = {task for row in rows for task in row['roadmap_task_ids']}
expected_tasks = {'T-024','T-031','T-035','T-063','T-064','T-065','T-066','T-072','T-073','T-074','T-075','T-076','T-077','T-078','T-079'}
assert tasks == expected_tasks, tasks
for row in rows:
    assert all(row[key] for key in ['scenario_id','requirement','priority','environment','preconditions','expected_outcome','actual_outcome','status','evidence_reference'])
    if row['status'] != 'PASS':
        assert row['remaining_dependency'], row['scenario_id']
(PACKET / 'matrix.json').write_text(json.dumps(rows, indent=2, ensure_ascii=False) + '\n')
with (PACKET / 'matrix.csv').open('w', newline='') as stream:
    writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    for row in rows:
        writer.writerow({**row, 'roadmap_task_ids': ','.join(row['roadmap_task_ids'])})
counts = dict(Counter(row['status'] for row in rows))
(EVIDENCE / 'matrix-validation.json').write_text(json.dumps({'rows': len(rows), 'statuses': counts,
    'assigned_tasks': sorted(tasks), 'unique_ids': True, 'all_required_fields_present': True,
    'superseded_harness_assertions': superseded_harness_assertions,
    'note': 'Matrix rows include grouped acceptance, individual browser assertions, historical evidence and gaps. They are not additive unit-test counts.'}, indent=2) + '\n')
print(json.dumps({'rows': len(rows), 'statuses': counts, 'task_ids': len(tasks)}))
