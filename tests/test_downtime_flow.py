import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('downtime',ROOT/'retell/system-downtime.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class DowntimeFlowTests(unittest.TestCase):
 def setUp(self):
  data=json.loads(Path(os.environ.get('DOWNTIME_FLOW_PATH',ROOT/'retell/master/reference/golden.json')).read_text());self.before=data.get('conversationFlow',data)
  self.flow=module.apply_system_downtime(copy.deepcopy(self.before));self.nodes={n['id']:n for n in self.flow['nodes']};self.tools={t['tool_id']:t for t in self.flow['tools']}
 def functions(self):return [n for n in self.before['nodes'] if n['type']=='function' and '/clinic-operations' in self.tools.get(n.get('tool_id'),{}).get('url','')]
 def test_every_critical_tool_has_current_receipt_guard_and_no_retry(self):
  self.assertGreater(len(self.functions()),10)
  for old in self.functions():
   n=self.nodes[old['id']];self.assertTrue(n['wait_for_result']);self.assertNotIn('always_edge',n)
   e=n['edges'][0];self.assertEqual(e['destination_node_id'],'node_downtime_clear');self.assertEqual(e['transition_condition']['operator'],'||')
   self.assertEqual(self.tools[n['tool_id']]['max_retry'],0)
   self.assertEqual(self.tools[n['tool_id']]['response_variables']['apero_response_received'],'apero_response_received')
 def test_reset_prevents_stale_success_on_transport_failure(self):
  for old in self.functions():
   n=self.nodes['node_downtime_prepare_'+old['id']];body=json.loads(n['code'][len('return '):-1]);self.assertFalse(body['apero_response_received']);self.assertEqual(body['apero_downtime_message'],'')
   for name,path in self.tools[old['tool_id']]['response_variables'].items():
    if module.success_output(path):self.assertFalse(body[name])
 def test_all_function_entry_routes_pass_through_reset(self):
  funcs={n['id'] for n in self.functions()}
  for n in self.flow['nodes']:
   if n['id'].startswith('node_downtime_prepare_'):continue
   for e in n.get('edges',[])+[n[k] for k in ('edge','always_edge','else_edge') if k in n]:self.assertNotIn(e.get('destination_node_id'),funcs)
 def test_original_specific_fallback_edges_preserved_after_receipt_check(self):
  wrappers={n['id']:'node_downtime_prepare_'+n['id'] for n in self.functions()}
  for old in self.functions():
   original=copy.deepcopy(old.get('edges',[])+([old['always_edge']] if 'always_edge' in old else []))
   for e in original:
    if e.get('destination_node_id') in wrappers:e['destination_node_id']=wrappers[e['destination_node_id']]
   self.assertEqual(self.nodes[old['id']]['edges'][1:],original)
   if 'else_edge' in old:
    original=copy.deepcopy(old['else_edge']);original['destination_node_id']=wrappers.get(original.get('destination_node_id'),original.get('destination_node_id'));self.assertEqual(self.nodes[old['id']]['else_edge'],original)
 def test_no_booking_or_transfer_or_retention_in_downtime_path(self):
  clear=self.nodes['node_downtime_clear'];say=self.nodes['node_system_downtime']
  self.assertEqual(clear['edges'][0]['destination_node_id'],'node_system_downtime');self.assertEqual(say['edges'][0]['destination_node_id'],'node_end');self.assertEqual(clear['else_edge']['destination_node_id'],'node_system_downtime')
  self.assertIn(module.MESSAGE,say['instruction']['text']);self.assertIn('Never read a number from any other source',say['instruction']['text'])
  self.assertIn('uncertain outcome',self.flow['global_prompt'])
 def test_global_routes_do_not_restart_automation(self):
  for n in self.flow['nodes']:
   if 'global_node_setting' in n:self.assertIn('apero_downtime_active is true',n['global_node_setting']['condition'])
 def test_unrelated_flow_security_and_tool_arguments_unchanged(self):
  for k,v in self.before.items():
   if k not in ('nodes','tools','global_prompt','start_node_id'):self.assertEqual(self.flow[k],v)
  for old in self.before['tools']:
   new=self.tools[old['tool_id']]
   for k,v in old.items():
    if k not in ('response_variables','max_retry','timeout_ms'):self.assertEqual(new[k],v)
 def test_idempotent(self):self.assertEqual(module.apply_system_downtime(copy.deepcopy(self.flow)),self.flow)
 def test_code_nodes_execute_actual_resets(self):
  for n in self.flow['nodes']:
   if n['id'].startswith('node_downtime_') and n['type']=='code':
    code="const result=(new Function("+json.dumps(n['code'])+"))(); if(result.apero_response_received===true)process.exit(1);"
    subprocess.run(['node','-e',code],check=True)
if __name__=='__main__':unittest.main()
