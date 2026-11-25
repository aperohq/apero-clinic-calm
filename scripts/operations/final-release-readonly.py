"""Bounded release metadata only. No account/data writes or full config exports."""
import datetime
import hashlib
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/release/2026-11-24/evidence'
OUT.mkdir(parents=True, exist_ok=True)
REF = 'svoybvzvmygszklcmudh'


def request(url, token=None):
    headers = {'User-Agent': 'Apero-readonly-release-verification'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=35) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, b'', {}


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + '\n')


observed = datetime.datetime.now(datetime.timezone.utc).isoformat()
token_path = Path.home() / '.supabase/access-token'
metadata = {'observed_at': observed, 'production_writes': 0}
if token_path.exists():
    token = token_path.read_text().strip()
    status, body, _ = request('https://api.supabase.com/v1/projects/' + REF + '/config/auth', token)
    metadata['auth_config_http'] = status
    if status == 200:
        config = json.loads(body)
        allowed = ['site_url', 'uri_allow_list', 'disable_signup', 'external_email_enabled',
                   'mailer_autoconfirm', 'password_min_length', 'password_required_characters',
                   'security_refresh_token_rotation_enabled', 'security_refresh_token_reuse_interval',
                   'jwt_exp', 'mfa_totp_enroll_enabled', 'mfa_totp_verify_enabled',
                   'mfa_max_enrolled_factors', 'sessions_timebox', 'sessions_inactivity_timeout',
                   'sessions_single_per_user', 'security_captcha_enabled']
        metadata['auth_policy'] = {key: config.get(key) for key in allowed}
        metadata['custom_smtp_configured'] = bool(config.get('smtp_host'))
        metadata['password_hibp_enabled'] = config.get('password_hibp_enabled')
    status, body, _ = request('https://api.supabase.com/v1/projects/' + REF + '/functions', token)
    metadata['functions_http'] = status
    if status == 200:
        allowed = {'integration-api', 'integration-worker', 'google-calendar-webhook',
                   'manage-clinic-users', 'provision-clinic-user', 'recording-access'}
        metadata['functions'] = [{key: item.get(key) for key in ['slug', 'version', 'status', 'updated_at', 'verify_jwt', 'ezbr_sha256']}
                                 for item in json.loads(body) if item.get('slug') in allowed]
save('production-metadata.json', metadata)
status, html, headers = request('https://aperodashboard.lovable.app/login')
published = {'observed_at': observed, 'login_http': status,
             'html_sha256': hashlib.sha256(html).hexdigest(),
             'frontend_commit_sha': 'UNVERIFIED: no authoritative Lovable publication provenance available',
             'assets': []}
if status == 200:
    assets = sorted(set(re.findall(r'["\'](/assets/[^"\']+\.(?:js|css))["\']', html.decode())))
    for asset in assets:
        asset_status, content, _ = request('https://aperodashboard.lovable.app' + asset)
        published['assets'].append({'path': asset, 'http': asset_status, 'sha256': hashlib.sha256(content).hexdigest()})
save('published-frontend.json', published)
historical_markers = OUT / 'historical-live-markers.json'
if historical_markers.exists():
    verified = []
    for asset in json.loads(historical_markers.read_text())['routes']:
        asset_status, content, _ = request('https://aperodashboard.lovable.app' + asset['path'])
        actual_hash = hashlib.sha256(content).hexdigest()
        verified.append({'path': asset['path'], 'http': asset_status, 'sha256': actual_hash,
                         'matches_historical_accepted_route': asset_status == 200 and actual_hash == asset['sha256']})
    save('published-route-continuity.json', {'observed_at': observed, 'routes': verified,
         'limit': 'Byte continuity with accepted route assets; not an independent Git-SHA attestation'})
print(json.dumps({'metadata_saved': True, 'auth_config_http': metadata.get('auth_config_http'),
                  'functions_http': metadata.get('functions_http'), 'login_http': status,
                  'assets_hashed': len(published['assets']), 'production_writes': 0}))
