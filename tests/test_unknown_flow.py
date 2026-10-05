import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('unknown_fallback',ROOT/'retell/unknown-answer-fallback.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class UnknownFlowTests(unittest.TestCase):
    def setUp(self):
        source=json.loads(Path(os.environ.get('UNKNOWN_FLOW_PATH',ROOT/'retell/master/reference/golden.json')).read_text())
        self.before=source.get('conversationFlow',source)
        self.flow=module.apply_unknown_fallback(copy.deepcopy(self.before))
        self.nodes={n['id']:n for n in self.flow['nodes']}
    def test_known_configured_answers_and_sources_preserved(self):
        for k in ['knowledge_base_ids','knowledge_base']:self.assertEqual(self.flow.get(k),self.before.get(k))
        self.assertTrue(self.flow['global_prompt'].startswith(self.before['global_prompt']))
        self.assertTrue(self.nodes['node_faq']['instruction']['text'].startswith(next(n for n in self.before['nodes'] if n['id']=='node_faq')['instruction']['text']))
        self.assertIn('Preserve known configured answers normally',module.POLICY)
    def test_unknown_information_price_practitioner_and_closure_do_not_guess(self):
        for value in ['missing price','unknown practitioner','holiday/closure exception','conflicting sources','Never guess, fabricate','estimated price','absence as a negative fact',module.MESSAGE]:
            self.assertIn(value,self.nodes['node_faq']['instruction']['text'])
    def test_opt_in_only_and_no_unnecessary_collection(self):
        edge=self.nodes['node_faq']['edges'][0]
        self.assertEqual(edge['destination_node_id'],'node_unknown_prepare')
        self.assertIn('explicitly requests or accepts',edge['transition_condition']['prompt'])
        self.assertIn('Do not collect personal details or save anything unless',module.POLICY)
        tool=next(t for t in self.flow['tools'] if t['tool_id']=='tool-unknown-answer-follow-up')
        self.assertEqual(tool['parameters']['required'],['action','follow_up_requested','question'])
        self.assertEqual(tool['parameters']['properties']['follow_up_requested']['enum'],[True])
        self.assertEqual(tool['max_retry'],0)
    def test_save_failures_transport_and_stale_success_cannot_claim_receipt(self):
        self.assertIn('unknown_follow_up_saved:false',self.nodes['node_unknown_prepare']['code'])
        save=self.nodes['node_unknown_save'];self.assertTrue(save['wait_for_result'])
        self.assertEqual(save['else_edge']['destination_node_id'],'node_unknown_failed')
        self.assertEqual(save['edges'][0]['transition_condition']['equations'][0],{'left':'{{unknown_follow_up_saved}}','operator':'==','right':'true'})
        self.assertIn('Do not claim staff received',self.nodes['node_unknown_failed']['instruction']['text'])
    def test_booking_calendar_recording_other_tools_and_nodes_unchanged(self):
        for tool in self.before['tools']:self.assertEqual(next(t for t in self.flow['tools'] if t['tool_id']==tool['tool_id']),tool)
        for n in self.before['nodes']:
            after=self.nodes[n['id']]
            if n['id']=='node_faq':continue
            if n['id']=='node_global_human':
                after=copy.deepcopy(after);after['global_node_setting']['condition']=n['global_node_setting']['condition']
            self.assertEqual(after,n)
    def test_display_uses_existing_queue(self):
        ui=(ROOT/'src/components/requests.tsx').read_text()
        self.assertIn('row.reason.startsWith("AI couldn’t answer —")',ui)
        self.assertIn('"AI couldn’t answer — follow-up"',ui)
    def test_unknown_follow_up_interrupt_requires_specific_explicit_opt_in(self):
        route=self.nodes['node_unknown_follow_up']
        self.assertEqual(route['always_edge']['destination_node_id'],'node_unknown_prepare')
        condition=route['global_node_setting']['condition']
        for value in ['most recent caller turn','explicitly requests or clearly accepts','ambiguous yes','Exclude known-answer questions','booking failures and calendar availability failures']:
            self.assertIn(value,condition)
        self.assertIn('prior task',route['instruction']['text'])
    def test_idempotence(self):self.assertEqual(module.apply_unknown_fallback(copy.deepcopy(self.flow)),self.flow)
if __name__=='__main__':unittest.main()
