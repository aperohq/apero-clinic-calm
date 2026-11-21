"""Scoped unknown-information policy and opt-in retention on the existing flow."""
import copy
import json
import sys
from pathlib import Path

MESSAGE = "I don’t have that information available, and I don’t want to give you the wrong answer. I can take your details so the clinic can follow up with you."
POLICY = """UNKNOWN INFORMATION: Answer clinic questions only from explicit, current, non-conflicting configured clinic facts, approved knowledge or trusted backend data. A missing value, missing price, unknown practitioner biography/qualification/service detail, unconfigured policy or holiday/closure exception, conflicting sources, or a question outside those sources is unknown. Never guess, fabricate, infer a likely answer, give an estimated price, or treat absence as a negative fact. State only the supported part of an answer; clearly identify what is unknown. Preserve known configured answers normally. The clinic's configured pricing restriction still applies: quote no treatment prices. For the unknown part say in the caller's established language: %s Do not collect personal details or save anything unless the caller explicitly requests or accepts follow-up about that unanswered question. An ambiguous yes is not follow-up consent. For that specific opt-in use node_unknown_collect and retain_unknown_answer_follow_up, not generic human/callback/message routing. Preserve the unanswered question. If they decline, continue the existing task or end normally. A factual interruption never creates booking consent or a new booking. This policy adds no transfer or general human escalation.""" % MESSAGE

def ensure_unknown_opt_in_route(flow):
    if any(n['id'] == 'node_unknown_follow_up' for n in flow['nodes']):
        return
    flow['nodes'].append({
        'id':'node_unknown_follow_up','name':'Requested unknown-information follow-up','type':'conversation',
        'skippable':False,'edges':[],'display_position':{'x':15500,'y':500},
        'global_node_setting':{'cool_down':3,'condition':
            "The most recent caller turn explicitly requests or clearly accepts clinic follow-up about a specific factual question that cannot be answered from configured clinic information, including an unknown price, practitioner fact, policy or closure exception. A clear acceptance immediately responding to the unknown-information follow-up offer qualifies. Never infer consent from silence, an unrelated or ambiguous yes. Exclude known-answer questions, general human requests, urgent symptoms, booking failures and calendar availability failures."},
        'instruction':{'type':'prompt','text':
            "Handle only this explicit request for unknown-information follow-up. Preserve the unanswered question and the caller's established language and prior task. Do not invent the answer, collect unrelated details, or treat this request as booking consent. Continue to the unknown-answer collection path; do not claim anything was saved yet."},
        'always_edge':{'id':'edge_unknown_opt_in_route','destination_node_id':'node_unknown_prepare',
            'transition_condition':{'type':'prompt','prompt':'Always'}}})

def apply_unknown_fallback(flow):
    if any(n['id'] == 'node_unknown_collect' for n in flow['nodes']):
        ensure_unknown_opt_in_route(flow)
        return flow
    def edge(identifier, destination, prompt):
        return {'id':identifier,'destination_node_id':destination,'transition_condition':{'type':'prompt','prompt':prompt}}
    faq = next(n for n in flow['nodes'] if n['id'] == 'node_faq')
    faq['instruction']['text'] += '\n' + POLICY
    faq['edges'].insert(0, edge('edge_faq_unknown_follow_up','node_unknown_prepare',
        'Caller explicitly requests or accepts clinic follow-up about the factual question that Apero could not answer from configured information. Not a general human request, urgent request, booking problem, calendar failure, or ambiguous yes.'))
    # Avoid an existing broad human-request interrupt swallowing this specific opt-in.
    human = next((n for n in flow['nodes'] if n['id'] == 'node_global_human'), None)
    if human:
        human['global_node_setting']['condition'] += ' Exclude follow-up about a specific unanswered clinic-information question; use the unknown-answer follow-up path for that request.'
    source = next(t for t in flow['tools'] if t['name'] == 'persist_callback')
    tool = copy.deepcopy(source)
    tool.update(tool_id='tool-unknown-answer-follow-up',name='retain_unknown_answer_follow_up',max_retry=0,
        timeout_ms=10000,speak_after_execution=False,
        description='Save only a requested unknown-information follow-up. No answer lookup, booking, transfer or escalation. Never claim receipt unless unknown_follow_up_saved is true.',
        response_variables={'unknown_follow_up_saved':'follow_up_saved','unknown_request_id':'follow_up_request_id'},
        parameters={'type':'object','required':['action','follow_up_requested','question'],'properties':{
            'action':{'type':'string','enum':['unknown_answer_follow_up'],'description':'Always unknown_answer_follow_up.'},
            'follow_up_requested':{'type':'boolean','enum':[True],'description':'True only after caller explicitly requests or accepts follow-up about the unanswered question.'},
            'question':{'type':'string','description':'Concise unanswered question/request. No transcript or unrelated medical/contact details.'},
            'patient_name':{'type':'string','description':'Patient name if supplied; omit if declined or unavailable.'},
            'caller_phone':{'type':'string','description':'Confirmed follow-up phone if supplied; omit if declined or unavailable. Never invent.'}}})
    flow['tools'].append(tool)
    def conversation(identifier,name,text,edges):
        return {'id':identifier,'name':name,'type':'conversation','skippable':False,'display_position':{'x':16000,'y':1000},
            'instruction':{'type':'prompt','text':text},'edges':edges}
    flow['nodes'].extend([
        {'id':'node_unknown_prepare','name':'Clear unknown follow-up result','type':'code','wait_for_result':True,
         'display_position':{'x':15500,'y':1000},'code':"return {unknown_follow_up_saved:false,unknown_request_id:''};",
         'response_variables':{'unknown_follow_up_saved':'unknown_follow_up_saved','unknown_request_id':'unknown_request_id'},
         'edges':[edge('edge_unknown_prepare','node_unknown_collect','Always')],
         'else_edge':edge('edge_unknown_prepare_failed','node_unknown_failed','Else')},
        conversation('node_unknown_collect','Unknown answer — requested follow-up',
            "Continue in the established caller language. This path is ONLY for an explicit request or acceptance of follow-up about unknown clinic information. Reuse the unanswered question and any details already supplied. Ask one question at a time for name and confirmed follow-up phone if missing; both are optional if declined. Never invent contact details or demand them. Save only the concise question and supplied name/phone using retain_unknown_answer_follow_up with follow_up_requested=true. Do not ask what the question was if already known. If the caller withdraws consent, save nothing. Do not invent an answer or promise receipt or response time.",
            [edge('edge_unknown_save','node_unknown_save','Caller explicitly requested follow-up, the unanswered question is known, and name/phone have been supplied or declined'),
             edge('edge_unknown_cancel','node_anything_else','Caller withdraws or declines follow-up')]),
        {'id':'node_unknown_save','name':'Save unknown-information follow-up','type':'function','tool_type':'local','tool_id':tool['tool_id'],
         'wait_for_result':True,'speak_during_execution':False,'display_position':{'x':16500,'y':1000},
         'edges':[{'id':'edge_unknown_saved','destination_node_id':'node_unknown_saved','transition_condition':{
             'type':'equation','operator':'&&','equations':[{'left':'{{unknown_follow_up_saved}}','operator':'==','right':'true'}]}}],
         'else_edge':edge('edge_unknown_failed','node_unknown_failed','Else')},
        conversation('node_unknown_saved','Unknown-information follow-up saved',
            "Say the question was saved for clinic follow-up only because unknown_follow_up_saved is true. Do not promise a response time or invent the answer. If no phone was supplied, say no contact number was supplied and ask the patient to contact the clinic using only approved clinic contact information; do not promise a callback. Preserve the existing task without treating follow-up as booking consent.",
            [edge('edge_unknown_saved_done','node_anything_else','Always')]),
        conversation('node_unknown_failed','Unknown-information follow-up not saved',
            "Say in the caller's language: I couldn’t save your follow-up request. Please contact the clinic directly. I still don’t have that information available, and I don’t want to give you the wrong answer. Give a clinic contact only if explicitly configured. Do not claim staff received the request, invent an answer, or promise a callback.",
            [edge('edge_unknown_failed_done','node_anything_else','Always')])])
    ensure_unknown_opt_in_route(flow)
    flow['global_prompt'] += '\n' + POLICY
    return flow

if __name__ == '__main__':
    source=json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    apply_unknown_fallback(source.get('conversationFlow',source))
    Path(sys.argv[2]).write_text(json.dumps(source,ensure_ascii=False,indent=2)+'\n', encoding="utf-8")
