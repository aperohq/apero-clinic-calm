"""Read-only verification of exact synthetic IDs after approved hosted cleanup."""
import datetime
import json
import uuid
import urllib.request
from pathlib import Path

PRIVATE = Path('/tmp/apero-technical-closure/private')
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/release/2026-11-25-closure'
REF = 'svoybvzvmygszklcmudh'
ids = json.loads((PRIVATE / 'exact-cleanup-ids.json').read_text(encoding='utf-8'))
approval = json.loads((PRIVATE.parent / 'approval.json').read_text(encoding='utf-8'))
assert approval['approved'] and approval['actions']['hosted_synthetic']
assert approval['run_id'] == ids['run_id'] and approval['target_project'] == REF
assert json.loads((OUT / 'cleanup-result.json').read_text(encoding='utf-8'))['status'] == 'COMPLETE'
assert not (PRIVATE / 'fixtures.json').exists(), 'Private fixture credentials must be removed'


def sql_id(value):
    return "'" + str(uuid.UUID(value)) + "'::uuid"


clinics = ','.join(sql_id(v) for v in ids['clinics'].values())
users = ','.join(sql_id(a['auth_user_id']) for a in ids['accounts'])
predicates = {
    'clinics': ('public.clinics', f'id in ({clinics})'),
    'profiles': ('public.profiles', f'clinic_id in ({clinics}) or auth_user_id in ({users})'),
    'practitioners': ('public.staff', f'clinic_id in ({clinics})'),
    'clients': ('public.clients', f'clinic_id in ({clinics})'),
    'appointments': ('public.appointments', f'clinic_id in ({clinics})'),
    'conversations': ('public.conversations', f'clinic_id in ({clinics})'),
    'onboarding_payloads': ('public.clinic_onboarding', f'clinic_id in ({clinics})'),
    'calendar_connections': ('public.calendar_connections', f'clinic_id in ({clinics})'),
    'integration_credentials': ('public.integration_keys', f'clinic_id in ({clinics})'),
    'auth_users': ('auth.users', f'id in ({users})'),
    'auth_sessions': ('auth.sessions', f'user_id in ({users})'),
    'mfa_factors': ('auth.mfa_factors', f'user_id in ({users})'),
}
parts = [f"'{name}',(select count(*) from {table} where {where})"
         for name, (table, where) in predicates.items()]
query = 'select json_build_object(' + ','.join(parts) + ") as remaining, " + (
    f"(select count(*) from public.clinic_onboarding_audit where clinic_id in ({clinics}) "
    "and event='provisioned') as provisioned_audits"
)
token = (Path.home() / '.supabase/access-token').read_text(encoding='utf-8').strip()
req = urllib.request.Request(
    f'https://api.supabase.com/v1/projects/{REF}/database/query/read-only',
    data=json.dumps({'query': query}).encode('utf-8'),
    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    method='POST')
with urllib.request.urlopen(req, timeout=30) as response:
    rows = json.loads(response.read())
assert len(rows) == 1
row = rows[0]
passed = all(v == 0 for v in row['remaining'].values()) and row['provisioned_audits'] == 2
result = {
    'run_id': ids['run_id'], 'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status': 'COMPLETE' if passed else 'FAIL', 'remaining': row['remaining'],
    'identifier_only_provisioned_audits_preserved': row['provisioned_audits'],
    'private_fixture_credentials_removed': True, 'production_writes': 0,
    'patient_record_fields_read': 0,
}
(OUT / 'cleanup-verification.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result))
assert passed, 'Exact synthetic cleanup incomplete'
