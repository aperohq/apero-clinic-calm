#!/usr/bin/env python3
"""Check expected AWS subject/audience without ever logging or persisting the JWT.
AWS STS performs signature validation; this is a configuration check only.
"""
import base64
import json
import os
from pathlib import Path
import sys
import urllib.request

try:
    url=os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']+'&audience=sts.amazonaws.com'
    request=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    with urllib.request.urlopen(request,timeout=20) as response:token=json.load(response)['value']
    encoded=token.split('.')[1];claims=json.loads(base64.urlsafe_b64decode(encoded+'='*(-len(encoded)%4)))
    template=json.loads((Path(__file__).resolve().parents[2]/'operations/aws/production-backups.cloudformation.json').read_text(encoding="utf-8"))
    expected=template['Outputs']['GitHubOidcSubject']['Value']
    # Subject identifies only this fixed main workflow; never print JWT/claims body.
    subject=claims['sub']
    if not isinstance(subject,str) or len(subject)>500:raise ValueError('invalid_subject')
    print(json.dumps({'oidc_public_subject':subject}))
    if claims['sub']!=expected or claims['aud']!='sts.amazonaws.com':raise ValueError('oidc_claim_mismatch')
    print('Federated subject and audience match the reviewed AWS trust policy.')
except Exception:
    print('::error::OIDC configuration check failed; no token or claims logged.')
    sys.exit(1)
