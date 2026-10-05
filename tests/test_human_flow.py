import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('human_escalation',ROOT/'retell/human-escalation.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class HumanFlowTests(unittest.TestCase):
    def setUp(self):
        data=json.loads(Path(os.environ.get('HUMAN_FLOW_PATH',ROOT/'retell/master/reference/golden.json')).read_text())
        self.before=data.get('conversationFlow',data)
        self.flow=module.apply_human_escalation(copy.deepcopy(self.before))
        self.nodes={n['id']:n for n in self.flow['nodes']}
    def test_triggers_and_normal_requests(self):
        for value in ['explicitly requests clinic staff','cannot safely be completed','requires clinic judgment','repeated failures','appointment dispute','unsupported operational action','Exclude normal supported questions']:
            self.assertIn(value,module.CONDITION)
        self.assertEqual(self.nodes['node_global_human']['always_edge']['destination_node_id'],'node_human_prepare')
    def test_specific_fallback_precedence_and_no_triage(self):
        for value in ['unknown-answer opt-in path','failed booking','calendar availability failure','Never infer medical urgency','existing urgent-request path']:
            self.assertIn(value,module.CONDITION)
        self.assertIn('do not create a second general escalation',module.POLICY)
        self.assertIn('Do not make medical judgments or perform medical triage',module.POLICY)
    def test_existing_nodes_tools_and_settings_preserved(self):
        for node in self.before['nodes']:
            if node['id']=='node_global_human':continue
            after=copy.deepcopy(self.nodes[node['id']])
            if node['id'] in ['node_faq','node_initial_faq','node_anything_else']:
                added=next(e for e in after['edges'] if e['id']=='edge_'+node['id']+'_human')
                self.assertEqual(added['destination_node_id'],'node_human_prepare')
                after['edges'].remove(added)
            for old,new in zip(node.get('edges',[]),after.get('edges',[])):
                prompt=old.get('transition_condition',{}).get('prompt','')
                if prompt=='Caller explicitly wants a human or staff callback':
                    self.assertIn('not a request for direct human assistance',new['transition_condition']['prompt'])
                    new['transition_condition']['prompt']=prompt
                if prompt=='Caller asks for a human receptionist' and node['id']=='node_initial_language':
                    self.assertEqual(new['destination_node_id'],'node_human_prepare')
                    new['destination_node_id']=old['destination_node_id']
            self.assertEqual(node,after)
        for tool in self.before['tools']:
            self.assertEqual(tool,next(t for t in self.flow['tools'] if t['tool_id']==tool['tool_id']))
        for key,value in self.before.items():
            if key not in ['nodes','tools','global_prompt']:self.assertEqual(value,self.flow[key])
        self.assertTrue(self.flow['global_prompt'].startswith(self.before['global_prompt']))
    def test_optional_minimal_details_and_no_transfer(self):
        tool=next(t for t in self.flow['tools'] if t['name']=='retain_human_escalation')
        self.assertEqual(tool['parameters']['required'],['action','escalation_required','escalation_category','reason'])
        self.assertNotIn('clinic_id',tool['parameters']['properties'])
        self.assertEqual(tool['max_retry'],0)
        self.assertEqual(tool['parameters']['properties']['action']['enum'],['human_escalation'])
        for text in ['optional if declined','Never require an explanation','If caller withdraws','Do not resume attempts']:
            self.assertIn(text,self.nodes['node_human_collect']['instruction']['text'])
        added=self.flow['nodes'][len(self.before['nodes']):]
        self.assertFalse(any(n['type']=='transfer_call' for n in added))
    def test_save_evidence_cleared_and_failure_safe(self):
        self.assertIn('human_follow_up_saved:false',self.nodes['node_human_prepare']['code'])
        save=self.nodes['node_human_save']
        self.assertTrue(save['wait_for_result'])
        self.assertEqual(save['edges'][0]['transition_condition']['equations'][0],{'left':'{{human_follow_up_saved}}','operator':'==','right':'true'})
        self.assertEqual(save['else_edge']['destination_node_id'],'node_human_failed')
        self.assertEqual(save['else_edge']['transition_condition']['prompt'],'Else')
        self.assertEqual(self.nodes['node_human_prepare']['else_edge']['transition_condition']['prompt'],'Else')
        self.assertIn(module.FAILED,self.nodes['node_human_failed']['instruction']['text'])
        self.assertIn('Do not claim staff received',self.nodes['node_human_failed']['instruction']['text'])
        self.assertIn('Never promise callback timing',self.nodes['node_human_saved']['instruction']['text'])
    def test_idempotence(self):
        self.assertEqual(module.apply_human_escalation(copy.deepcopy(self.flow)),self.flow)
if __name__=='__main__':unittest.main()
