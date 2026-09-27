"""Compile the golden receptionist into a separate, clinic-configured Retell draft.

Pure local generation. Never updates an agent, publishes, or writes to the database.
The reference export is immutable; only the explicit clinic-specific text below changes.
"""
import argparse
import copy
import hashlib
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
GOLDEN_SHA256 = "3315a9a91ff495bc6f2d15b30f044a0f2e48c3e9edeead054a8334c19ec1f771"
FLOW_FIELDS = (
    "global_prompt", "nodes", "components", "start_node_id", "start_speaker",
    "tools", "model_choice", "model_temperature", "tool_call_strict_mode",
    "default_dynamic_variables", "knowledge_base_ids", "kb_config",
    "begin_tag_display_position", "is_transfer_cf",
)
AGENT_FIELDS = (
    "language", "data_storage_setting", "opt_in_signed_url", "end_call_after_silence_ms",
    "post_call_analysis_model", "pii_config", "handbook_config", "post_call_analysis_data",
    "voice_id", "voice_temperature", "voice_speed", "volume", "max_call_duration_ms",
    "responsiveness", "stt_mode", "allow_user_dtmf", "user_dtmf_options",
)


def golden():
    raw = (ROOT / "reference/golden.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != GOLDEN_SHA256:
        raise ValueError("Golden reference changed; review provenance before conversion")
    return json.loads(raw)


def validate(config):
    # jsonschema is developer-only; never shipped to the frontend or Edge runtime.
    import jsonschema
    jsonschema.Draft202012Validator(json.loads((ROOT / "config.schema.json").read_text())).validate(config)
    ZoneInfo(config["clinic"]["timezone"])
    if config["speech"]["default_language"] not in config["speech"]["supported_languages"]:
        raise ValueError("Default language must be a supported language")
    if config["mode"] == "clinic":
        if not config["clinic"]["id"] or not config["clinic"]["phone"]:
            raise ValueError("Real clinic requires its existing backend ID and clinic phone")
        if not config["knowledge"]["approved_by"]:
            raise ValueError("Clinic facts require an identified approver")
        for key in ("workspace_id", "secret_env_name", "dialing_prefix", "local_number_length", "slot_minutes"):
            if config["integration"][key] is None:
                raise ValueError(f"Missing integration.{key}")
    if config["integration"]["tool_url"].rsplit("/", 1)[-1] != "clinic-operations":
        raise ValueError("All ten tools must use clinic-operations")
    return config


def validate_backend(config, snapshot):
    """Validate a scoped read-only backend snapshot, never duplicate staff in prompts."""
    clinic_id = config["clinic"]["id"]
    clinics = [c for c in snapshot["clinics"] if c["id"] == clinic_id]
    if len(clinics) != 1:
        raise ValueError("Expected one existing clinic")
    for key in ("name", "timezone", "phone"):
        if config["clinic"][key] != clinics[0].get(key):
            raise ValueError(f"clinic.{key} differs from backend; refresh configuration")
    staff = [s for s in snapshot["staff"] if s["clinic_id"] == clinic_id and s.get("active") and s.get("services")]
    if not staff:
        raise ValueError("Clinic needs active practitioners with services")
    staff_ids = {s["id"] for s in staff}
    hours = [h for h in snapshot["staff_availability"] if h["clinic_id"] == clinic_id and h["staff_id"] in staff_ids and h["is_available"]]
    if {h["staff_id"] for h in hours} != staff_ids:
        raise ValueError("Every active practitioner offering services needs saved availability")
    if any(h["start_time"] >= h["end_time"] for h in hours):
        raise ValueError("Availability must finish after it starts")
    return {"staff": len(staff), "services": len({v for s in staff for v in s["services"]})}


def build(config):
    validate(config)
    reference = golden()
    flow = {k: copy.deepcopy(reference["conversationFlow"][k]) for k in FLOW_FIELDS}
    agent = {k: copy.deepcopy(reference[k]) for k in AGENT_FIELDS}
    clinic, speech, policies, knowledge, escalation, integration = (
        config[k] for k in ("clinic", "speech", "policies", "knowledge", "escalation", "integration")
    )
    paragraphs = flow["global_prompt"].strip().split("\n\n")
    # Keep scheduling, consent, correction, failure and interruption rules verbatim.
    paragraphs[0] = (
        "You are {{receptionist_name}}, the calm receptionist for {{clinic_name}}, a {{clinic_type}}. "
        "Use {{clinic_name_localized}} and {{receptionist_name_localized}} when speaking Arabic. "
        f"Start in {speech['default_language']}; support {', '.join(speech['supported_languages'])}. "
        f"Preferred spoken dialect: {speech['dialect']}. Follow the caller's Arabic or English, "
        "including mixed-language doctor and service names; switch promptly when requested. "
        "Usually speak in one or two short sentences and ask one question at a time. "
        "Acknowledge corrections briefly. Do not repeat known details or narrate tools, checks, databases "
        "or internal logic. Accuracy takes priority over brevity. Never invent clinic, doctor, price, "
        "insurance or appointment facts. Use only the approved facts below, any attached approved "
        "clinic knowledge base, and backend results. If information is absent or conflicting, say you "
        "cannot confirm it and offer staff follow-up. Never infer facts from the clinic's type."
    )
    paragraphs[1] = (
        f"Clinic time zone is {clinic['timezone']}. Resolve relative dates using {{{{current_time}}}} "
        "and {{current_calendar}} in {{system_timezone}}. Clarify ambiguity. No past slots. "
        "Speak dates and times naturally; send machine-readable YYYY-MM-DD and HH:mm to tools. "
        "Do not reveal IDs, slot tokens, JSON, APIs or internal actions."
    )
    paragraphs[7] = (
        "Live transfer is not enabled in this v1 flow. Never say a transfer occurred. "
        "Offer a persisted staff callback or message, or the approved fallback phone. "
        "A message, callback or urgent escalation is submitted only after its persistence tool succeeds. "
        "If it fails, say it was not submitted. Do not diagnose or give personalized treatment advice. "
        f"Emergency guidance: {escalation['emergency_guidance']} "
        f"Urgent callback behavior: {escalation['urgent_callback_behavior']} "
        f"Callback availability: {escalation['callback_availability']} "
        "A saved request is not a guarantee of a callback time. Never delay emergency care to collect contact details. "
        f"Pricing policy: {policies['pricing']} Insurance policy: {policies['insurance']}"
    )
    facts = {
        "phone": clinic["phone"], "address": clinic["address"], "opening_hours": clinic["opening_hours"],
        "fallback_phone": escalation["fallback_phone"], "approved_faq": knowledge["approved_faq"],
    }
    paragraphs.append(
        "APPROVED CLINIC FACTS (null/empty means unknown; never guess):\n"
        + json.dumps(facts, ensure_ascii=False, indent=2)
        + "\nProviders, services, availability and appointments are authoritative only from backend tools. "
        "Opening hours are informational and do not prove appointment availability. "
        "This configuration supports ONE operational location. Never promise scheduling at another "
        "location; offer staff follow-up when asked about an unsupported location."
    )
    paragraphs.append(
        "When asking for patient details, ask exactly ONE question per turn: if the patient is unknown "
        "ask who will attend, then ask their full name, then ask their contact. If the caller identified "
        "themselves separately, include the known caller_name and caller_phone in book_appointment; "
        "never erase known caller identity when booking for another person. Before persistence, say "
        "'I can request a callback' rather than 'I have arranged a callback' or 'I will pass it on'. "
        "A request to leave a message at any point must go through Take Message and its persistence tool. "
        "A callback request at any point must go through Collect Callback and its persistence tool. "
        "Do not keep asking to book when the caller has abandoned booking. "
        "Use requested_time for an exact time and leave window_start/window_end unset unless the caller "
        "actually provided a time range. An end boundary equal to the requested time excludes that slot."
        " Preserve an already established year when the caller changes only day/month. If a date "
        "without a year could be past or ambiguous, ask for the year before checking. Never offer a "
        "returned slot outside the caller's latest constraints as though it satisfies them; explain "
        "the mismatch and ask whether they want that alternative. Do not infer that no other slots "
        "exist from a short returned list. For life-threatening symptoms, emergency care is needed "
        "NOW, even after an urgent callback is saved. Never soften this to 'if symptoms get worse'."
    )
    flow["global_prompt"] = "\n\n".join(paragraphs) + "\n"
    instructions = {
        "node_greeting": speech["greeting"],
        "node_faq": "Answer briefly using approved clinic facts and the configured pricing and insurance policies only. If a fact is unknown, say you cannot confirm it and ask whether the caller would like a staff callback to clarify it. Do not redirect an unanswered factual question into booking. If they ask to be notified or contacted later, collect and persist a callback request; never end before addressing that request.",
        "node_global_urgent": "Acknowledge concern without diagnosis. Follow configured emergency guidance immediately for potentially life-threatening symptoms. Never delay emergency care for a callback. Offer an urgent staff callback and collect confirmed contact and a concise reason if appropriate. Do not claim a live transfer.",
        "node_global_human": "Acknowledge the request. Live transfer is not enabled. Offer a real persisted staff callback or the approved fallback phone. Do not say a transfer is occurring.",
        "node_callback_collect": "Ask for caller name, confirmed callback phone and concise reason, one question at a time. Offer a staff callback using the configured callback availability. Do not promise follow-up until saved and never promise an exact response time.",
        "node_request_failed": "The message or callback request was NOT saved. Say so plainly. Offer the configured fallback phone, otherwise the approved clinic phone. If neither is available, say you cannot confirm a number. Do not invent contact details or promise staff received the request.",
    }
    for node in flow["nodes"]:
        if node["id"] in instructions:
            node["instruction"]["text"] = instructions[node["id"]]
        if node["id"] == "node_date_time":
            node["instruction"]["text"] = node["instruction"]["text"].replace("Kuwait time", "the configured clinic timezone")
            node["instruction"]["text"] += " Compare the intended date with current_time before checking. Preserve a previously explicit year for a date correction. If the caller omitted the year and the date could be past or ambiguous, ask for the year; never send a past date."
    # Narrow regression repairs discovered in actual Retell simulations. These are
    # intentional master-only deltas, not a rewrite of the golden graph.
    apply_regression_repairs(flow)
    for tool in flow["tools"]:
        tool["url"] = integration["tool_url"]
        if tool["name"] == "check_availability":
            tool["parameters"]["properties"]["requested_date"]["description"] = "YYYY-MM-DD in the configured clinic timezone."
        if tool["name"].startswith("persist_"):
            tool["description"] = "Persist this request before promising staff follow-up. This tool does not perform live transfer."
    flow["default_dynamic_variables"] = {
        "clinic_name": clinic["name"], "clinic_name_localized": clinic["localized_name"],
        "clinic_type": clinic["type"], "receptionist_name": speech["receptionist_name"],
        "receptionist_name_localized": speech["receptionist_localized_name"],
    }
    flow["knowledge_base_ids"] = knowledge["retell_knowledge_base_ids"]
    agent.update({
        "agent_name": config["agent_name"], "version_description": "Apero single-location master v1; golden receptionist behavior with explicit clinic configuration.",
        "version_title": "Apero Master v1", "timezone": clinic["timezone"],
        "language": speech["supported_languages"], "voice_id": speech["voice_id"],
        "webhook_url": integration["webhook_url"],
    })
    for field in agent["post_call_analysis_data"]:
        field.pop("examples", None)
    # response_engine is filled only after a NEW flow is created; never reuse golden IDs.
    encoded = json.dumps({"flow": flow, "agent": agent}, ensure_ascii=False)
    if re.search(r"Dental Zone|دنتل|سارة|Qandil|Kandil|knowledge_base_5e52|conversation_flow_43f53|agent_b84b", encoded, re.I):
        raise ValueError("Reference clinic identity leaked into generated master")
    return flow, agent


def apply_regression_repairs(flow):
    nodes = {n["id"]: n for n in flow["nodes"]}
    nodes["node_global_human"]["global_node_setting"]["condition"] += (
        " Also when the caller explicitly requests a staff callback or follow-up at any point, "
        "including after unavailable appointments. This includes asking to be notified, called or contacted "
        "later when missing clinic information or availability is known. Do not interrupt collecting or persisting that same request."
    )
    nodes["node_message_collect"]["global_node_setting"] = {
        "condition": "Caller explicitly wants to leave a message for staff, including when abandoning another task. Do not interrupt a message already being collected or persisted.",
        "cool_down": 3,
    }
    nodes["node_end"]["global_node_setting"] = {
        "condition": "Caller explicitly says goodbye or says they are finished and do not need further help, including after declining a booking or cancellation, AND their latest utterance contains NO new request (including to be notified, called, contacted or messaged later). Not a brief thank-you during an unfinished task, and never treat ending as consent to any action.",
        "cool_down": 1,
    }
    for node_id in ("node_date_time", "node_doctor_preference"):
        nodes[node_id]["edges"].insert(0, {
            "id": f"edge_{node_id}_changed_service",
            "destination_node_id": "node_invalidate_booking",
            "transition_condition": {"type": "prompt", "prompt": "Caller has changed the service from the canonical service returned by the most recent resolver; resolve the new service before any availability check."},
        })
    nodes["node_resolve"]["edges"].insert(0, {
        "id": "edge_resolve_technical_failure", "destination_node_id": "node_tool_failure",
        "transition_condition": {"type": "equation", "operator": "||", "equations": [
            {"left": "{{resolve_error_type}}", "operator": "==", "right": "database_error"},
            {"left": "{{resolve_error_type}}", "operator": "==", "right": "tool_error"},
        ]},
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--backend-snapshot", help="Read-only clinics/staff/staff_availability JSON; required for real clinics")
    args = parser.parse_args()
    config = validate(json.loads(Path(args.config).read_text()))
    if config["mode"] == "clinic" and not args.backend_snapshot:
        parser.error("Real clinic generation requires --backend-snapshot from prepare.py")
    if args.backend_snapshot:
        print("Backend validation:", validate_backend(config, json.loads(Path(args.backend_snapshot).read_text())))
    flow, agent = build(config)
    target = Path(args.output_dir)
    target.mkdir(parents=True, exist_ok=True)
    for name, value in (("flow", flow), ("agent", agent)):
        (target / f"{name}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    print(f"Prepared {len(flow['nodes'])} nodes / {len(flow['tools'])} tools in {target}. No external writes.")
    print("Next: create a NEW flow and agent in the intended workspace; verify voice and KB ownership; record new IDs; register inactive integration; test; activate and connect telephony.")


if __name__ == "__main__":
    main()
