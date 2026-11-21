import json
import unittest
import subprocess
import tempfile
from pathlib import Path

flow = json.loads(Path("retell/dental-zone-flow.json").read_text(encoding="utf-8"))
nodes = {n["id"]: n for n in flow["nodes"]}
tools = {t["tool_id"]: t for t in flow["tools"]}

def targets(node):
    return [e["destination_node_id"] for e in node.get("edges", [])] + [
        node[key]["destination_node_id"] for key in ("else_edge", "always_edge", "skip_response_edge") if key in node
    ]

class FlowSafety(unittest.TestCase):
    def test_second_clinic_uses_same_graph_with_its_own_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "clinic-b.json"
            subprocess.run(["python3", "retell/build_flow.py", "--config", "retell/config/clinic-b.local.json", "--output", str(output)], check=True, capture_output=True)
            second = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual([n["id"] for n in second["nodes"]], [n["id"] for n in flow["nodes"]])
        self.assertEqual(second["knowledge_base_ids"], ["knowledge_base_local_fixture"])
        self.assertTrue(all(t["url"].startswith("http://localhost:") for t in second["tools"]))
        self.assertNotIn("Dental Zone", second["global_prompt"])

    def test_all_references_exist(self):
        for node in nodes.values():
            for target in targets(node): self.assertIn(target, nodes)
            if node["type"] == "function": self.assertIn(node["tool_id"], tools)

    def test_success_nodes_have_only_conditional_entry(self):
        for function_id, success_id, result_name in [
            ("node_book", "node_booked", "booking_success"),
            ("node_reschedule_tool", "node_rescheduled", "reschedule_success"),
            ("node_cancel_tool", "node_cancelled", "cancel_success"),
        ]:
            node = nodes[function_id]
            self.assertNotEqual(node.get("else_edge", {}).get("destination_node_id"), success_id)
            edges = [e for e in node["edges"] if e["destination_node_id"] == success_id]
            self.assertEqual(len(edges), 1)
            condition = edges[0]["transition_condition"]
            self.assertEqual(condition["type"], "equation")
            self.assertTrue(any(q["left"] == "{{" + result_name + "}}" and q["right"] == "true" for q in condition["equations"]))

    def test_reschedule_and_cancel_never_use_new_booking_tool(self):
        for start, success in [("node_reschedule_details", "node_rescheduled"), ("node_cancel_confirm", "node_cancelled")]:
            seen = set(); queue = [start]
            while queue:
                current = queue.pop()
                if current in seen or current == success or current == "node_anything_else": continue
                seen.add(current)
                queue.extend(targets(nodes[current]))
            self.assertNotIn("node_book", seen)

    def test_corrections_invalidate_before_recheck(self):
        for node_id in ("node_offer", "node_final", "node_reschedule_offer", "node_reschedule_final"):
            outgoing = targets(nodes[node_id])
            self.assertIn("node_invalidate_reschedule" if "reschedule" in node_id else "node_invalidate_booking", outgoing)
        self.assertEqual(nodes["node_invalidate_booking"]["tool_id"], "tool-apero-invalidate")
        self.assertEqual(nodes["node_invalidate_reschedule"]["tool_id"], "tool-apero-invalidate")

    def test_date_only_correction_preserves_doctor(self):
        self.assertEqual(nodes["node_invalidate_booking"]["always_edge"]["destination_node_id"], "node_change_booking")
        correction_edges = nodes["node_change_booking"]["edges"]
        direct = [e for e in correction_edges if e["destination_node_id"] == "node_check"]
        self.assertEqual(len(direct), 1)
        self.assertIn("date/time/window changed", direct[0]["transition_condition"]["prompt"])
        self.assertIn("practitioner ID", nodes["node_change_booking"]["instruction"]["text"])
        self.assertIn("Do not ask for the doctor again after a date/time-only change", flow["global_prompt"])

    def test_required_booking_contract_and_no_old_cal_tools(self):
        names = {t["name"] for t in tools.values()}
        self.assertFalse({"check_availability_cal", "book_appointment_cal"} & names)
        book = next(t for t in tools.values() if t["name"] == "book_appointment")
        self.assertTrue({"client_name","client_phone","service_name","practitioner_id","appointment_date","appointment_time","slot_id"}
                        <= set(book["parameters"]["required"]))
        self.assertEqual(flow["knowledge_base_ids"], ["knowledge_base_5e52df7d832025dc"])

if __name__ == "__main__": unittest.main()
