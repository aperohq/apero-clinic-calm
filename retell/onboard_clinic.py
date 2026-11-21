"""Read-only clinic validation and local flow generation; never publishes resources."""
import argparse
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--config", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--fixture", help="Local clinic/staff JSON for offline validation")
args = parser.parse_args()
cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
clinic_id = cfg["clinic_id"]

def fetch(table, columns):
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        parser.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for read-only validation")
    request = urllib.request.Request(f"{url}/rest/v1/{table}?select={columns}&clinic_id=eq.{clinic_id}" if table == "staff" else f"{url}/rest/v1/{table}?select={columns}&id=eq.{clinic_id}", headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)

if args.fixture:
    fixture = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
    clinics, staff = fixture["clinics"], fixture["staff"]
    clinics = [c for c in clinics if c["id"] == clinic_id]
    staff = [s for s in staff if s["clinic_id"] == clinic_id]
else:
    clinics, staff = fetch("clinics", "id,name,timezone,phone"), fetch("staff", "id,clinic_id,full_name,services,active,aliases")
if len(clinics) != 1:
    parser.error("Clinic record missing or duplicated")
active = [s for s in staff if s.get("active", True) and s.get("services")]
if not active:
    parser.error("No active staff with services for this clinic")
if cfg["timezone"] != clinics[0]["timezone"]:
    parser.error("Config timezone differs from authoritative clinic record")
if not cfg.get("knowledge_base_id") or not cfg.get("agent_id") or not cfg.get("workspace_id"):
    parser.error("Retell workspace, agent and knowledge base IDs required")
subprocess.run([sys.executable, "retell/build_flow.py", "--config", args.config, "--output", args.output], check=True)
print(f"Validated {clinics[0]['name']}: {len(active)} active staff, {len(set(x for s in active for x in s['services']))} services")
print("Next: configure workspace secret in Supabase Edge secrets; insert inactive voice_integrations row; apply generated flow in Retell; verify signatures/tools and acceptance calls; set active=true.")
