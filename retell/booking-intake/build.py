"""Pure offline patch of the freshly captured published v16 flow. No API calls."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def edges(node):
    return node.get('edges', []) + [node[k] for k in ('else_edge', 'always_edge', 'edge') if k in node]

def edge(identifier, target, variable=None, value='true'):
    condition = {'type': 'prompt', 'prompt': 'Always'} if variable is None else {
        'type': 'equation', 'operator': '&&', 'equations': [
            {'left': '{{'+variable+'}}', 'operator': '==', 'right': value}]}
    return {'id': identifier, 'destination_node_id': target, 'transition_condition': condition}

CYCLE = """const truth=v=>v===true||v==='true';
const val=v=>String(v||'').trim();
let state={};try{state=JSON.parse(dv.active_booking_state||'{}');}catch(_){}
const cycle=truth(dv.reset_ready)&&truth(dv.boundary_verified)&&!!dv.reset_attempt&&
 dv.reset_verified_attempt===dv.reset_attempt&&state.cycle===dv.reset_attempt;
const nameOK=!!val(dv.client_name)&&dv.intake_name_cycle===dv.reset_attempt;
const digits=val(dv.client_phone).replace(/[^0-9]/g,'');
const phoneOK=/^[0-9]{8}$/.test(digits)||/^965[0-9]{8}$/.test(digits);
const evidence=val(dv.patient_evidence);
const contactOK=nameOK&&phoneOK&&truth(dv.patient_confirmed)&&
 evidence.toLowerCase().includes(val(dv.client_name).toLowerCase())&&
 evidence.replace(/[^0-9]/g,'').includes(digits);
let qualified=[];try{qualified=JSON.parse(dv.qualified_practitioners||'[]');}catch(_){}
if(!Array.isArray(qualified))qualified=[];
const serviceOK=truth(dv.resolve_success)&&!!val(dv.service_name)&&qualified.length>0;
const doctorOK=dv.practitioner_mode==='any'?(!val(dv.practitioner_id)&&!val(dv.practitioner_name)||
 dv.selection_cycle===dv.reset_attempt&&state.slot===dv.slot_id&&qualified.some(p=>p.id===dv.practitioner_id)):
 dv.practitioner_mode==='specific'&&qualified.some(p=>p.id===dv.practitioner_id);
const intakeOK=cycle&&nameOK&&serviceOK&&doctorOK&&contactOK;
"""

def build(before):
    flow=copy.deepcopy(before)
    if any(n['id']=='node_intake_name_capture' for n in flow['nodes']):
        return flow
    nodes={n['id']:n for n in flow['nodes']}
    def code(identifier, name, body, outputs, routes):
        n=copy.deepcopy(nodes['node_guard_service'])
        n.update(id=identifier,name=name,code=body,response_variables={k:k for k in outputs},edges=routes)
        n['else_edge']=edge(identifier+'_failed','node_reset_failed')
        n['else_edge']['transition_condition']['prompt']='Else'
        n['display_position']={'x':-1500,'y':len(flow['nodes'])*80}
        flow['nodes'].append(n)
        return n
    def extract(identifier, name, variables, target):
        n=copy.deepcopy(nodes['node_capture_service'])
        n.update(id=identifier,name=name,variables=variables,edges=[edge(identifier+'_done',target)])
        n['else_edge']['id']=identifier+'_failed'
        flow['nodes'].append(n)
        return n
    # All fresh and correction entries into service/date must cross their guards.
    for n in flow['nodes']:
        for e in edges(n):
            if e.get('destination_node_id')=='node_service':e['destination_node_id']='node_intake_name_capture'
            if e.get('destination_node_id')=='node_date_time':e['destination_node_id']='node_intake_before_time'
    # Name extraction preserves valid details in the current request; it never uses old cycles.
    extract('node_intake_name_capture','Capture current patient name',[
        {'name':'client_name','type':'string','description':
         'Extract the attending patient name from fresh_request_summary and caller answers in THIS reset_attempt only. "I am Ahmed" in a booking request establishes Ahmed unless booking for someone else. Preserve an already explicit current-cycle name. Empty if missing or uncertain. Never infer the patient from caller metadata, prior bookings or doctor names.'},
        {'name':'intake_name_evidence','type':'string','description':
         'Quote the current NEW request or post-boundary caller words establishing this patient name. Empty when absent. Do not use an earlier booking.'}
    ],'node_intake_name_gate')
    code('node_intake_name_gate','Require patient name before service',CYCLE+"""
const valid=cycle&&!!val(dv.client_name)&&val(dv.intake_name_evidence).toLowerCase().includes(val(dv.client_name).toLowerCase());
return {intake_route:!cycle?'blocked':valid?'service':'name',intake_name_cycle:valid?dv.reset_attempt:''};
""",['intake_route','intake_name_cycle'],[
        edge('intake_name_missing','node_intake_name','intake_route','name'),
        edge('intake_name_present','node_service','intake_route','service')])
    n=copy.deepcopy(nodes['node_service'])
    n.update(id='node_intake_name',name='Patient name first',skippable=False,
             instruction={'type':'prompt','text':
             'Continue in {{fresh_request_language}}. Booking intent is established. Ask only for the attending patient name: "Of course. May I have your name first?" Arabic: "أكيد، ممكن اسم المريض أول شي؟" If booking for another person, obtain that patient name. Retain all service, practitioner, contact and date/time details volunteered in the current request. Do not ask about them here. Once the name is clear, continue without asking it again.'},
             edges=[edge('intake_name_answered','node_intake_name_capture')])
    flow['nodes'].append(n)
    # Capture doctor preference before the date question, using the same current-cycle extraction.
    doctor_vars=copy.deepcopy([v for v in nodes['node_capture_search']['variables'] if v['name'].startswith('practitioner_')])
    for v in doctor_vars:
        v['description']=v['description'].replace('any_qualified','any')
    extract('node_intake_doctor_capture','Capture required practitioner preference',doctor_vars,'node_intake_before_time')
    nodes['node_doctor_preference']['edges'][0]['destination_node_id']='node_intake_doctor_capture'
    # A sole qualified practitioner requires no extra question; several require a preference.
    pretime=CYCLE+"""
let id=val(dv.practitioner_id),name=val(dv.practitioner_name),mode=val(dv.practitioner_mode);
if(serviceOK&&qualified.length===1&&!id&&!name&&mode!=='any'){
 id=qualified[0].id;name=qualified[0].name||qualified[0].full_name;mode='specific';
}
const doctor=mode==='any'?!id&&!name:mode==='specific'&&qualified.some(p=>p.id===id);
const route=!cycle?'blocked':!nameOK?'name':!serviceOK?'service':!doctor?'doctor':!contactOK?'contact':'date';
return {intake_route:route,practitioner_id:id,practitioner_name:name,practitioner_mode:mode};
"""
    code('node_intake_before_time','Require all non-time intake before date',pretime,
         ['intake_route','practitioner_id','practitioner_name','practitioner_mode'],[
         edge('intake_need_name','node_intake_name_capture','intake_route','name'),
         edge('intake_need_service','node_service','intake_route','service'),
         edge('intake_need_doctor','node_doctor_preference','intake_route','doctor'),
         edge('intake_need_contact','node_patient','intake_route','contact'),
         edge('intake_ready_for_date','node_date_time','intake_route','date')])
    # Contact now precedes time. Post-slot patient verification remains separate.
    extract('node_intake_contact_capture','Capture patient contact before date',
            copy.deepcopy(nodes['node_capture_patient']['variables']),'node_intake_before_time')
    nodes['node_patient']['edges'][0]['destination_node_id']='node_intake_contact_capture'
    nodes['node_patient']['edges'][0]['transition_condition']={'type':'prompt','prompt':'Current patient name and confirmed usable contact are established; preserve details already supplied in this booking request'}
    nodes['node_patient']['skippable']=True
    nodes['node_patient']['instruction']['text']=(
        'Patient name is already {{client_name}}. Ask only for the missing or uncertain patient contact, one question at a time, before asking date/time. A contact explicitly supplied for this patient in the current request is established; do not ask for it again. Never treat arbitrary metadata or a prior patient phone as trusted current patient contact. '+nodes['node_patient']['instruction']['text'])
    nodes['node_guard_slot']['edges'][0]['destination_node_id']='node_capture_patient'
    # Preserve established identity when only scheduling parameters change.
    nodes['node_clear_correction']['code']=nodes['node_clear_correction']['code'].replace(
        "client_name:'',client_phone:'',patient_confirmed:false,patient_evidence:'',",'')
    for k in ['client_name','client_phone','patient_confirmed','patient_evidence']:
        nodes['node_clear_correction']['response_variables'].pop(k,None)
    nodes['node_clear_correction']['code']=nodes['node_clear_correction']['code'].replace(
        "slot_id:'',", "practitioner_id:dv.practitioner_mode==='any'?'':dv.practitioner_id,practitioner_name:dv.practitioner_mode==='any'?'':dv.practitioner_name,slot_id:'',")
    nodes['node_clear_correction']['response_variables'].update(practitioner_id='practitioner_id',practitioner_name='practitioner_name')
    # Remove hardcoded service rewrites: backend staff + aliases are authoritative.
    svc=nodes['node_guard_service']
    start=svc['code'].index("let query=dv.service_query")
    aliases=json.loads((ROOT/'approved-arabic-aliases.json').read_text(encoding="utf-8"))
    approved={alias:service for service,values in aliases.items() for alias in values}
    svc['code']=svc['code'][:start]+"const approved="+json.dumps(approved,ensure_ascii=False)+";const normalize=s=>s.normalize('NFKD').replace(/[\\u064b-\\u065f\\u0670]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/\\s+/g,' ').trim();let query=String(dv.service_query||'').trim();const hit=Object.entries(approved).find(([alias])=>normalize(alias)===normalize(query));if(hit)query=hit[1];return {reset_ready:!error,stage_ok:!error,reset_error:error,service_query:query};"
    svc['code']=CYCLE+"if(!cycle||!nameOK)return {reset_ready:false,stage_ok:false,reset_error:'name_required_before_service'};\n"+svc['code'].replace("const truth=v=>v===true||v==='true';",'').replace('let state;','')
    # Match actual deployed backend mode ('any'), not obsolete 'any_qualified'.
    for n in flow['nodes']:
        if 'code' in n:n['code']=n['code'].replace("'any_qualified'","'any'")
        for v in n.get('variables',[]):
            v['description']=v.get('description','').replace('any_qualified','any')
    # Search and booking guards reject any missing required non-time field.
    for identifier in ['node_guard_search','node_guard_book']:
        n=nodes[identifier]
        n['code']=CYCLE+"if(!intakeOK)return {reset_ready:false,stage_ok:false,reset_error:'required_intake_missing'};\n"+n['code'].replace("const truth=v=>v===true||v==='true';",'').replace('let state;','')
    # Independent guards on EVERY entry to the new-booking availability and creation tools.
    for target in ['node_check','node_check_arabic_wait','node_check_silent','node_book','node_book_arabic_wait']:
        prepare='node_downtime_prepare_'+target
        gate='node_intake_entry_'+target
        for n in flow['nodes']:
            for e in edges(n):
                if e.get('destination_node_id')==prepare:e['destination_node_id']=gate
        isbook=target.startswith('node_book')
        condition="intakeOK"
        if isbook:
            condition+="&&!!val(dv.slot_id)&&!!val(dv.appointment_date)&&!!val(dv.appointment_time)&&dv.consent_cycle===dv.reset_attempt&&truth(dv.consent_confirmed)&&dv.selection_cycle===dv.reset_attempt&&dv.patient_cycle===dv.reset_attempt&&state.phase==='readback'&&dv.consent_tuple===dv.booking_readback&&dv.booking_readback===JSON.stringify({cycle:dv.reset_attempt,slot_id:dv.slot_id,client_name:dv.client_name,client_phone:dv.client_phone,service_name:dv.service_name,practitioner_id:dv.practitioner_id,appointment_date:dv.appointment_date,appointment_time:dv.appointment_time})"
        code(gate,'Guard required booking fields at tool entry',CYCLE+
             'if(!('+condition+"))throw Error('required_booking_fields_missing');return {intake_entry_ok:true};",
             ['intake_entry_ok'],[edge(gate+'_ready',prepare,'intake_entry_ok')])
    # Require a nonempty ID and explicit booked result, not merely an existing variable.
    for identifier in ['node_book','node_book_arabic_wait']:
        success=nodes[identifier]['edges'][1]['transition_condition']['equations']
        success[:]=[{'left':'{{booking_success}}','operator':'==','right':'true'},
                    {'left':'{{appointment_booked}}','operator':'==','right':'true'},
                    {'left':'{{booking_id}}','operator':'!=','right':''}]
    for t in flow['tools']:
        if t['name']=='check_fresh_availability':
            for field in ['client_name','client_phone']:
                t['parameters']['properties'][field]={'type':'string','const':'{{'+field+'}}'}
    old='Service first, then doctor preference before the FIRST availability check.'
    flow['global_prompt']=flow['global_prompt'].replace(old,
        'For a new booking establish the patient NAME FIRST. Then resolve service, establish qualified practitioner preference (or sole practitioner), and obtain confirmed patient contact. Only then ask preferred date/time and check availability. Preserve every valid field volunteered in the current request; ask only what is missing.')
    nodes['node_service']['instruction']['text']='The current patient name is {{client_name}} and has been established. Ask only for a missing service, naturally: "And what would you like to book?" Arabic: "وشنو الخدمة اللي حاب تحجزها؟" '+nodes['node_service']['instruction']['text']
    nodes['node_offer']['instruction']['text']=nodes['node_offer']['instruction']['text'].replace(
        'then ask only missing patient/contact details','then verify the already established patient/contact without asking again')
    flow['default_dynamic_variables'].update(intake_name_cycle='',intake_name_evidence='',intake_route='',intake_entry_ok='false')
    # Clear each new routing acknowledgement before execution, so an absent result
    # cannot reuse a successful result from an earlier visit.
    guarded=[n for n in flow['nodes'] if n['id'].startswith('node_intake_') and n['type']=='code']
    for n in guarded:
        ack='intake_route' if 'intake_route' in n['response_variables'] else 'intake_entry_ok'
        clear=n['id']+'_clear'
        for source in flow['nodes']:
            for e in edges(source):
                if e.get('destination_node_id')==n['id']:e['destination_node_id']=clear
        code(clear,'Clear intake routing acknowledgement',
             'return '+json.dumps({ack:'' if ack=='intake_route' else False})+';',
             [ack],[edge(clear+'_done',n['id'],ack,'' if ack=='intake_route' else 'false')])
    return flow

if __name__=='__main__':
    result=build(json.loads((ROOT/'published-v16.json').read_text(encoding="utf-8")))
    (ROOT/'candidate.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n', encoding="utf-8")
    print(f"Built {len(result['nodes'])} nodes offline")
