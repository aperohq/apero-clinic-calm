"""A guarded native warm-transfer path; destinations come only from signed backend config."""
import copy
import json
import sys
from pathlib import Path
POLICY='''CALL TRANSFER: An explicit request to speak to clinic staff/a human qualifies for a live transfer check. For other existing human-escalation cases, live transfer is appropriate only when direct staff conversation is needed now or the caller accepts an offer of live connection; staff follow-up alone does not require transfer. Never transfer normal supported requests, medical symptoms by AI judgment, or specific booking/calendar/unknown-answer follow-ups. Respect all existing specific fallback behavior. Use node_transfer_prepare before any live transfer; the backend determines trusted destination, hours, clinic activation and call type. Never infer clinic hours, supply/override a destination, use caller-provided numbers as a destination, or claim success before a verified bridge. Transfer only if transfer_allowed is true and the destination is nonempty from the current backend result. Say in the established caller language: I’ll try to connect you with the clinic team now. A request already saved for follow-up does not authorize a new live transfer. Only one attempt per call; never retry after busy, no answer, rejection, timeout or technical failure. Missing destination/disabled provider uses existing Human Escalation. Outside configured hours say staff are not currently available for transfer, then use existing Human Escalation if assistance is still wanted. Failure goes to transfer fallback; never promise a callback time.'''
OLD_NO_TRANSFER='No live call transfer is configured or performed by this path.'
NEW_NO_TRANSFER='This Human Escalation path records clinic follow-up; live transfer eligibility is handled separately by the guarded transfer path.'

def apply_call_transfer(flow):
    if any(n['id']=='node_transfer_prepare' for n in flow['nodes']):return flow
    def edge(identifier,destination,prompt='Always'):
        return {'id':identifier,'destination_node_id':destination,'transition_condition':{'type':'prompt','prompt':prompt}}
    def equation(identifier,destination,name,value):
        return {'id':identifier,'destination_node_id':destination,'transition_condition':{'type':'equation','operator':'&&','equations':[{'left':'{{'+name+'}}','operator':'==','right':value}]}}
    def conversation(identifier,name,text,edges):
        return {'id':identifier,'name':name,'type':'conversation','skippable':False,'display_position':{'x':19500,'y':1000},'instruction':{'type':'prompt','text':text},'edges':edges}
    # Route existing human entries through the guard; preservation of retention is intentional.
    for node in flow['nodes']:
        for e in node.get('edges',[])+([node['always_edge']] if 'always_edge' in node else []):
            if e.get('destination_node_id')=='node_human_prepare':e['destination_node_id']='node_transfer_prepare'
        if node['id'] in ['node_global_human','node_human_collect']:
            node['instruction']['text']=node['instruction']['text'].replace(OLD_NO_TRANSFER,NEW_NO_TRANSFER)
        if node['id']=='node_global_human':
            node['instruction']['text']+='\n'+POLICY
            node['global_node_setting']['condition']+=' Do not interrupt an active transfer gate, native transfer, unavailable or failure follow-up path.'
    flow['global_prompt']=flow['global_prompt'].replace(OLD_NO_TRANSFER,NEW_NO_TRANSFER).replace('This demo has NO configured staff transfer number. Never say a transfer occurred.','Live staff transfer depends on trusted clinic configuration and the transfer guard. Never claim a transfer succeeded before a verified bridge.')+'\n'+POLICY
    source=next(t for t in flow['tools'] if t['name']=='retain_human_escalation')
    gate=copy.deepcopy(source)
    gate.update(tool_id='tool-transfer-gate',name='check_clinic_transfer',max_retry=0,timeout_ms=12000,
        description='Check trusted live-transfer eligibility. No dialing or follow-up saving. No destination argument permitted.',
        response_variables={'transfer_allowed':'transfer_allowed','trusted_transfer_destination':'transfer_destination','transfer_result':'transfer_result'},
        parameters={'type':'object','required':['action','escalation_category','explicit_human_request','live_transfer_appropriate'],'properties':{
            'action':{'type':'string','enum':['transfer_gate']},
            'escalation_category':copy.deepcopy(source['parameters']['properties']['escalation_category']),
            'explicit_human_request':{'type':'boolean','description':'True only when the caller explicitly asks to speak to clinic staff/a human.'},
            'live_transfer_appropriate':{'type':'boolean','description':'True only for an existing human escalation needing direct staff conversation now, or when caller accepts a live connection. False when follow-up is sufficient.'}}})
    fallback=copy.deepcopy(source)
    fallback.update(tool_id='tool-transfer-fallback',name='retain_transfer_follow_up',max_retry=0,timeout_ms=12000,
        description='Only after native transfer failure, reuse Human Escalation. Never accept caller-provided success/failure status or destination. Receipt only after affirmative save.',
        response_variables={'transfer_follow_up_saved':'follow_up_saved','transfer_follow_up_id':'follow_up_request_id','transfer_result':'transfer_result'},
        parameters={'type':'object','required':['action'],'properties':{
            'action':{'type':'string','enum':['transfer_fallback']},
            'patient_name':{'type':'string','description':'Name if already supplied; optional.'},
            'caller_phone':{'type':'string','description':'Confirmed contact if supplied; optional. No fabricated contact details.'}}})
    flow['tools'].extend([gate,fallback])
    allowed=equation('edge_transfer_allowed','node_transfer_native','transfer_allowed','true')
    allowed['transition_condition']['equations'].extend([{'left':'{{trusted_transfer_destination}}','operator':'!=','right':''},{'left':'{{trusted_transfer_destination}}','operator':'!=','right':'null'}])
    flow['nodes'].extend([
        {'id':'node_transfer_prepare','name':'Clear transfer authorization','type':'code','wait_for_result':True,'display_position':{'x':18500,'y':1000},
         'code':"return {transfer_allowed:false,trusted_transfer_destination:'',transfer_result:'provider_error',transfer_follow_up_saved:false,transfer_follow_up_id:''};",
         'response_variables':{'transfer_allowed':'transfer_allowed','trusted_transfer_destination':'trusted_transfer_destination','transfer_result':'transfer_result','transfer_follow_up_saved':'transfer_follow_up_saved','transfer_follow_up_id':'transfer_follow_up_id'},
         'edges':[edge('edge_transfer_prepare','node_transfer_gate')],'else_edge':edge('edge_transfer_prepare_failed','node_transfer_unavailable','Else')},
        {'id':'node_transfer_gate','name':'Trusted clinic transfer guard','type':'function','tool_type':'local','tool_id':gate['tool_id'],'wait_for_result':True,'speak_during_execution':False,'display_position':{'x':19000,'y':1000},
         'edges':[allowed,equation('edge_transfer_after_hours','node_transfer_after_hours','transfer_result','after_hours'),equation('edge_transfer_already_succeeded','node_transfer_done','transfer_result','success'),equation('edge_transfer_follow_up_only','node_human_prepare','transfer_result','not_requested'),equation('edge_transfer_previous_failure','node_transfer_fallback','transfer_result','previous_failure'),equation('edge_transfer_no_retry','node_transfer_done','transfer_result','already_attempted')],
         'else_edge':edge('edge_transfer_unavailable','node_transfer_unavailable','Else')},
        {'id':'node_transfer_native','name':'Attempt clinic staff connection','type':'transfer_call','display_position':{'x':19500,'y':1000},
         'transfer_destination':{'type':'predefined','number':'{{trusted_transfer_destination}}'},'ignore_e164_validation':False,
         'transfer_option':{'type':'warm_transfer','show_transferee_as_caller':False,'transfer_ring_duration_ms':20000,'agent_detection_timeout_ms':15000,'opt_out_human_detection':False,'on_hold_music':'ringtone'},
         'speak_during_execution':True,'instruction':{'type':'prompt','text':'In the established caller language say only: I’ll try to connect you with the clinic team now. Do not say staff have answered or the transfer succeeded.'},
         'edge':edge('edge_transfer_native_failed','node_transfer_failed','Transfer failed')},
        conversation('node_transfer_unavailable','Live transfer unavailable','In the established language say the clinic team will need to assist directly and live transfer is not available. Do not pretend a connection was attempted. Continue existing Human Escalation, reusing known information. Do not promise receipt until saved or callback timing.',[edge('edge_transfer_unavailable_human','node_human_prepare')]),
        conversation('node_transfer_after_hours','Clinic team unavailable for transfer','Say in the established language: The clinic team is not currently available for transfer. I can pass your request to them for follow-up. Do not state invented hours. Continue existing Human Escalation if the caller still wants assistance; save nothing if they decline.',[edge('edge_transfer_hours_follow_up','node_human_prepare','Caller still wants clinic assistance/follow-up'),edge('edge_transfer_hours_decline','node_anything_else','Caller declines follow-up')]),
        conversation('node_transfer_failed','Clinic team could not be reached','Say the clinic team could not be reached right now. Never retry or claim the request was saved yet. Reuse existing supplied name and confirmed follow-up phone; ask for missing optional contact only if wanted, one question at a time, allow declining. Save using retain_transfer_follow_up. Do not ask for a transcript, symptoms or unrelated details. If caller declines all contact, still record the required staff assistance without invented contact.',[edge('edge_transfer_failed_save','node_transfer_fallback','Optional contact supplied, already known or declined')]),
        {'id':'node_transfer_fallback','name':'Retain failed transfer follow-up','type':'function','tool_type':'local','tool_id':fallback['tool_id'],'wait_for_result':True,'speak_during_execution':False,'display_position':{'x':20000,'y':1000},
         'edges':[equation('edge_transfer_follow_up_saved','node_transfer_follow_up_saved','transfer_follow_up_saved','true'),equation('edge_transfer_late_success','node_transfer_done','transfer_result','success')],
         'else_edge':edge('edge_transfer_follow_up_failed','node_transfer_follow_up_failed','Else')},
        conversation('node_transfer_follow_up_saved','Failed transfer — follow-up saved','Only because transfer_follow_up_saved is true say: The clinic team could not be reached right now. Your request has been passed to them for follow-up. Never promise a callback time. If no phone supplied advise direct clinic contact using configured details. Do not retry.',[edge('edge_transfer_saved_done','node_anything_else')]),
        conversation('node_transfer_follow_up_failed','Failed transfer — follow-up not saved','Say: The clinic team could not be reached right now, and I couldn’t pass your request to them. Please contact the clinic directly. Use only configured clinic contact details. No receipt/callback promise or retry.',[edge('edge_transfer_save_failed_done','node_anything_else')]),
        conversation('node_transfer_done','Transfer already succeeded','A transfer was already authorized for this call. Do not dial again or create a failure request. If transfer_result is success, a trusted provider bridge has been recorded and normally the AI has left the call. Otherwise the outcome is pending: do not claim success or failure. Do not promise another transfer.',[edge('edge_transfer_done','node_end')])])
    return flow
if __name__=='__main__':
    data=json.loads(Path(sys.argv[1]).read_text());apply_call_transfer(data.get('conversationFlow',data))
    Path(sys.argv[2]).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
