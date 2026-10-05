"""Add transport receipts and a terminal outage response; keep domain fallbacks intact."""
import copy
import json
import sys
from pathlib import Path
MESSAGE="I’m sorry, the clinic’s automated system is temporarily unavailable right now. Please contact the clinic directly."
POLICY='''SYSTEM DOWNTIME: Existing failed-booking, calendar-unavailable, unknown-answer, human-escalation and transfer-failure results retain their specific paths, including safe unsaved wording. Only a missing current tool response, system_unavailable=true, or a wider unexpected service error preventing those paths uses downtime. Never infer success from a prior operation or stale variables. On tool HTTP/network/timeout error transition once to node_downtime_clear; no retry, no extra persistence tool, no transfer or booking attempt. If an interrupted operation has an uncertain outcome, do not assert it succeeded OR failed; advise direct clinic contact to verify it. Previously confirmed operations remain confirmed. The downtime response ends the automated handling. Do not use clinic contact numbers from caller input, extracted variables, memory or knowledge base in this path. Only a current signed backend downtime message may include the configured contact number; otherwise use the generic message. Do not disclose raw errors. Existing webhook retries are post-call retention, not a live patient recovery path.'''

def edge(identifier,destination,prompt='Always'):
    return {'id':identifier,'destination_node_id':destination,'transition_condition':{'type':'prompt','prompt':prompt}}

def success_output(path):
    return path in ('success','available','requested_time_available','appointment_booked','follow_up_saved','transfer_allowed','availability_invalidated')

def apply_system_downtime(flow):
    if any(n['id']=='node_downtime_clear' for n in flow['nodes']):return flow
    targets={t['tool_id']:t for t in flow['tools'] if t.get('type')=='custom' and '/clinic-operations' in t.get('url','')}
    functions=[n for n in flow['nodes'] if n['type']=='function' and n.get('tool_id') in targets]
    wrappers={n['id']:'node_downtime_prepare_'+n['id'] for n in functions}
    # Every entry (including branches/code/global nodes) clears current-result flags.
    for n in flow['nodes']:
        for e in n.get('edges',[])+[n[k] for k in ['else_edge','always_edge','edge'] if k in n]:
            if e.get('destination_node_id') in wrappers:e['destination_node_id']=wrappers[e['destination_node_id']]
    if flow.get('start_node_id') in wrappers:flow['start_node_id']=wrappers[flow['start_node_id']]
    all_outputs={}
    for t in targets.values():
        t['max_retry']=0
        # Keep existing bounded timeouts; there is no per-outage automatic retry.
        t.setdefault('timeout_ms',20000)
        all_outputs.update(t.get('response_variables',{}))
        t.setdefault('response_variables',{}).update(apero_response_received='apero_response_received',apero_system_unavailable='system_unavailable',apero_downtime_message='message')
    for n in functions:
        t=targets[n['tool_id']]
        reset={'apero_response_received':False,'apero_system_unavailable':False,'apero_downtime_message':''}
        reset.update({name:False for name,path in t['response_variables'].items() if success_output(path)})
        if t['name']=='check_clinic_transfer':reset['trusted_transfer_destination']=''
        wrapper={'id':wrappers[n['id']],'name':'Clear current tool receipt','type':'code','wait_for_result':True,
            'display_position':{'x':22000,'y':len(flow['nodes'])*100},'code':'return '+json.dumps(reset)+';',
            'response_variables':{k:k for k in reset},'edges':[edge('edge_downtime_prepare_'+n['id'],n['id'])],
            'else_edge':edge('edge_downtime_prepare_failed_'+n['id'],'node_downtime_clear','Else')}
        flow['nodes'].append(wrapper)
        n['wait_for_result']=True
        receipt={'id':'edge_downtime_'+n['id'],'destination_node_id':'node_downtime_clear','transition_condition':{'type':'equation','operator':'||','equations':[
            {'left':'{{apero_response_received}}','operator':'!=','right':'true'},
            {'left':'{{apero_system_unavailable}}','operator':'==','right':'true'}]}}
        n['edges']=[receipt]+n.get('edges',[])
        if 'always_edge' in n:n['edges'].append(n.pop('always_edge'))
    clear={name:False for name,path in all_outputs.items() if success_output(path)}
    clear.update({name:'' for name,path in all_outputs.items() if path in ('appointment_id','request_id','follow_up_request_id','transfer_destination')})
    clear.update({name:[] for name,path in all_outputs.items() if path in ('appointments','slots')})
    clear.update(apero_downtime_active=True)
    flow['nodes'].extend([
        {'id':'node_downtime_clear','name':'Stop automated handling safely','type':'code','wait_for_result':True,
         'display_position':{'x':23000,'y':1000},'code':'return '+json.dumps(clear)+';',
         'response_variables':{k:k for k in clear},'edges':[edge('edge_downtime_speak','node_system_downtime')],
         'else_edge':edge('edge_downtime_clear_failed','node_system_downtime','Else')},
        {'id':'node_system_downtime','name':'Automated system temporarily unavailable','type':'conversation','skippable':False,
         'display_position':{'x':23500,'y':1000},'instruction':{'type':'prompt','text':
            'In the established caller language say: '+MESSAGE+' Only if apero_response_received is true AND apero_system_unavailable is true, use the current apero_downtime_message instead; that backend message may include a trusted clinic contact number. Never read a number from any other source. Never say an appointment, cancellation, reschedule, transfer or follow-up was confirmed by the interrupted operation. Do not claim an uncertain operation failed either. If needed explain that the clinic can verify its outcome. Do not retry tools or offer another automated action. End after delivering this message.'},
         'edges':[edge('edge_downtime_end','node_end')]},
    ])
    for n in flow['nodes']:
        if 'global_node_setting' in n:
            n['global_node_setting']['condition']+=' Do not interrupt node_downtime_clear or node_system_downtime, or restart automation after apero_downtime_active is true.'
    flow['global_prompt']+='\n'+POLICY
    return flow
if __name__=='__main__':
    data=json.loads(Path(sys.argv[1]).read_text());apply_system_downtime(data.get('conversationFlow',data))
    Path(sys.argv[2]).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
