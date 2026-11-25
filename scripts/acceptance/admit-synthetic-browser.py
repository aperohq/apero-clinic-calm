"""Metadata-only closed-world admission for existing authorized browser fixtures."""
import datetime
import json
import os
import sys
import urllib.request
import uuid
from pathlib import Path

fixture_path = Path(os.environ.get('APERO_SYNTHETIC_FIXTURE_MANIFEST', '/tmp/apero-integration-release/private/synthetic-fixtures.json'))
fixture = json.loads(fixture_path.read_text())
assert fixture['fixtures_ready'] is True
quote_id = lambda value: "'" + str(uuid.UUID(value)) + "'::uuid"
clinic = quote_id(fixture['clinic_a'])
client = quote_id(fixture['client_a'])
practitioner = quote_id(fixture['staff_a'])
accounts = [a for a in fixture['accounts'] if a['clinic_id'] == fixture['clinic_a']]
assert sorted(a['role'] for a in accounts) == ['owner', 'staff']
users = ','.join(quote_id(a['auth_user_id']) for a in accounts)
query = f"""select json_build_object(
 'clinic_present',(select count(*)=1 from public.clinics where id={clinic}),
 'clients_match_manifest',(select count(*)=1 and count(*) filter(where id<>{client})=0 from public.clients where clinic_id={clinic}),
 'practitioners_match_manifest',(select count(*)=1 and count(*) filter(where id<>{practitioner})=0 from public.staff where clinic_id={clinic}),
 'members_match_manifest',(select count(*)=2 and count(*) filter(where auth_user_id not in ({users}) or revoked_at is not null)=0 from public.profiles where clinic_id={clinic}),
 'active_auth_matches',(select count(*)=2 from auth.users where id in ({users}) and deleted_at is null and (banned_until is null or banned_until<now())),
 'appointments_only_manifest_references',not exists(select 1 from public.appointments where clinic_id={clinic} and (client_id is distinct from {client} or staff_id is distinct from {practitioner})),
 'conversations_empty',not exists(select 1 from public.conversations where clinic_id={clinic}),
 'requests_empty',not exists(select 1 from public.voice_requests where clinic_id={clinic}),
 'notes_empty',not exists(select 1 from public.client_notes where clinic_id={clinic}),
 'notifications_empty',not exists(select 1 from public.notifications where clinic_id={clinic})
) as admission"""
if '--query-only' in sys.argv:
    print(query)
    raise SystemExit(0)
token = (Path.home() / '.supabase/access-token').read_text().strip()
request = urllib.request.Request('https://api.supabase.com/v1/projects/svoybvzvmygszklcmudh/database/query/read-only',
    data=json.dumps({'query': query}).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
with urllib.request.urlopen(request, timeout=35) as response:
    checks = json.load(response)[0]['admission']
result = {'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'scope': 'Existing private manifest exact clinic/client/practitioner/Auth ID allowlists; metadata booleans only, no clinical fields read/exported',
          'checks': checks, 'admitted': all(checks.values()), 'production_business_writes': 0}
out = Path('docs/release/2026-11-24/evidence/browser-hosted-fixture-admission.json')
out.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
