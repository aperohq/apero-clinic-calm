#!/usr/bin/env python3
"""Read-only encrypted snapshots of explicit agents + their flows/KB metadata.
No calls, publication, or telephony mutation. KB source bytes/custom voice audio
are NOT captured: preserve their approved originals separately.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request
import uuid
from database_backup import private, digest


def api(path):
    request = urllib.request.Request('https://api.retellai.com/' + path,
        headers={'Authorization': 'Bearer ' + os.environ['RETELL_API_KEY']})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent', action='append', required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--recipients', type=Path, required=True)
    args = parser.parse_args()
    output = None
    try:
        if os.environ.get('BACKUP_DESTINATION_APPROVED') != 'yes':
            raise ValueError('destination_not_approved')
        private(args.destination, directory=True)
        repo = Path(__file__).resolve().parents[2]
        if repo == args.destination.resolve() or repo in args.destination.resolve().parents:
            raise ValueError('repository_destination')
        recipients = [x.strip() for x in args.recipients.read_text().splitlines() if x.strip() and not x.startswith('#')]
        if not recipients or any(not x.startswith('age1') for x in recipients):
            raise ValueError('public_recipients_required')
        result = {'captured_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                  'agents': [], 'flows': {}, 'knowledge_bases': {},
                  'limitations': ['Current/published versions only; capture each release to preserve history',
                      'KB source bytes, custom voice source audio, call recordings, SIP/provider credentials excluded']}
        for agent_id in args.agent:
            if not re.fullmatch(r'agent_[a-zA-Z0-9]+', agent_id):
                raise ValueError('invalid_agent_id')
            for selector in ('latest', 'latest_published'):
                agent = api('get-agent/' + agent_id + '?version=' + selector)
                result['agents'].append(agent)
                engine = agent['response_engine']
                flow_id = engine.get('conversation_flow_id')
                if flow_id:
                    if not re.fullmatch(r'conversation_flow_[a-zA-Z0-9]+', flow_id):
                        raise ValueError('invalid_flow_id')
                    version = int(engine['version'])
                    key = flow_id + ':' + str(version)
                    flow = api('get-conversation-flow/' + flow_id + '?version=' + str(version))
                    result['flows'][key] = flow
                    for kb_id in flow.get('knowledge_base_ids', []):
                        if not re.fullmatch(r'knowledge_base_[a-zA-Z0-9]+', kb_id):
                            raise ValueError('invalid_kb_id')
                        result['knowledge_bases'][kb_id] = api('get-knowledge-base/' + kb_id)
        output = args.destination / ('retell-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex + '.json.age')
        with output.open('xb') as target:
            completed = subprocess.run(['age', '-R', str(args.recipients)],
                input=json.dumps(result).encode(), stdout=target, stderr=subprocess.DEVNULL)
            target.flush(); os.fsync(target.fileno())
        if completed.returncode or not output.stat().st_size:
            raise ValueError('encryption_failed')
        with output.with_suffix(output.suffix + '.sha256').open('x') as file:
            file.write(digest(output) + '  ' + output.name + '\n')
        print(json.dumps({'category': 'retell_backup_completed', 'state': 'success',
                          'scope': 'configuration_only', 'source_bytes_preserved': False}))
        return 0
    except Exception:
        if output is not None and output.exists():
            output.unlink()
        print(json.dumps({'category': 'retell_backup_failed', 'state': 'failure'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
