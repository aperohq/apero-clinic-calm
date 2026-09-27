"""Prepare one clinic from authoritative backend data; optionally create NEW drafts.

Default is read-only external access + local output. --create-draft explicitly creates
new Retell resources, never publishes, changes telephony, or updates an existing agent.
Credentials are environment-only. No secret is written into output or SQL.
"""
import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from uuid import UUID

from build import build, validate_backend


class ApiError(RuntimeError):
    def __init__(self, method, path, status):
        super().__init__(f"{method} {path}: HTTP {status}")
        self.status = status


def request(url, key, body=None, method=None, apikey=False):
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if apikey:
        headers["apikey"] = key
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise ApiError(req.method, urllib.parse.urlsplit(url).path, error.code) from None


def backend_snapshot(config):
    clinic_id = str(UUID(config["clinic"]["id"]))
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    tables = {
        "clinics": ("id,name,timezone,phone", "id"),
        "staff": ("id,clinic_id,full_name,services,aliases,active", "clinic_id"),
        "staff_availability": ("clinic_id,staff_id,day_of_week,start_time,end_time,is_available", "clinic_id"),
        "voice_integrations": ("clinic_id,workspace_id,agent_id,secret_env_name", None),
    }
    result = {}
    for table, (columns, column) in tables.items():
        query = {"select": columns}
        if column:
            query[column] = f"eq.{clinic_id}"
        result[table] = request(f"{url}/rest/v1/{table}?{urllib.parse.urlencode(query)}", key, apikey=True)
    return result


def check_integration(config, snapshot):
    integration = config["integration"]
    # Refuse to reuse any existing clinic integration, including one for this clinic.
    # A deliberate replacement is a separate migration/review, not onboarding.
    for row in snapshot.get("voice_integrations", []):
        if row["clinic_id"] == config["clinic"]["id"] or any(
            integration.get(k) and integration[k] == row.get(k)
            for k in ("workspace_id", "agent_id", "secret_env_name")
        ):
            raise ValueError("Existing clinic/workspace/agent/secret mapping conflicts; use a new clinic integration")


def registration_sql(config):
    integration = config["integration"]
    for field in ("agent_id", "conversation_flow_id", "workspace_id", "secret_env_name"):
        if not integration[field]:
            raise ValueError(f"Record integration.{field} before preparing registration SQL")
    def literal(value):
        if value is None:
            return "null"
        if isinstance(value, int):
            return str(value)
        return "'" + value.replace("'", "''") + "'"
    values = [config["clinic"]["id"], integration["workspace_id"], integration["agent_id"],
              integration["conversation_flow_id"], next(iter(config["knowledge"]["retell_knowledge_base_ids"]), None),
              integration["secret_env_name"], integration["telephony_number"], integration["dialing_prefix"],
              integration["local_number_length"], integration["slot_minutes"]]
    return ("-- Review and apply using server credentials. No existing row is modified.\n"
            "-- Set the unique Edge secret separately; never put its value in SQL.\n"
            "begin;\ninsert into public.voice_integrations\n"
            "(clinic_id,workspace_id,agent_id,conversation_flow_id,knowledge_base_id,secret_env_name,phone_number,dialing_prefix,local_number_length,slot_minutes,active)\n"
            "values (" + ",".join(map(literal, values)) + ",false);\ncommit;\n")


def create_draft(config, flow, agent, output, existing_integrations):
    key = os.environ["RETELL_API_KEY"]
    def api(path, body=None):
        return request("https://api.retellai.com/" + path, key, body)
    info = api("get-api-key-info")
    if config["integration"]["workspace_id"] != info["org_id"]:
        raise ValueError("RETELL_API_KEY belongs to a different workspace than configuration")
    # Verify isolation using actual API access too: historical workspace labels
    # can contain typos. Another key in an already integrated workspace must not
    # bypass the database's workspace-name uniqueness check.
    for integration in existing_integrations:
        try:
            api("get-agent/" + urllib.parse.quote(integration["agent_id"], safe=""))
        except ApiError as error:
            if error.status not in (403, 404):
                raise
        else:
            raise ValueError("This key can access an already integrated clinic agent; use a separate workspace")
    # Read-only portability/ownership checks before creating anything.
    api("get-voice/" + urllib.parse.quote(config["speech"]["voice_id"], safe=""))
    for kb in config["knowledge"]["retell_knowledge_base_ids"]:
        api("get-knowledge-base/" + urllib.parse.quote(kb, safe=""))
    flow_result = api("create-conversation-flow", flow)
    ids = {"workspace_id": info["org_id"], "conversation_flow_id": flow_result["conversation_flow_id"],
           "agent_id": None, "published": False}
    # Persist flow ID immediately so a failed agent creation does not lose the resource.
    (output / "retell-created.json").write_text(json.dumps(ids, indent=2) + "\n")
    agent["response_engine"] = {"type": "conversation-flow", "conversation_flow_id": ids["conversation_flow_id"], "version": flow_result["version"]}
    result = api("create-agent", agent)
    ids["agent_id"] = result["agent_id"]
    (output / "retell-created.json").write_text(json.dumps(ids, indent=2) + "\n")
    config["integration"].update({k: ids[k] for k in ("agent_id", "conversation_flow_id")})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--fixture", help="Local-only backend snapshot; forbids external creation")
    parser.add_argument("--create-draft", action="store_true", help="Explicitly create NEW flow/agent, never publish")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    if config["mode"] != "clinic":
        parser.error("Use build.py for the unbound template; prepare.py requires a real clinic configuration")
    if args.fixture and args.create_draft:
        parser.error("Fixtures may not create external resources")
    output = Path(args.output_dir)
    if args.create_draft and (output / "retell-created.json").exists():
        parser.error("Draft creation record already exists; inspect it instead of creating duplicate resources")
    snapshot = json.loads(Path(args.fixture).read_text()) if args.fixture else backend_snapshot(config)
    clinic_id = config["clinic"]["id"]
    clinic = next((c for c in snapshot["clinics"] if c["id"] == clinic_id), None)
    if not clinic:
        parser.error("Clinic does not exist")
    for field in ("name", "timezone", "phone"):
        config["clinic"][field] = clinic[field]
    print("Validated:", validate_backend(config, snapshot))
    check_integration(config, snapshot)
    flow, agent = build(config)
    output.mkdir(parents=True, exist_ok=True)
    for name, value in (("flow", flow), ("agent", agent), ("backend-snapshot", snapshot)):
        (output / f"{name}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    if args.create_draft:
        create_draft(config, flow, agent, output, snapshot.get("voice_integrations", []))
    (output / "resolved-config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
    if config["integration"]["agent_id"] and config["integration"]["conversation_flow_id"]:
        (output / "register-inactive.sql").write_text(registration_sql(config))
    print("Prepared local configuration. Next: verify workspace/voice/knowledge; create draft if needed; set Edge secret; review inactive registration; enable isolated integration for testing with no public phone; run signed and conversation tests; publish approved clinic draft and connect telephony.")


if __name__ == "__main__":
    main()
