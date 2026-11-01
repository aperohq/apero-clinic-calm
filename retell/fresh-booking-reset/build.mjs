// Configuration compilation only. No API, agent, voice, or operational execution.
import fs from 'node:fs';
import {clearExistingTarget} from '../remediation-v19/runtime.mjs';
export const allEdges=n=>[...(n.edges||[]),n.else_edge,n.always_edge,n.edge].filter(Boolean);
const root=new URL('./',import.meta.url);
export function build(baseline){
  const f=structuredClone(baseline),nodes=new Map(f.nodes.map(n=>[n.id,n]));
  if(nodes.get('node_reset_prepare').execution_status_variable==='fresh_reset_execution')return f;
  const edge=(id,to,conditions)=>({id,destination_node_id:to,transition_condition:{type:'equation',operator:'&&',equations:conditions.map(([key,value])=>({left:'{{'+key+'}}',operator:'==',right:value}))}});
  const always=(id,to)=>({id,destination_node_id:to,transition_condition:{type:'prompt',prompt:'Always'}});
  const prepare=nodes.get('node_reset_prepare'),verify=nodes.get('node_reset_verify');
  // Explicit operation-only allowlist. Keep clinic/call/language/trusted caller context,
  // completed history and, most importantly, booking_reconciliation_required intact.
  const extraKeys=['action','practitioner_scope','intake_name_cycle','intake_name_evidence','intake_entry_ok','intake_route',
    'current_availability_check','current_availability_snapshot','current_availability_signature',
    'slot_choice_index','slot_choice_practitioner','booking_attempt_cycle','booking_attempt_tuple',
    'booking_result_verified','booking_retry_allowed','booking_follow_up_saved','booking_follow_up_id',
    'existing_choice_index','existing_choice_action','existing_choice_unclear','existing_requested_date','existing_requested_time',
    'existing_window_start','existing_window_end','existing_search_mode','reschedule_changes_service','reschedule_changes_practitioner',
    'existing_fresh_appointments','existing_fresh_attempt','existing_fresh_lookup_success','existing_target_fresh','existing_target_verified_attempt',
    'current_result_service','current_result_staff','current_result_start','identity_correction_evidence','corrected_patient_name','corrected_patient_phone',
    'identity_also_changes_schedule'];
  extraKeys.push(...Object.keys(clearExistingTarget({})).filter(k=>!['operation_kind','r18_route'].includes(k)),
    'existing_cycle','existing_lookup_cycle','existing_lookup_snapshot','existing_patient_name','existing_patient_phone');
  const extra=Object.fromEntries(extraKeys.map(k=>[k,f.default_dynamic_variables[k]??'']));
  Object.assign(extra,Object.fromEntries(Object.entries(clearExistingTarget({})).filter(([k])=>!['operation_kind','r18_route'].includes(k))));
  for(const k of ['existing_target_fresh','existing_fresh_lookup_success','existing_result_verified','identity_also_changes_schedule'])extra[k]=false;
  prepare.execution_status_variable='fresh_reset_execution';
  for(const k of [...extraKeys,'fresh_reset_cycle'])prepare.response_variables[k]=k;
  prepare.edges[0].transition_condition.equations.push({left:'{{fresh_reset_execution}}',operator:'==',right:'success'});
  prepare.edges.unshift(edge('fresh_reset_locked','node_book_failed',[['reset_error','reconciliation_required'],['fresh_reset_execution','success']]));

  // Booking intent is established before this extraction; extraction enriches it.
  // A generic retry/absent detail must ask missing fields rather than fail reset.
  nodes.get('node_fresh_request').edges=[always('edge_fresh_request_captured','node_reset_language_gate')];
  nodes.get('node_fresh_request').else_edge.destination_node_id='node_reset_language_gate';
  nodes.get('node_reset_language_gate').edges=[
    edge('edge_language_kept','node_reset_verify',[['language_known','true']]),
    edge('edge_language_missing','node_reset_language_capture',[['language_known','false'],['language_initialization_allowed','true']])];
  nodes.get('node_reset_language_capture').edges=[edge('edge_language_initialized','node_reset_verify',[['fresh_request_language','English']]),edge('edge_language_initialized_ar','node_reset_verify',[['fresh_request_language','Arabic']])];
  verify.execution_status_variable='fresh_verify_execution';
  verify.edges=[edge('edge_reset_verified','node_intake_name_capture',[
    ['reset_ready','true'],['reset_verified_attempt','{{reset_attempt}}'],['fresh_verify_execution','success']])];

  // Store the initializer's exact clear-set once. Only this non-skippable code
  // writes it; a separate verifier checks the mapped runtime values against it.
  // Avoid duplicating the entire state inventory in both code nodes (Retell size limit).
  const originalEmpty=JSON.parse(baseline.nodes.find(n=>n.id==='node_reset_prepare').code.match(/const empty = (\{.*?\});/s)[1]);
  const clean={...originalEmpty,...clearExistingTarget({}),...extra,existing_cycle:'',existing_lookup_cycle:'',existing_lookup_snapshot:'[]',existing_patient_name:'',existing_patient_phone:'',operation_kind:'book'};
  const canonical=Object.fromEntries(Object.entries(clean).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]));
  const groups=new Map();for(const[k,v]of Object.entries(canonical)){if(!groups.has(v))groups.set(v,[]);groups.get(v).push(k);}
  const grouped=[...groups].map(([value,keys])=>[value,keys.join(',')]);
  prepare.code=`const truth=v=>v===true||v==='true';
if(truth(dv.booking_reconciliation_required))return {reset_prepared:false,reset_ready:false,boundary_verified:false,fresh_reset_cycle:'',reset_error:'reconciliation_required'};
const empty={};for(const[value,keys]of ${JSON.stringify(grouped)})for(const key of keys.split(','))empty[key]=value;
const prior=dv.historical_completed_appointments,raw=prior===undefined||prior===null||prior===''||prior==='null'?'[]':prior;
let history;try{history=JSON.parse(raw);if(!Array.isArray(history)||history.some(a=>!a||typeof a!=='object'||Array.isArray(a)||typeof a.appointment_id!=='string'||!a.appointment_id))throw Error('history');}catch(_){return {...empty,reset_prepared:false,reset_error:'invalid_completed_history',fresh_reset_cycle:''};}
const id=truth(dv.booking_success)?dv.booking_id:truth(dv.reschedule_success)?dv.rescheduled_id:'';
if(id&&!history.some(a=>a.appointment_id===id))history.push({appointment_id:id,service_name:dv.service_name||'',practitioner_name:dv.selected_practitioner_name||'',date:dv.appointment_date||'',time:dv.appointment_time||'',completed:true});
const saved=JSON.stringify(history),cycle=String(Date.now())+'-'+String(Math.random());
return {...empty,booking_cycle_seen:true,first_cycle_proven:false,reset_attempt:cycle,reset_prepared:true,fresh_reset_cycle:cycle,fresh_reset_expected:JSON.stringify(empty),reset_cleared_variable_count:Object.keys(empty).length,history_valid:true,history_snapshot:saved,historical_completed_appointments:saved,language_snapshot:dv.fresh_request_language||'',caller_snapshot:JSON.stringify({call_id:dv.call_id||'',caller_name:dv.caller_name||'',caller_phone:dv.caller_phone||'',caller_phone_confirmed:dv.caller_phone_confirmed||''}),historical_call_appointment_booked:truth(dv.historical_call_appointment_booked)||truth(dv.appointment_booked)};`;
  for(const k of [...Object.keys(clean),'fresh_reset_expected'])prepare.response_variables[k]=k;
  verify.code=`const truth=v=>v===true||v==='true';let error='';
try{
if(!truth(dv.reset_prepared)||!dv.reset_attempt)error='reset_not_prepared';
else if(dv.fresh_reset_execution!=='success'||dv.fresh_reset_cycle!==dv.reset_attempt)error='local_initialization_not_confirmed';
else if(truth(dv.booking_reconciliation_required))error='reconciliation_required';
else if(!['English','Arabic'].includes(dv.fresh_request_language))error='language_missing';
else if(dv.language_snapshot&&dv.language_snapshot!==dv.fresh_request_language)error='language_changed_during_reset';
else if(!truth(dv.history_valid)||dv.historical_completed_appointments!==dv.history_snapshot)error='history_changed';
else if(JSON.stringify({call_id:dv.call_id||'',caller_name:dv.caller_name||'',caller_phone:dv.caller_phone||'',caller_phone_confirmed:dv.caller_phone_confirmed||''})!==dv.caller_snapshot)error='caller_details_changed';
else{const expected=JSON.parse(dv.fresh_reset_expected);if(!expected||Array.isArray(expected)||expected.operation_kind!=='book'||expected.slot_id!==''||expected.consent_confirmed!=='false')throw Error('inventory');for(const[k,v]of Object.entries(expected)){if(['fresh_request_summary','fresh_request_present'].includes(k))continue;if(String(dv[k])!==v){error='uncleared_actual_state:'+k;break;}}}
}catch(_){error='reset_verification_error';}
return {reset_ready:!error,reset_prepared:false,boundary_verified:!error,reset_verified_attempt:error?'':dv.reset_attempt,reset_error:error,active_booking_state:error?'{}':JSON.stringify({cycle:dv.reset_attempt,phase:'fresh',service:'',practitioner:'',slot:'',patient:'',consent:'',existing_appointment:'',reschedule:'',cancel:'',new_request:dv.fresh_request_summary||''})};`;

  // The observed failure: a missing scheduling field is NOT a failed reset.
  const search=nodes.get('node_guard_search');
  search.code=search.code.replace("if(!intakeOK)return {reset_ready:false,stage_ok:false,reset_error:'required_intake_missing'};",
    "if(!intakeOK)return {reset_ready:cycle,stage_ok:false,reset_error:cycle?'required_intake_missing':'cycle_not_verified'};\n"+
    "if(!['earliest','exact','window'].includes(dv.search_mode)||dv.search_mode!=='earliest'&&!String(dv.requested_date||'').trim())return {reset_ready:true,stage_ok:false,reset_error:'date_or_search_missing'};");
  search.edges.push(edge('fresh_search_needs_date','node_date_time',[['stage_ok','false'],['reset_ready','true'],['reset_error','date_or_search_missing']]),
    edge('fresh_search_needs_intake','node_intake_name_gate_clear',[['stage_ok','false'],['reset_ready','true'],['reset_error','required_intake_missing']]));
  nodes.get('node_guard_search_clear_result').code="return {stage_ok:false,reset_error:''};";
  nodes.get('node_guard_search_clear_result').response_variables.reset_error='reset_error';
  return f;
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 const before=JSON.parse(fs.readFileSync(new URL('../remediation-v19/candidate.json',root)));
 fs.mkdirSync(root,{recursive:true});fs.writeFileSync(new URL('candidate.json',root),JSON.stringify(build(before),null,2)+'\n');
 const incoming=before.nodes.flatMap(n=>allEdges(n).filter(e=>e.destination_node_id==='node_reset_failed').map(e=>({source:n.id,name:n.name,edge:e.id,condition:e.transition_condition,default:e===n.else_edge,reads:[...new Set((n.code||'').match(/dv\.[A-Za-z_0-9]+/g)||[])],normal_transitions:allEdges(n).filter(other=>other!==e),writes:n.response_variables||n.variables?.map(v=>v.name)||{},tool:n.tool_id?before.tools.find(t=>t.tool_id===n.tool_id):null,failure_reason:e===n.else_edge?'No normal outgoing condition matched; code throws/timeouts or missing mapped outputs can also leave normal acknowledgement conditions unsatisfied. See exact sibling conditions and source code.':'See exact edge condition.'})));
 fs.writeFileSync(new URL('failure-incoming.json',root),JSON.stringify(incoming,null,2)+'\n');
 console.log(JSON.stringify({incoming_failure_edges:incoming.length,changed_nodes:before.nodes.filter((n,i)=>JSON.stringify(n)!==JSON.stringify(build(before).nodes[i])).map(n=>n.id)}));
}
