import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
ROOT = Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('calendar_fallback',ROOT/'retell/calendar-fallback.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class CalendarFlowTests(unittest.TestCase):
    def setUp(self):
        source=json.loads(Path(os.environ.get('CALENDAR_FLOW_PATH',ROOT/'retell/master/reference/golden.json')).read_text())
        self.before=source.get('conversationFlow',source)
        self.flow=module.apply_calendar_fallback(copy.deepcopy(self.before))
        self.nodes={n['id']:n for n in self.flow['nodes']}
    def test_failed_availability_and_transport_route_safely(self):
        tools=[t for t in self.flow['tools'] if t['name'] in ['check_availability','check_fresh_availability']]
        for t in tools:
            self.assertEqual(t['max_retry'],0)
            for n in self.flow['nodes']:
                if n.get('tool_id') != t['tool_id']:continue
                self.assertEqual(n['edges'][0]['destination_node_id'],'node_calendar_unavailable')
                self.assertEqual(n['edges'][0]['transition_condition']['equations'][0]['right'],'calendar_unavailable')
                self.assertEqual(n['else_edge']['destination_node_id'],'node_calendar_unavailable')
                prepare=self.nodes['node_calendar_prepare_'+n['id']]
                for value in ['availability_success:false','available:false',"slots:'[]'",'calendar_follow_up_saved:false']:
                    self.assertIn(value,prepare['code'])
                self.assertTrue(prepare['wait_for_result'])
    def test_no_path_from_fallback_to_booking_or_check(self):
        visited=set();queue=['node_calendar_unavailable']
        while queue:
            identifier=queue.pop()
            if identifier in visited:continue
            visited.add(identifier);n=self.nodes[identifier]
            if n.get('tool_id'):self.assertEqual(n['tool_id'],'tool-calendar-follow-up')
            queue.extend(e['destination_node_id'] for e in n.get('edges',[])+[n.get('else_edge',{}),n.get('always_edge',{})] if e.get('destination_node_id'))
        self.assertIn('node_calendar_save_failed',visited)
        self.assertEqual(self.nodes['node_calendar_save']['edges'][0]['transition_condition']['equations'][0]['left'],'{{calendar_follow_up_saved}}')
    def test_unrelated_tools_and_booking_unchanged(self):
        for name in ['book_appointment','persist_callback','persist_message']:
            self.assertEqual(next(t for t in self.flow['tools'] if t['name']==name),next(t for t in self.before['tools'] if t['name']==name))
        for identifier in ['node_book','node_book_failed']:
            self.assertEqual(self.nodes[identifier],next(n for n in self.before['nodes'] if n['id']==identifier))
    def test_requests_label(self):
        source=(ROOT/'src/components/requests.tsx').read_text()
        self.assertIn('row.reason.startsWith("Calendar unavailable —")',source)
        self.assertIn('"Calendar unavailable — follow-up"',source)
    def test_patch_is_idempotent(self):
        self.assertEqual(module.apply_calendar_fallback(copy.deepcopy(self.flow)),self.flow)

if __name__=='__main__':unittest.main()
