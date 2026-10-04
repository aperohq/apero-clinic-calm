"""Build v4 exclusively from the freshly fetched unpublished v3. No remote IO."""
import copy,json,sys
from pathlib import Path
R=Path(__file__).parent
sys.path.insert(0,str(R.parent))
from build import code_node,equation_edge,prompt_edge,fallback,apply_booking_fallback
f=json.loads((R/'base-v3.json').read_text()); base=copy.deepcopy(f)
n={x['id']:x for x in f['nodes']}
legacy=json.loads((R.parent/'reset-values.json').read_text())
audit=json.loads((R.parent/'prepublish-reset-audit/audit.json').read_text())
rows=[]
FACT_FIELDS=set('service_name selected_practitioner_id selected_practitioner_name booking_id rescheduled_id cancelled_id fresh_request_summary fresh_request_language slots service_candidates qualified_practitioners appointments'.split())
for row in audit['rows']:
 c={'state_or_request_producer':'A','reset_control':'C','tool_argument_only':'B','reset_only_no_external_use':'D'}[row['category']]
 clear_eligible=c in ['A','C']
 if c=='A' and row['name'] not in FACT_FIELDS:c='C'
 rows.append({**row,'clear_eligible':clear_eligible,'category':c,'v4_action':'preserved actual language' if row['name']=='fresh_request_language' else 'reset' if c in ['A','C'] else 'legacy tool argument only; consult v4 producers for promoted fields' if c=='B' else 'removed reset-only alias'})
# Drop phantom aliases. Promote tool arguments into actual captured, used state.
empty={k:v for k,v in legacy.items() if next(r for r in rows if r['name']==k)['clear_eligible'] and k!='fresh_request_language'}
for k in ['service_query','practitioner_id','practitioner_name','practitioner_mode','requested_date','requested_time','window_start','window_end','search_mode','slot_id','client_name','client_phone','appointment_date','appointment_time','patient_evidence','selection_cycle','patient_cycle','consent_cycle','booking_readback','consent_tuple']:
 empty[k]=''
for k in ['patient_confirmed','consent_confirmed']:empty[k]=False
empty['active_booking_state']='{}'
empty['boundary_verified']=False
empty['stage_ok']=False
# Exactly preserve the actual v3 speaking variable, never reset or reconstruct it.
prep="""const empty = EMPTY;
const truth=v=>v===true||v==='true';
const raw=dv.historical_completed_appointments===undefined?'[]':dv.historical_completed_appointments;
let history; let error='';
try { history=JSON.parse(raw); if(!Array.isArray(history)||history.some(a=>!a||typeof a!=='object'||Array.isArray(a)||typeof a.appointment_id!=='string'||!a.appointment_id))throw Error('history'); } catch(_){error='invalid_completed_history';}
if(error)return {...empty,reset_attempt:'',reset_prepared:false,reset_ready:false,reset_error:error,reset_cleared_variable_count:Object.keys(empty).length,history_valid:false,history_snapshot:raw,historical_completed_appointments:raw,language_snapshot:dv.fresh_request_language||'',caller_snapshot:JSON.stringify({call_id:dv.call_id||'',caller_name:dv.caller_name||'',caller_phone:dv.caller_phone||'',caller_phone_confirmed:dv.caller_phone_confirmed||''}),historical_call_appointment_booked:truth(dv.historical_call_appointment_booked)||truth(dv.appointment_booked)};
const id=truth(dv.booking_success)?dv.booking_id:truth(dv.reschedule_success)?dv.rescheduled_id:'';
if(id&&!history.some(a=>a.appointment_id===id))history.push({appointment_id:id,service_name:dv.service_name||'',practitioner_name:dv.selected_practitioner_name||'',date:dv.appointment_date||'',time:dv.appointment_time||'',completed:true});
const saved=id?JSON.stringify(history):raw;
return {...empty,reset_attempt:String(Date.now())+'-'+String(Math.random()),reset_prepared:true,reset_cleared_variable_count:Object.keys(empty).length,
 history_valid:true,history_snapshot:saved,historical_completed_appointments:saved,
 language_snapshot:dv.fresh_request_language||'',caller_snapshot:JSON.stringify({call_id:dv.call_id||'',caller_name:dv.caller_name||'',caller_phone:dv.caller_phone||'',caller_phone_confirmed:dv.caller_phone_confirmed||''}),
 historical_call_appointment_booked:truth(dv.historical_call_appointment_booked)||truth(dv.appointment_booked)};
""".replace('EMPTY',json.dumps(empty))
fields=list(empty)+['reset_attempt','reset_prepared','reset_cleared_variable_count','history_valid','history_snapshot','historical_completed_appointments','language_snapshot','caller_snapshot','historical_call_appointment_booked']
n['node_reset_prepare'].update(code=prep,response_variables={k:k for k in fields})
# No language extraction on reset when already established.
n['node_fresh_request']['variables']=[v for v in n['node_fresh_request']['variables'] if v['name']!='fresh_request_language']
n['node_fresh_request']['variables'][0]['description']+=' This is the exclusive reset boundary: exclude ALL previously processed/abandoned appointments. Preserve exact explicit new patient/doctor/date and any exclusion such as someone else.'
verify="""const empty=EMPTY;let error=''; const truth=v=>v===true||v==='true';
try{
 if(!truth(dv.reset_prepared)||!dv.reset_attempt)error='reset_not_prepared';
 else if(!truth(dv.availability_invalidated))error='invalidation_not_confirmed';
 else if(!truth(dv.fresh_request_present)||!dv.fresh_request_summary)error='new_request_missing';
 else if(!['English','Arabic'].includes(dv.fresh_request_language))error='language_missing';
 else if(dv.language_snapshot&&dv.language_snapshot!==dv.fresh_request_language)error='language_changed_during_reset';
 else if(!truth(dv.history_valid)||dv.historical_completed_appointments!==dv.history_snapshot)error='history_changed';
 else if(JSON.stringify({call_id:dv.call_id||'',caller_name:dv.caller_name||'',caller_phone:dv.caller_phone||'',caller_phone_confirmed:dv.caller_phone_confirmed||''})!==dv.caller_snapshot)error='caller_details_changed';
 else{
 const h=JSON.parse(dv.historical_completed_appointments);if(!Array.isArray(h)||h.some(a=>!a||typeof a.appointment_id!=='string'||!a.appointment_id))throw Error('history');
 for(const[k,v]of Object.entries(empty)){
 if(['availability_invalidated','fresh_request_summary','fresh_request_present'].includes(k))continue;
 const expected=typeof v==='object'?JSON.stringify(v):String(v);
 if(String(dv[k])!==expected){error='uncleared_actual_state:'+k;break;}}
 }
}catch(_){error='reset_verification_error';}
return {reset_ready:!error,reset_prepared:false,boundary_verified:!error,reset_verified_attempt:error?'':dv.reset_attempt,reset_error:error,
 active_booking_state: error?'{}':JSON.stringify({cycle:dv.reset_attempt,phase:'fresh',service:'',practitioner:'',slot:'',patient:'',consent:'',existing_appointment:'',reschedule:'',cancel:'',new_request:dv.fresh_request_summary})};
""".replace('EMPTY',json.dumps(empty))
n['node_reset_verify'].update(code=verify,response_variables={k:k for k in ['reset_ready','reset_prepared','boundary_verified','reset_verified_attempt','reset_error','active_booking_state']})
# Existing language is passed untouched. Missing language is established explicitly.
langgate=code_node('node_reset_language_gate','Preserve Established Language',"return {language_known:['English','Arabic'].includes(dv.fresh_request_language),language_initialization_allowed:!dv.language_snapshot};",{'language_known':'language_known','language_initialization_allowed':'language_initialization_allowed'},[
 equation_edge('edge_language_kept','node_reset_invalidate',('{{language_known}}','==','true')),
 equation_edge('edge_language_missing','node_reset_language_capture',('{{language_initialization_allowed}}','==','true'))],7200,3800)
n['node_fresh_request']['edges'][0]['destination_node_id']='node_reset_language_gate'
langcapture={'id':'node_reset_language_capture','name':'Establish Missing Speaking Language','type':'extract_dynamic_variables','skippable':False,'variables':[{'name':'fresh_request_language','type':'enum','choices':['English','Arabic'],'description':'ONLY when established language is absent: determine the caller language from their latest actual utterance or explicit language preference. Doctor/service Latin names are not language changes.'}], 'edges':[equation_edge('edge_language_initialized','node_reset_invalidate',('{{fresh_request_language}}','!=',''))],'else_edge':fallback('node_reset_language_capture'),'display_position':{'x':7400,'y':3900}}
# Establish language before any initial task, including FAQ and existing appointment.
initial=copy.deepcopy(langcapture);initial.update(id='node_initial_language',name='Establish Initial Caller Language',edges=copy.deepcopy(n['node_greeting']['edges']),display_position={'x':300,'y':400})
for e in initial['edges']:e['id']='initial_language_'+e['id']
initial['else_edge']=prompt_edge('initial_language_else','Else','node_anything_else')
for e in n['node_greeting']['edges']:e['destination_node_id']='node_initial_language'
f['nodes'] += [langgate,langcapture,initial]
BOUNDARY="""\nACTIVE BOOKING CYCLE {{reset_attempt}}. Fresh verified boundary={{boundary_verified}}. Authoritative new request: {{fresh_request_summary}}. Earlier transcript bookings/abandoned tasks are HISTORICAL ONLY: previous service, doctor, date/time/slots and consent/readback are invalid. Previous patient identity/contact cannot initialize this cycle. Use only explicit details in this NEW request and caller answers AFTER this boundary. A missing detail must be asked, never filled from previous calls/tasks. 'Someone else' excludes the old doctor/patient. Confirm the current patient and current contact explicitly. Confirmed caller contact is call context only, not automatic patient contact. Completed history is historical only. Do not ask for a service already explicitly supplied. Use current cycle's stored fields and latest returned slots; never old transcript slot tokens. Reset does not erase transcript; these restrictions apply to all inference and extraction. If unsure, re-clarify.\n"""
f['global_prompt']+=BOUNDARY+'\nThe actual established speaking-language variable is fresh_request_language. Preserve it across tasks, FAQs, completion, reset and Anything Else. Never reconstruct a populated language on a reset. Only an explicit caller language-switch request authorizes a change. History parsing failure blocks booking; never substitute an empty history. Do not resolve/check/book a new cycle without matching reset_verified_attempt and reset_attempt.'
for id in ['node_service','node_service_clarify','node_doctor_preference','node_date_time','node_offer','node_patient','node_final','node_change_booking']:
 n[id]['instruction']['text']+=BOUNDARY
n['node_final']['instruction']['text']+='\nRead back ONLY this stored current tuple: {{booking_readback}}. Do not reconstruct a tuple from earlier messages.'
# Gate helpers: actual extraction -> deterministic guard -> tool.
added=[]
def extract(id,name,variables,destination):
 x={'id':id,'name':name,'type':'extract_dynamic_variables','skippable':False,'variables':[{'name':k,'type':typ,'description':desc+BOUNDARY} for k,typ,desc in variables],'edges':[prompt_edge('edge_'+id,'Always',destination)],'else_edge':fallback(id),'display_position':{'x':8500+len(added)*250,'y':4600}}
 added.append(x);return x
common="""let error='';const truth=v=>v===true||v==='true';let state;
try{state=JSON.parse(dv.active_booking_state||'{}');if(!truth(dv.reset_ready)||!truth(dv.boundary_verified)||dv.reset_verified_attempt!==dv.reset_attempt||state.cycle!==dv.reset_attempt)error='cycle_not_verified';}catch(_){error='invalid_cycle_state';}
"""
def guard(id,name,code,destination,fields):
 x=code_node(id,name,common+code.replace('stage_ok:!error','reset_ready:!error,stage_ok:!error'),{k:k for k in ['stage_ok','reset_error','reset_ready']+fields},[equation_edge('edge_'+id,destination,('{{stage_ok}}','==','true'))],9000+len(added)*250,4900);added.append(x)
def reroute(target,new):
 for x in f['nodes']:
  for e in [*x.get('edges',[]),x.get('always_edge'),x.get('else_edge')]:
   if e and e.get('destination_node_id')==target:e['destination_node_id']=new
# Service query is persisted independently, bound into resolver params.
reroute('node_resolve','node_capture_service')
extract('node_capture_service','Capture Current Cycle Service',[('service_query','string','Extract ONLY the short service phrase, for example Consultation, Orthodontic Consultation, or Teeth Whitening. Do NOT copy the whole summary, patient, doctor or date. Use ONLY fresh_request_summary and post-reset answers. Absent is empty; never previous service.')],'node_guard_service')
guard('node_guard_service','Verify Current Service Input',"if(!dv.service_query)error='service_missing';let query=dv.service_query||'';if(/orthodont|تقويم/i.test(query))query='Orthodontic Consultation';else if(/whiten|تبييض/i.test(query))query='Teeth Whitening';else if(/^(consultation|استشارة)( ثانية)?$/i.test(query.trim()))query='Consultation';return {stage_ok:!error,reset_error:error,service_query:query};",'node_resolve',['service_query'])
reroute('node_check','node_capture_search')
searchvars=[('practitioner_name','string','Explicit CURRENT doctor preference; empty for any, never old doctor.'),('practitioner_id','string','Qualified practitioner ID matching explicit current preference or sole qualified current resolver; empty for any.'),('practitioner_mode','string','specific or any_qualified. Someone else must not reuse prior doctor.'),('requested_date','string','Current explicit date YYYY-MM-DD; empty for earliest.'),('requested_time','string','Current explicit requested time HH:mm or empty.'),('window_start','string','Current explicit start HH:mm or empty.'),('window_end','string','Current explicit end HH:mm or empty.'),('search_mode','string','earliest, exact or window for CURRENT request.')]
extract('node_capture_search','Capture Current Cycle Availability Arguments',searchvars,'node_guard_search')
guard('node_guard_search','Verify Fresh Availability Inputs',"if(!truth(dv.resolve_success)||!dv.service_name||!['specific','any_qualified'].includes(dv.practitioner_mode)||!['earliest','exact','window'].includes(dv.search_mode))error='search_inputs_missing';if(dv.search_mode!=='earliest'&&!dv.requested_date)error='date_missing';if(dv.practitioner_mode==='specific'&&!dv.practitioner_id&&!dv.practitioner_name)error='doctor_missing';try{const q=JSON.parse(dv.qualified_practitioners||'[]');if(dv.practitioner_id&&!q.some(p=>(p.id||p.practitioner_id)===dv.practitioner_id))error='doctor_not_currently_qualified';if(dv.practitioner_mode==='specific'&&dv.practitioner_name&&!dv.practitioner_id&&!q.some(p=>String(p.name||p.full_name||'').toLowerCase().includes(dv.practitioner_name.toLowerCase().replace(/^dr\\.\\s*/i,''))))error='doctor_not_currently_qualified';}catch(_){error='invalid_practitioner_candidates';}return {stage_ok:!error,reset_error:error,active_booking_state:error?dv.active_booking_state:JSON.stringify({...state,phase:'search',service:dv.service_name,practitioner:dv.practitioner_id||dv.practitioner_name})};",'node_check',['active_booking_state'])
# Persist a selected slot only from the latest current-cycle result, before patient.
for e in n['node_offer']['edges']:
 if e['destination_node_id']=='node_patient':e['destination_node_id']='node_capture_slot'
extract('node_capture_slot','Capture Current Verified Slot',[('slot_id','string','Exact opaque slot_id selected by the caller from the latest slots JSON, never earlier transcript.')],'node_guard_slot')
guard('node_guard_slot','Verify Selected Slot Membership',"let s;try{const a=JSON.parse(dv.slots||'[]');s=a.find(s=>s.slot_id===dv.slot_id);if(!truth(dv.availability_success)||!s||s.service_name!==dv.service_name)error='slot_not_current';}catch(_){error='invalid_slots';}return {stage_ok:!error,reset_error:error,selection_cycle:error?'':dv.reset_attempt,practitioner_id:error?'':s.practitioner_id,appointment_date:error?'':s.date,appointment_time:error?'':s.time,active_booking_state:error?dv.active_booking_state:JSON.stringify({...state,phase:'selected',slot:s.slot_id,practitioner:s.practitioner_id})};",'node_patient',['selection_cycle','practitioner_id','appointment_date','appointment_time','active_booking_state'])
for e in n['node_patient']['edges']:
 if e['destination_node_id']=='node_final':e['destination_node_id']='node_capture_patient'
extract('node_capture_patient','Capture Explicit Current Patient',[('client_name','string','Current patient full name explicitly established AFTER this reset or in new request, never inferred old patient.'),('client_phone','string','Contact explicitly confirmed FOR CURRENT patient after reset, or explicit new request, not old patient/caller default.'),('patient_confirmed','boolean','True only if patient association and contact are explicitly established for current cycle.'),('patient_evidence','string','Quote exact NEW request or post-boundary caller utterances that establish current patient and confirm their phone. Old transcript is forbidden.')],'node_guard_patient')
guard('node_guard_patient','Verify Current Patient and Readback',"if(dv.selection_cycle!==dv.reset_attempt||state.slot!==dv.slot_id||!truth(dv.patient_confirmed)||!dv.client_name||!dv.client_phone||!dv.patient_evidence)error='current_patient_not_confirmed';if(!String(dv.patient_evidence||'').toLowerCase().includes(String(dv.client_name||'').toLowerCase())||!String(dv.patient_evidence||'').replace(/[^0-9]/g,'').includes(String(dv.client_phone||'').replace(/[^0-9]/g,'')))error='patient_evidence_mismatch';const tuple=JSON.stringify({cycle:dv.reset_attempt,slot_id:dv.slot_id,client_name:dv.client_name,client_phone:dv.client_phone,service_name:dv.service_name,practitioner_id:dv.practitioner_id,appointment_date:dv.appointment_date,appointment_time:dv.appointment_time});return {stage_ok:!error,reset_error:error,patient_cycle:error?'':dv.reset_attempt,booking_readback:error?'':tuple,consent_tuple:'',consent_confirmed:false,consent_cycle:'',active_booking_state:error?dv.active_booking_state:JSON.stringify({...state,phase:'readback',patient:dv.client_name,consent:''})};",'node_final',['patient_cycle','booking_readback','consent_tuple','consent_confirmed','consent_cycle','active_booking_state'])
for e in n['node_final']['edges']:
 if e['destination_node_id']=='node_book':e['destination_node_id']='node_capture_consent'
extract('node_capture_consent','Capture Consent For Current Readback',[('consent_confirmed','boolean','True ONLY for latest caller explicit affirmation of just-read current booking_readback; previous consent or yes to FAQ is false.'),('consent_tuple','string','Copy booking_readback exactly ONLY if latest turn explicitly affirms it; otherwise empty.')],'node_guard_book')
guard('node_guard_book','Verify Exact Current Booking Consent',"const tuple=JSON.stringify({cycle:dv.reset_attempt,slot_id:dv.slot_id,client_name:dv.client_name,client_phone:dv.client_phone,service_name:dv.service_name,practitioner_id:dv.practitioner_id,appointment_date:dv.appointment_date,appointment_time:dv.appointment_time});if(dv.patient_cycle!==dv.reset_attempt||dv.selection_cycle!==dv.reset_attempt||state.phase!=='readback'||state.patient!==dv.client_name||state.slot!==dv.slot_id||!truth(dv.consent_confirmed)||tuple!==dv.booking_readback||dv.consent_tuple!==tuple)error='current_consent_mismatch';return {stage_ok:!error,reset_error:error,consent_cycle:error?'':dv.reset_attempt,booking_caller_name:dv.caller_name||'',booking_caller_phone:truth(dv.caller_phone_confirmed)?dv.caller_phone||'':''};",'node_book',['consent_cycle','booking_caller_name','booking_caller_phone'])
f['nodes']+=added
# Clear each stage result before executing its verifier. An exception/missing mapping
# cannot reuse a successful stage_ok from the previous guard.
for g in [x for x in added if x['id'].startswith('node_guard_')]:
 gateid=g['id']+'_clear_result';reroute(g['id'],gateid)
 f['nodes'].append(code_node(gateid,'Clear Stage Verification Result',"return {stage_ok:false};",{'stage_ok':'stage_ok'},[equation_edge('edge_'+gateid,g['id'],('{{stage_ok}}','==','false'))],12000,5800))
# Bind tool arguments with Retell const substitution, preventing free LLM reconstruction.
for t in f['tools']:
 if t['name']=='resolve_service':t['parameters']['properties']['service_name']={'type':'string','const':'{{service_query}}'}
 if t['name']=='book_appointment':
  for k,p in t['parameters']['properties'].items():
   if k!='action':t['parameters']['properties'][k]={'type':'string','const':'{{'+('booking_'+k if k.startswith('caller_') else k)+'}}'}
check=copy.deepcopy(next(t for t in f['tools'] if t['name']=='check_availability'))
check.update(tool_id='tool-v4-fresh-availability',name='check_fresh_availability')
for k,p in check['parameters']['properties'].items():
 if k=='action':continue
 check['parameters']['properties'][k]={'type':'string','const':'' if k in ['appointment_id','client_name','client_phone','location'] else '{{'+k+'}}'}
f['tools'].append(check);n['node_check']['tool_id']=check['tool_id']
for t in f['tools']:
 if t['name'] in ['resolve_service','book_appointment','check_fresh_availability']:
  t['parameters']['properties']['action']={'type':'string','const':{'resolve_service':'resolve','book_appointment':'book','check_fresh_availability':'availability'}[t['name']]}
n['node_booked']['instruction']['text']+='\nOnly confirm the completed appointment here. If another task was mentioned, retain that request for Anything Else and the fresh reset path. Do not collect new doctor/service/patient/date details before that boundary.'
# Corrections invalidate backend AND stored selection/patient/consent, failures block.
correction=code_node('node_clear_correction','Clear Current Selection After Correction',"let state={};try{state=JSON.parse(dv.active_booking_state||'{}');}catch(_){}return {active_booking_state:JSON.stringify({...state,phase:'correction',slot:'',patient:'',consent:''}),slot_id:'',slots:[],selection_cycle:'',patient_cycle:'',consent_cycle:'',client_name:'',client_phone:'',patient_confirmed:false,patient_evidence:'',booking_readback:'',consent_tuple:'',consent_confirmed:false};",{k:k for k in ['active_booking_state','slot_id','slots','selection_cycle','patient_cycle','consent_cycle','client_name','client_phone','patient_confirmed','patient_evidence','booking_readback','consent_tuple','consent_confirmed']},[prompt_edge('edge_correction_cleared','Always','node_change_booking')],11000,5100)
f['nodes'].append(correction)
# stale success acknowledgements cannot let correction invalidation fail through.
for id,dest in [('node_invalidate_booking','node_clear_correction'),('node_invalidate_reschedule','node_reschedule_details')]:
 x=n[id];x.pop('always_edge',None);x['edges']=[equation_edge('edge_'+id+'_confirmed',dest,('{{availability_invalidated}}','==','true'))];x['else_edge']=fallback(id);x['wait_for_result']=True
# All invalidate invocations map success as well; guard acknowledges both fields.
inv=next(t for t in f['tools'] if t['name']=='invalidate_availability');inv['response_variables']['invalidation_success']='success'
for id in ['node_reset_invalidate','node_invalidate_booking','node_invalidate_reschedule']:
 n[id]['edges'][0]['transition_condition']['equations'].append({'left':'{{invalidation_success}}','operator':'==','right':'true'})
# Controls acknowledged only for this invocation: clear immediately before function.
for id in ['node_reset_invalidate','node_invalidate_booking','node_invalidate_reschedule']:
 gateid=id+'_clear_ack';reroute(id,gateid)
 x=code_node(gateid,'Clear Invalidation Acknowledgements',"return {availability_invalidated:false,invalidation_success:false};",{'availability_invalidated':'availability_invalidated','invalidation_success':'invalidation_success'},[prompt_edge('edge_'+gateid,'Always',id)],11500,5500);f['nodes'].append(x)
# Separate future booking requests must not invalidate an explicitly confirmed current tuple.
for e in n['node_final']['edges']:
 if e['id']=='edge_final_change':e['transition_condition']['prompt']='Caller corrects a detail of THIS current appointment or selects another current slot. Exclude a separate additional appointment requested AFTER affirming this exact current readback; that is current consent plus a queued new task, not a correction.'
 if e['id']=='edge_final_yes':e['transition_condition']['prompt']='Caller explicitly affirms booking the exact current just-read patient/service/practitioner/date/time with NO corrections to it. This includes an affirmation followed by a separate additional future appointment request. Book this current tuple first; handle the separate request through Anything Else and fresh reset afterward.'
n['node_final']['instruction']['text']+='\nIf the caller affirms THIS exact tuple and also asks for another appointment afterward, that second request is a separate queued task, not a correction to this tuple. Take the consent exit for this appointment, then let Anything Else handle the separate new request through reset.'
# Fresh initial-state defaults, but never default a caller's speaking language.
f['default_dynamic_variables'].update({k:json.dumps(v,separators=(',',':')) if isinstance(v,(bool,list,dict)) else str(v) for k,v in empty.items()})
for k in ['conversation_flow_id','version','last_modification_timestamp','is_published','is_transfer_cf']:f.pop(k,None)
apply_booking_fallback(f)
(R/'draft-flow.json').write_text(json.dumps(f,ensure_ascii=False,indent=2)+'\n')
(R/'reset-values.json').write_text(json.dumps(empty,indent=2)+'\n')
(R/'inventory.json').write_text(json.dumps({'legacy_total':76,'counts':{c:sum(r['category']==c for r in rows) for c in ['A','B','C','D']},'conversation_memory_concepts':['prior service','prior practitioner','prior date/time/slot','prior patient/contact association','prior consent/readback'],'rows':rows,'v4_reset_mapping_count':len(n['node_reset_prepare']['response_variables']),'v4_cleared_values_count':len(empty),'preserved':['fresh_request_language','call_id','caller_name','caller_phone','caller_phone_confirmed','historical_completed_appointments'],'limitations':'Transcript remains visible; evidence extraction is model-mediated. Tool arguments are const-bound to guarded stored current-cycle state.'},indent=2)+'\n')
print('Built v4:',len(f['nodes']),'nodes;',len(empty),'explicit cleared fields;',len(n['node_reset_prepare']['response_variables']),'prepare mappings')
