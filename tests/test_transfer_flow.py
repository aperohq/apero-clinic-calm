import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('transfer',ROOT/'retell/call-transfer.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class TransferFlowTests(unittest.TestCase):
    def setUp(self):
        data=json.loads(Path(os.environ.get('TRANSFER_FLOW_PATH',ROOT/'retell/master/reference/golden.json')).read_text())
        self.before=data.get('conversationFlow',data)
        if not any(n['id']=='node_human_prepare' for n in self.before['nodes']):
            human_spec=importlib.util.spec_from_file_location('human',ROOT/'retell/human-escalation.py');human=importlib.util.module_from_spec(human_spec);human_spec.loader.exec_module(human);human.apply_human_escalation(self.before)
        self.flow=module.apply_call_transfer(copy.deepcopy(self.before));self.nodes={n['id']:n for n in self.flow['nodes']}
    def test_native_transfer_only_uses_backend_dynamic_destination(self):
        node=self.nodes['node_transfer_native']
        self.assertEqual(node['type'],'transfer_call')
        self.assertEqual(node['transfer_destination'],{'type':'predefined','number':'{{trusted_transfer_destination}}'})
        self.assertFalse(node['ignore_e164_validation'])
        for t in self.flow['tools'][-2:]:
            self.assertNotIn('transfer_destination',t['parameters']['properties'])
            self.assertNotIn('clinic_id',t['parameters']['properties'])
    def test_authorization_reset_wait_and_deterministic_edge(self):
        self.assertIn('transfer_allowed:false',self.nodes['node_transfer_prepare']['code'])
        self.assertIn("trusted_transfer_destination:''",self.nodes['node_transfer_prepare']['code'])
        gate=self.nodes['node_transfer_gate'];self.assertTrue(gate['wait_for_result'])
        allowed=gate['edges'][0]
        self.assertEqual(allowed['destination_node_id'],'node_transfer_native')
        self.assertEqual(allowed['transition_condition']['equations'][0],{'left':'{{transfer_allowed}}','operator':'==','right':'true'})
        self.assertEqual(gate['else_edge']['destination_node_id'],'node_transfer_unavailable')
        self.assertIn({'left':'{{trusted_transfer_destination}}','operator':'!=','right':''},allowed['transition_condition']['equations'])
    def test_before_transfer_language_and_no_premature_success(self):
        node=self.nodes['node_transfer_native'];self.assertTrue(node['speak_during_execution'])
        self.assertIn('I’ll try to connect you with the clinic team now',node['instruction']['text'])
        self.assertIn('established caller language',node['instruction']['text'])
        self.assertIn('Do not say staff have answered',node['instruction']['text'])
    def test_single_warm_attempt_failure_route_and_no_provider_integration(self):
        node=self.nodes['node_transfer_native'];option=node['transfer_option']
        self.assertEqual(option['type'],'warm_transfer');self.assertFalse(option['show_transferee_as_caller'])
        self.assertFalse(option['opt_out_human_detection']);self.assertEqual(option['transfer_ring_duration_ms'],20000)
        self.assertEqual(node['edge']['destination_node_id'],'node_transfer_failed')
        self.assertEqual(node['edge']['transition_condition']['prompt'],'Transfer failed')
        self.assertEqual(sum(n['type']=='transfer_call' for n in self.flow['nodes']),1)
        for t in self.flow['tools'][-2:]:self.assertEqual(t['max_retry'],0)
    def test_unavailable_and_after_hours_reuse_existing_human_path(self):
        self.assertEqual(self.nodes['node_transfer_unavailable']['edges'][0]['destination_node_id'],'node_human_prepare')
        node=self.nodes['node_transfer_after_hours'];self.assertIn('not currently available for transfer',node['instruction']['text'])
        self.assertEqual(node['edges'][0]['destination_node_id'],'node_human_prepare')
        self.assertEqual(node['edges'][1]['destination_node_id'],'node_anything_else')
        self.assertIn('if assistance is still wanted',module.POLICY)
    def test_failure_receipt_requires_actual_save_and_stale_evidence_is_cleared(self):
        self.assertIn('transfer_follow_up_saved:false',self.nodes['node_transfer_prepare']['code'])
        save=self.nodes['node_transfer_fallback'];self.assertTrue(save['wait_for_result'])
        self.assertEqual(save['edges'][0]['transition_condition']['equations'][0]['left'],'{{transfer_follow_up_saved}}')
        self.assertEqual(save['else_edge']['destination_node_id'],'node_transfer_follow_up_failed')
        self.assertIn('couldn’t pass your request',self.nodes['node_transfer_follow_up_failed']['instruction']['text'])
        self.assertIn('Never promise a callback time',self.nodes['node_transfer_follow_up_saved']['instruction']['text'])
    def test_existing_retention_and_specific_fallbacks_unchanged(self):
        for tool in self.before['tools']:self.assertEqual(tool,next(t for t in self.flow['tools'] if t['tool_id']==tool['tool_id']))
        for node in self.before['nodes']:
            after=copy.deepcopy(self.nodes[node['id']])
            for e in after.get('edges',[])+([after['always_edge']] if 'always_edge' in after else []):
                if e.get('destination_node_id')=='node_transfer_prepare':e['destination_node_id']='node_human_prepare'
            if node['id'] in ['node_global_human','node_human_collect']:
                after['instruction']=node['instruction']
            if node['id']=='node_global_human':after['global_node_setting']=node['global_node_setting']
            self.assertEqual(node,after)
        for key,val in self.before.items():
            if key not in ['nodes','tools','global_prompt']:self.assertEqual(self.flow[key],val)
    def test_only_appropriate_triggers_no_automatic_transfer_every_escalation(self):
        for value in ['explicit request to speak','live transfer is appropriate only','staff follow-up alone does not require transfer','Never transfer normal supported requests','medical symptoms by AI judgment','specific booking/calendar/unknown-answer follow-ups']:
            self.assertIn(value,module.POLICY)
    def test_idempotence(self):self.assertEqual(module.apply_call_transfer(copy.deepcopy(self.flow)),self.flow)
if __name__=='__main__':unittest.main()
