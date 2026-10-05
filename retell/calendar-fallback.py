"""Apply only calendar-unavailable routing to an existing, current flow."""
import copy
import json
import sys
from pathlib import Path

def apply_calendar_fallback(flow):
    if any(n['id'] == 'node_calendar_unavailable' for n in flow['nodes']):
        return flow
    tools = {t['tool_id']: t for t in flow['tools']}
    def edge(identifier, destination, variable=None, value=None, prompt=None):
        condition = {'type': 'prompt', 'prompt': prompt or 'Else'} if variable is None else {
            'type': 'equation', 'operator': '&&', 'equations': [{'left': '{{'+variable+'}}', 'operator': '==', 'right': value}]}
        return {'id': identifier, 'destination_node_id': destination, 'transition_condition': condition}
    availability_tools = [t for t in flow['tools'] if t['name'] in ('check_availability', 'check_fresh_availability')]
    for tool in availability_tools:
        tool['max_retry'] = 0
        tool['response_variables'].update(calendar_follow_up_saved='follow_up_saved', calendar_error='error_type')
        # Existing name/contact arguments allow automatic retention when already known.
        tool['parameters']['properties'].update(client_name={'type':'string','description':'Known patient name, if available.'},
                                               client_phone={'type':'string','description':'Known confirmed patient phone, if available.'})
    for node in list(flow['nodes']):
        if node.get('tool_id') not in {t['tool_id'] for t in availability_tools}:
            continue
        node['edges'].insert(0, edge('edge_calendar_'+node['id'], 'node_calendar_unavailable', 'calendar_error', 'calendar_unavailable'))
        node['else_edge'] = edge('edge_calendar_transport_'+node['id'], 'node_calendar_unavailable')
        node['wait_for_result'] = True
        # Clear earlier success before HTTP execution, including a missing tool response.
        prepare_id = 'node_calendar_prepare_'+node['id']
        for source in flow['nodes']:
            for item in source.get('edges', []) + [source.get('always_edge', {}), source.get('else_edge', {})]:
                if item.get('destination_node_id') == node['id']:
                    item['destination_node_id'] = prepare_id
        flow['nodes'].append({'id':prepare_id,'name':'Clear availability evidence','type':'code','wait_for_result':True,
            'display_position':{'x':14000,'y':0},'code':"return {availability_success:false,available:false,slots:'[]',calendar_error:'',calendar_follow_up_saved:false};",
            'response_variables':{k:k for k in ['availability_success','available','slots','calendar_error','calendar_follow_up_saved']},
            'edges':[edge('edge_'+prepare_id,node['id'],prompt='Always')],
            'else_edge':edge('edge_'+prepare_id+'_failed','node_calendar_unavailable')})
    tool = copy.deepcopy(availability_tools[0])
    tool.update(tool_id='tool-calendar-follow-up', name='retain_calendar_follow_up',
                description='Save preferences in Requests after schedule access fails. No booking or availability retry. Only claim retained when follow_up_saved is true.',
                response_variables={'calendar_follow_up_saved':'follow_up_saved','calendar_request_id':'follow_up_request_id'},
                parameters={'type':'object','required':['action','client_name','client_phone','service_name','requested_date','requested_time'],
                  'properties':{k:{'type':'string','description':v} for k,v in {
                    'action':'Always calendar_follow_up.','client_name':'Patient full name.','client_phone':'Confirmed patient phone.',
                    'service_name':'Requested service.','requested_date':'Preferred date, preserve caller preference; not an available date.',
                    'requested_time':'Preferred time or time window; not an available slot.','practitioner_name':'Preferred practitioner if applicable.'}.items()}})
    tool['parameters']['properties']['action']['enum']=['calendar_follow_up']
    flow['tools'].append(tool)
    def conversation(identifier, name, text, edges):
        return {'id':identifier,'name':name,'type':'conversation','skippable':False,'display_position':{'x':14500,'y':1000},
                'instruction':{'type':'prompt','text':text},'edges':edges}
    flow['nodes'].extend([
      conversation('node_calendar_unavailable','Calendar unavailable — follow-up',
        "Continue in the caller's established language. Say the equivalent of: I’m sorry, I can’t access the clinic’s availability right now. I can take your preferred date and time so the clinic can follow up with you. Make clear no appointment is confirmed. NEVER invent slots, claim a time is available, retry availability, or call booking/rescheduling after this failure. If calendar_follow_up_saved is true, say preferences were saved and staff must verify the real schedule before confirming; do not save a duplicate. Otherwise offer to collect missing patient name, confirmed phone, requested service, preferred date/time and preferred practitioner if applicable, one question at a time. Reuse known details. Preferences are unverified. Do not promise staff received a request before retention succeeds.",
        [edge('edge_calendar_collect','node_calendar_collect',prompt='Caller accepts follow-up and calendar_follow_up_saved is not true'),
         edge('edge_calendar_done','node_end',prompt='Caller declines, is finished, or preferences were already saved')]),
      conversation('node_calendar_collect','Collect calendar follow-up preferences',
        "Ask only missing patient full name, confirmed phone, requested service, preferred date/time and optional preferred practitioner, one question at a time. Reuse established preferences. No appointment is confirmed and no time is known available. Never check availability, book, reschedule or reset into booking. Save complete details using retain_calendar_follow_up.",
        [edge('edge_calendar_save','node_calendar_save',prompt='Patient name, confirmed phone, service and preferred date/time are complete'),edge('edge_calendar_decline','node_end',prompt='Caller declines or is finished')]),
      {'id':'node_calendar_save','name':'Retain calendar follow-up','type':'function','tool_type':'local','tool_id':tool['tool_id'],
       'wait_for_result':True,'speak_during_execution':False,'display_position':{'x':15000,'y':1000},
       'edges':[edge('edge_calendar_saved','node_calendar_saved','calendar_follow_up_saved','true')],
       'else_edge':edge('edge_calendar_save_failed','node_calendar_save_failed')},
      conversation('node_calendar_saved','Calendar preferences saved',
        "Say preferences were saved for clinic follow-up. No appointment is confirmed. Staff must verify the real schedule before confirming anything. Do not retry availability or booking. End politely.",[edge('edge_calendar_saved_end','node_end',prompt='Always')]),
      conversation('node_calendar_save_failed','Calendar preferences not saved',
        "The follow-up was NOT saved. No appointment is confirmed. Say the request could not be saved and ask the patient to contact the clinic directly using only an approved contact number. Do not promise receipt, retry availability or book. End politely.",[edge('edge_calendar_unsaved_end','node_end',prompt='Always')])])
    flow['global_prompt'] += "\nCALENDAR UNAVAILABLE: After schedule retrieval fails, times out, returns invalid data or cannot be reached, do not retry availability or book/reschedule for this call. Use Calendar unavailable — follow-up. No appointment is confirmed. Collect preferences only and retain_calendar_follow_up before claiming retention. Staff must verify the real schedule. Global navigation must not return this call to scheduling after calendar failure."
    return flow

if __name__ == '__main__':
    source = json.loads(Path(sys.argv[1]).read_text())
    target = source.get('conversationFlow',source)
    apply_calendar_fallback(target)
    Path(sys.argv[2]).write_text(json.dumps(source,ensure_ascii=False,indent=2)+'\n')
