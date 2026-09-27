import copy
import json
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from build import build, golden, validate, validate_backend
from prepare import check_integration, create_draft, registration_sql


class MasterContract(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / "config/template.json").read_text())
        self.flow, self.agent = build(self.config)
        self.reference = golden()

    def test_all_53_node_behaviors_except_explicit_identity_instructions_are_identical(self):
        original = self.reference["conversationFlow"]
        allowed = {"node_greeting", "node_date_time", "node_faq", "node_global_urgent",
                   "node_global_human", "node_callback_collect", "node_request_failed"}
        self.assertEqual(len(self.flow["nodes"]), 53)
        for old, new in zip(original["nodes"], self.flow["nodes"]):
            expected = copy.deepcopy(old)
            actual = copy.deepcopy(new)
            if old["id"] in allowed:
                expected["instruction"]["text"] = new["instruction"]["text"]
            if old["id"] in {"node_date_time", "node_doctor_preference", "node_resolve"}:
                self.assertEqual(len(new["edges"]), len(old["edges"]) + 1)
                actual["edges"] = actual["edges"][1:]
            if old["id"] == "node_global_human":
                actual["global_node_setting"] = old["global_node_setting"]
            if old["id"] in {"node_message_collect", "node_end"}:
                actual.pop("global_node_setting")
            self.assertEqual(expected, actual, old["id"])
        for i in (2, 3, 4, 5, 6, 8):
            self.assertEqual(original["global_prompt"].strip().split("\n\n")[i],
                             self.flow["global_prompt"].strip().split("\n\n")[i])

    def test_ten_tool_contracts_unchanged_except_clinic_text_and_endpoint(self):
        self.assertEqual(len(self.flow["tools"]), 10)
        for old, new in zip(self.reference["conversationFlow"]["tools"], self.flow["tools"]):
            expected = copy.deepcopy(old)
            expected["url"] = new["url"]
            if old["name"] == "check_availability":
                expected["parameters"]["properties"]["requested_date"]["description"] = new["parameters"]["properties"]["requested_date"]["description"]
            if old["name"].startswith("persist_"):
                expected["description"] = new["description"]
            self.assertEqual(expected, new, old["name"])
            self.assertNotIn("clinic_id", new["parameters"]["properties"])
            self.assertNotIn("location_id", new["parameters"]["properties"])

    def test_proven_baseline_settings_and_analysis_fields_preserved(self):
        for key in ("voice_temperature", "voice_speed", "volume", "responsiveness", "stt_mode",
                    "max_call_duration_ms", "end_call_after_silence_ms", "handbook_config", "post_call_analysis_model"):
            self.assertEqual(self.agent[key], self.reference[key])
        for key in ("model_choice", "model_temperature", "start_speaker", "tool_call_strict_mode"):
            self.assertEqual(self.flow[key], self.reference["conversationFlow"][key])
        for old, new in zip(self.reference["post_call_analysis_data"], self.agent["post_call_analysis_data"]):
            self.assertEqual({k: v for k, v in old.items() if k != "examples"}, new)

    def test_template_is_neutral_unbound_and_has_no_inherited_knowledge(self):
        text = json.dumps([self.flow, self.agent], ensure_ascii=False).lower()
        for forbidden in ("dental zone", "دنتل", "سارة", "salmiya", "kuwait", "qandil", "kandil",
                          "+965", "dental cleaning", "agent_b84b", "conversation_flow_43f53", "knowledge_base_5e52"):
            self.assertNotIn(forbidden, text)
        self.assertEqual(self.flow["knowledge_base_ids"], [])
        self.assertNotIn("response_engine", self.agent)
        self.assertIsNone(self.config["clinic"]["id"])
        self.assertIn("unknown", self.flow["global_prompt"])

    def test_timezone_is_explicit_and_runtime_variables_are_portable(self):
        self.config["clinic"]["timezone"] = "America/New_York"
        flow, agent = build(self.config)
        self.assertEqual(agent["timezone"], "America/New_York")
        self.assertIn("{{current_time}}", flow["global_prompt"])
        self.assertIn("{{current_calendar}}", flow["global_prompt"])
        self.assertNotIn("current_time_Asia", flow["global_prompt"])
        self.config["clinic"]["timezone"] = "invalid/timezone"
        with self.assertRaises(Exception): build(self.config)

    def test_no_unsupported_transfer_multilocation_or_secret_fields(self):
        for section, key, value in (("escalation", "live_transfer_enabled", True),
                                    ("clinic", "location_count", 2), ("integration", "api_key", "secret")):
            cfg = copy.deepcopy(self.config)
            cfg[section][key] = value
            with self.assertRaises(Exception): validate(cfg)

    def test_real_clinic_fails_without_required_setup(self):
        self.config["mode"] = "clinic"
        with self.assertRaises(ValueError): validate(self.config)

    def test_backend_validation_ignores_another_clinics_staff_and_hours(self):
        cfg = self.config
        cfg["clinic"].update(id="22222222-2222-4222-8222-222222222222", name="Clinic B", phone="+12025550101")
        snapshot = {"clinics": [cfg["clinic"]], "staff": [{"id": "staff-a", "clinic_id": "clinic-a", "active": True, "services": ["Consultation"]}], "staff_availability": []}
        with self.assertRaises(ValueError): validate_backend(cfg, snapshot)
        snapshot["staff"].append({"id": "staff-b", "clinic_id": cfg["clinic"]["id"], "active": True, "services": ["Consultation"]})
        snapshot["staff_availability"] = [{"clinic_id": "clinic-a", "staff_id": "staff-b", "is_available": True, "start_time": "09:00", "end_time": "17:00"}]
        with self.assertRaises(ValueError): validate_backend(cfg, snapshot)
        snapshot["staff_availability"][0]["clinic_id"] = cfg["clinic"]["id"]
        self.assertEqual(validate_backend(cfg, snapshot), {"staff": 1, "services": 1})

    def test_simulation_discovered_repairs_route_to_existing_safe_paths(self):
        nodes = {n["id"]: n for n in self.flow["nodes"]}
        for node in ("node_date_time", "node_doctor_preference"):
            self.assertEqual(nodes[node]["edges"][0]["destination_node_id"], "node_invalidate_booking")
        self.assertEqual(nodes["node_resolve"]["edges"][0]["destination_node_id"], "node_tool_failure")
        self.assertIn("callback", nodes["node_global_human"]["global_node_setting"]["condition"])
        self.assertIn("leave a message", nodes["node_message_collect"]["global_node_setting"]["condition"])

    def test_onboarding_refuses_reusing_existing_integration(self):
        cfg = json.loads((ROOT / "config/clinic-b.local.json").read_text())
        snapshot = {"voice_integrations": [{"clinic_id": "other", "workspace_id": cfg["integration"]["workspace_id"], "agent_id": "agent-other", "secret_env_name": "RETELL_OTHER"}]}
        with self.assertRaises(ValueError): check_integration(cfg, snapshot)
        snapshot["voice_integrations"][0]["workspace_id"] = "org_other"
        snapshot["voice_integrations"][0]["secret_env_name"] = cfg["integration"]["secret_env_name"]
        with self.assertRaises(ValueError): check_integration(cfg, snapshot)

    def test_registration_is_explicit_inactive_insert_without_secret_values(self):
        cfg = json.loads((ROOT / "config/clinic-b.local.json").read_text())
        with self.assertRaises(ValueError): registration_sql(cfg)
        cfg["integration"].update(agent_id="agent_local_b", conversation_flow_id="conversation_flow_local_b")
        sql = registration_sql(cfg)
        self.assertIn(",false);", sql)
        self.assertNotIn("on conflict", sql.lower())
        self.assertNotIn("update public", sql.lower())
        self.assertIn("RETELL_LOCAL_B", sql)

    def test_new_key_cannot_reuse_workspace_hidden_by_historical_metadata_typo(self):
        cfg = json.loads((ROOT / "config/clinic-b.local.json").read_text())
        with patch.dict("os.environ", {"RETELL_API_KEY": "local-only-test"}), patch("prepare.request") as api:
            api.side_effect = [{"org_id": cfg["integration"]["workspace_id"]}, {"agent_id": "agent_existing"}]
            with self.assertRaisesRegex(ValueError, "already integrated"):
                create_draft(cfg, {}, {}, ROOT, [{"agent_id": "agent_existing"}])
            self.assertEqual(api.call_count, 2)  # GETs only; no create/publish/update.

    def test_every_simulation_mocks_every_external_tool(self):
        sys.path.insert(0, str(ROOT / "tests"))
        from scenarios import cases
        names = {t["name"] for t in self.flow["tools"]}
        for case in cases():
            self.assertEqual({m["tool_name"] for m in case["tool_mocks"] if m["input_match_rule"]["type"] == "any" and m["output"]}, names)


if __name__ == "__main__": unittest.main()
