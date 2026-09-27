"""Explicit non-destructive deployment probes. Never resolves/checks/books/writes.

Uses an impossible synthetic patient lookup and an ignored webhook event. Requires
the existing workspace key in RETELL_API_KEY; never prints it. Pass agent IDs and
endpoint as arguments; no clinic is selected through caller input.
"""
import argparse
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from uuid import uuid4


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--base-url", required=True)
    p.add_argument("--registered-agent", required=True)
    p.add_argument("--unregistered-agent", required=True)
    args = p.parse_args()
    key = os.environ["RETELL_API_KEY"]
    def probe(endpoint, agent, valid=True, event=None, spoof=None):
        payload = {"call": {"agent_id": agent, "call_id": "apero-readonly-" + str(uuid4())},
                   "args": {"action": "lookup", "client_name": "APERO NONEXISTENT " + str(uuid4()), "client_phone": "+96599999999"}}
        if event:
            payload["event"] = event
        if spoof:
            payload["clinic_id"] = spoof
            payload["args"]["clinic_id"] = spoof
        raw = json.dumps(payload)
        stamp = str(int(time.time() * 1000))
        digest = hmac.new((key if valid else "invalid-test-secret").encode(), (raw + stamp).encode(), hashlib.sha256).hexdigest()
        req = urllib.request.Request(args.base_url.rstrip("/") + "/" + endpoint, data=raw.encode(),
                                     headers={"Content-Type": "application/json", "x-retell-signature": f"v={stamp},d={digest}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()
    results = []
    for name, endpoint, agent, valid, event, spoof, expected in [
        ("registered signed lookup", "clinic-operations", args.registered_agent, True, None, None, 200),
        ("claimed clinic ignored", "clinic-operations", args.registered_agent, True, None, str(uuid4()), 200),
        ("invalid signature", "clinic-operations", args.registered_agent, False, None, None, 401),
        ("unbound master rejected", "clinic-operations", args.unregistered_agent, True, None, None, 401),
        ("registered webhook authentication", "retell-webhook", args.registered_agent, True, "apero_readonly_probe", None, 204),
        ("unbound master webhook rejected", "retell-webhook", args.unregistered_agent, True, "apero_readonly_probe", None, 401),
    ]:
        status, body = probe(endpoint, agent, valid, event, spoof)
        assert status == expected, (name, status, body)
        if status == 200:
            assert json.loads(body) == {"success": True, "appointments": [], "count": 0}, (name, body)
        results.append({"test": name, "status": status, "passed": True})
    print(json.dumps(results, indent=2))


if __name__ == "__main__": main()
