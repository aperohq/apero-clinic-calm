"""General staff escalation using the existing signed Requests endpoint; no transfer."""
import copy
import json
import sys
from pathlib import Path

MESSAGE = 'This request needs clinic staff assistance. I’ll pass this to the clinic team so they can help you directly.'
FAILED = 'I couldn’t pass your request to the clinic team. Please contact the clinic directly.'
POLICY = '''HUMAN ESCALATION: Stop attempting to resolve the issue yourself when the caller explicitly asks for clinic staff/a human, a supported operational request cannot safely be completed, clinic judgment is needed, repeated failures prevent completion, an appointment dispute cannot safely be resolved, or the caller requests an unsupported operational action. Do not make medical judgments or perform medical triage. Normal supported questions and operational requests continue normally without escalation. Use the existing specific Failed booking, Calendar unavailable and unknown-information follow-up paths whenever those describe the problem; do not create a second general escalation for that same problem. Unknown facts retain explicit opt-in behavior. An explicit human request that is not that specific follow-up uses human escalation. Do not attempt more tool retries after repeated failures. No live call transfer is configured or performed by this path. Say in the established caller language: %s Never claim resolution or staff receipt before a confirmed save. Collect only a concise operational reason and optional supplied name and confirmed follow-up phone; reuse known details, permit declining contact details, never collect a transcript, symptoms, diagnosis or unrelated personal details. Never promise a callback time. Use node_human_prepare and retain_human_escalation.''' % MESSAGE
CONDITION = '''The most recent caller turn explicitly requests clinic staff, a human, manager or receptionist; or the operational request cannot safely be completed, requires clinic judgment, remains incomplete after repeated failures, involves an appointment dispute that Apero cannot safely resolve, or asks for an unsupported operational action. Exclude normal supported questions or requests, unanswered factual questions (use the unknown-answer opt-in path), failed booking (use its specific follow-up), and calendar availability failure (use calendar follow-up). Never infer medical urgency or make a clinical judgment from symptoms; preserve the existing urgent-request path. Do not interrupt an active human escalation collection/save/result path or create another escalation for the same issue.'''

def apply_human_escalation(flow):
    if any(n['id']=='node_human_prepare' for n in flow['nodes']):
        return flow
    def edge(identifier,destination,prompt='Always'):
        return {'id':identifier,'destination_node_id':destination,'transition_condition':{'type':'prompt','prompt':prompt}}
    human=next(n for n in flow['nodes'] if n['id']=='node_global_human')
    human['instruction']['text']=POLICY
    human['global_node_setting']['condition']=CONDITION
    human['always_edge']['destination_node_id']='node_human_prepare'
    # Explicit local exits must agree with the global interrupt, including the first turn.
    for node in flow['nodes']:
        for existing in node.get('edges',[]):
            prompt=existing.get('transition_condition',{}).get('prompt','')
            if prompt == 'Caller asks for a human receptionist' and node['id']=='node_initial_language':
                existing['destination_node_id']='node_human_prepare'
            elif prompt == 'Caller explicitly wants a human or staff callback':
                existing['transition_condition']['prompt']='Caller explicitly requests only a callback; not a request for direct human assistance or unknown-information follow-up'
        if node['id'] in ['node_faq','node_initial_faq','node_anything_else']:
            position=1 if node['edges'] and node['edges'][0].get('destination_node_id')=='node_unknown_prepare' else 0
            node['edges'].insert(position,edge('edge_'+node['id']+'_human','node_human_prepare',
                'Caller explicitly requests direct human or clinic staff assistance. Exclude specific unknown-information follow-up, failed booking and calendar unavailable follow-up; keep those specific routes.'))
    source=next(t for t in flow['tools'] if t['name']=='persist_callback')
    tool=copy.deepcopy(source)
    tool.update(tool_id='tool-human-escalation',name='retain_human_escalation',max_retry=0,timeout_ms=10000,speak_after_execution=False,
        description='Save required human assistance to existing Requests. No live transfer, booking or medical triage. Use specific booking/calendar/unknown-answer fallback instead when applicable.',
        response_variables={'human_follow_up_saved':'follow_up_saved','human_request_id':'follow_up_request_id'},
        parameters={'type':'object','required':['action','escalation_required','escalation_category','reason'],'properties':{
            'action':{'type':'string','enum':['human_escalation']},
            'escalation_required':{'type':'boolean','enum':[True]},
            'escalation_category':{'type':'string','enum':['explicit_human_request','unsafe_to_complete','clinic_judgment','repeated_failure','appointment_dispute','unsupported_operation']},
            'reason':{'type':'string','description':'Concise operational request/reason, maximum 1000 characters. No transcript, symptom details, diagnosis or unrelated personal data.'},
            'patient_name':{'type':'string','description':'Name only if supplied; optional.'},
            'caller_phone':{'type':'string','description':'Confirmed contact phone only if supplied; optional. Never invent.'}}})
    flow['tools'].append(tool)
    def conversation(identifier,name,text):
        return {'id':identifier,'name':name,'type':'conversation','skippable':False,'display_position':{'x':17500,'y':1000},'instruction':{'type':'prompt','text':text},'edges':[edge('edge_'+identifier+'_done','node_anything_else')]}
    collect=conversation('node_human_collect','Human assistance — concise details',POLICY+' Ask one question at a time for missing name and confirmed follow-up phone, each optional if declined. If the reason is already known do not ask again. Never require an explanation for asking for staff; use “Caller requested clinic staff assistance” if none supplied. Explicit staff requests authorize saving this operational request; do not demand additional consent. If caller withdraws the request, save nothing. Do not resume attempts to resolve the escalated issue.')
    collect['edges']=[edge('edge_human_save','node_human_save','Escalation is required, concise reason/category known, and optional name/phone supplied or declined'),edge('edge_human_withdraw','node_anything_else','Caller withdraws the escalation request')]
    flow['nodes'].extend([
        {'id':'node_human_prepare','name':'Clear human escalation save evidence','type':'code','wait_for_result':True,'display_position':{'x':17000,'y':1000},
         'code':"return {human_follow_up_saved:false,human_request_id:''};",'response_variables':{'human_follow_up_saved':'human_follow_up_saved','human_request_id':'human_request_id'},
         'edges':[edge('edge_human_prepare','node_human_collect')],'else_edge':edge('edge_human_prepare_failed','node_human_failed','Else')},collect,
        {'id':'node_human_save','name':'Save human assistance request','type':'function','tool_type':'local','tool_id':tool['tool_id'],'wait_for_result':True,'speak_during_execution':False,'display_position':{'x':18000,'y':1000},
         'edges':[{'id':'edge_human_saved','destination_node_id':'node_human_saved','transition_condition':{'type':'equation','operator':'&&','equations':[{'left':'{{human_follow_up_saved}}','operator':'==','right':'true'}]}}],
         'else_edge':edge('edge_human_failed','node_human_failed','Else')},
        conversation('node_human_saved','Human assistance request saved','Only because human_follow_up_saved is true, say in the established language: Your request was passed to the clinic team so they can help you directly. The issue still needs staff assistance; never claim resolution or live transfer. Never promise callback timing. If no phone supplied, say no contact number was supplied and advise contacting the clinic directly using only configured clinic contact details. Do not retry the escalated task.'),
        conversation('node_human_failed','Human assistance request not saved','Say in the established language: '+FAILED+' Do not claim staff received it or that the issue was resolved. Only give configured clinic contact information; never invent a number, promise a callback or perform a transfer.')])
    flow['global_prompt']+='\n'+POLICY
    return flow

if __name__=='__main__':
    data=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    apply_human_escalation(data.get('conversationFlow',data))
    Path(sys.argv[2]).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n', encoding="utf-8")
