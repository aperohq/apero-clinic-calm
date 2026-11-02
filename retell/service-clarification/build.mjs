// Offline configuration transformation; never executes an agent or a call.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {transformSync} from 'esbuild';
export const allEdges=n=>[...(n.edges||[]),n.else_edge,n.always_edge,n.edge].filter(Boolean);
const shared=`const truth=v=>v===true||v==='true';
const val=v=>String(v??'').trim();
let state={};try{state=JSON.parse(dv.active_booking_state||'{}');}catch(_){}
const cycle=truth(dv.reset_ready)&&truth(dv.boundary_verified)&&!!dv.reset_attempt&&dv.reset_verified_attempt===dv.reset_attempt&&state.cycle===dv.reset_attempt&&dv.intake_name_cycle===dv.reset_attempt&&!!val(dv.client_name);
let qualified=[];try{qualified=JSON.parse(dv.qualified_practitioners||'[]');}catch(_){};
const known=truth(dv.resolve_success)&&!!val(dv.service_name)&&Array.isArray(qualified)&&qualified.length>0;
const same=dv.service_clarification_cycle===dv.reset_attempt;
const used=same&&(truth(dv.service_clarification_used)||Number(dv.service_clarification_attempts)>=1);
const base={service_clarification_cycle:dv.reset_attempt,service_clarification_used:used,service_clarification_attempts:same?Number(dv.service_clarification_attempts)||0:0};
`;
export function build(baseline){
 const f=structuredClone(baseline),nodes=new Map(f.nodes.map(n=>[n.id,n]));
 if(nodes.has('node_service_result_gate'))return f;
 const eq=(id,to,key,value)=>({id,destination_node_id:to,transition_condition:{type:'equation',operator:'&&',equations:[{left:'{{'+key+'}}',operator:'==',right:value}]}});
 const always=(id,to)=>({id,destination_node_id:to,transition_condition:{type:'prompt',prompt:'Always'}});
 const addCode=(id,name,code,keys,routes,x,y)=>{
  const execution=id+'_execution';
  const node={id,name,type:'code',code,skippable:false,speak_during_execution:false,wait_for_result:true,timeout_ms:5000,execution_status_variable:execution,response_variables:Object.fromEntries(keys.map(k=>[k,k])),display_position:{x,y},edges:routes.map(([value,to])=>{const e=eq(id+'_'+value,to,'service_route',value);e.transition_condition.equations.push({left:'{{'+execution+'}}',operator:'==',right:'success'});return e;}),else_edge:{id:id+'_failed',destination_node_id:'node_service_fallback',transition_condition:{type:'prompt',prompt:'Else'}}};
  f.nodes.push(node);nodes.set(id,node);return node;
 };
 const keys=['service_clarification_cycle','service_clarification_used','service_clarification_attempts','service_route'];
 // Dead locals only: preserve the returned fields and all intake decisions.
 const nameGate=nodes.get('node_intake_name_gate');
 nameGate.code=nameGate.code.slice(0,nameGate.code.indexOf('const digits='))+nameGate.code.slice(nameGate.code.indexOf('const valid='));
 const timeGate=nodes.get('node_intake_before_time');
 timeGate.code=timeGate.code.slice(0,timeGate.code.indexOf('const doctorOK='))+timeGate.code.slice(timeGate.code.indexOf('let id='));
 // Only a new verified booking cycle clears the spoken-question latch. Success
 // and intentional service changes reset attempts but cannot buy another spoken
 // clarification within the same booking cycle.
 addCode('node_service_result_gate','Bound service clarification to one spoken question',shared+`
if(!cycle)return {...base,service_route:'blocked'};
if(known&&!truth(dv.service_input_missing))return {...base,service_clarification_attempts:0,service_route:'resolved'};
if(used)return {...base,service_clarification_attempts:1,service_route:'fallback'};
return {...base,service_clarification_attempts:1,service_clarification_used:true,service_route:'clarify'};`,keys,[['resolved','node_doctor_preference'],['clarify','node_service_clarify'],['fallback','node_service_fallback'],['blocked','node_reset_failed']],1500,420);
 // Code execution status is checked on each result: no stale route can speak.
 const resolver=nodes.get('node_resolve');
 resolver.edges.find(e=>e.id==='edge_resolve_ok').destination_node_id='node_service_result_gate';
 resolver.else_edge.destination_node_id='node_service_result_gate';
 const clarify=nodes.get('node_service_clarify');
 clarify.reminder_max_count=0;
 clarify.else_edge={id:'service_clarification_any_response',destination_node_id:'node_capture_service',transition_condition:{type:'prompt',prompt:'Else'}};
 clarify.instruction.text=`Ask exactly ONE short service clarification in the established caller language. The deterministic gate has already consumed this booking cycle's one-question budget. Current candidates: {{service_candidates}}. If two or three plausible candidates were returned, ask which one the caller means using only those names. Otherwise ask which service they want; never invent a service. Ask once, wait for one response, and proceed to extraction even if the answer is empty, unclear, unsupported or still ambiguous. Do not repeat or rephrase the clarification question. Never ask for confirmation of one confidently resolved service. The latest answer supersedes the original service phrase; never recover it from an older booking. Do not ask the patient name again.`;
 clarify.edges.find(e=>e.id==='edge_service_clarified').destination_node_id='node_capture_service';
 clarify.edges.find(e=>e.id==='edge_service_clarified').transition_condition.prompt='Caller responds to the one service clarification, including an unclear, unusable, empty or ambiguous response. Always extract this response without asking again.';
 const service=nodes.get('node_service');
 const known=eq('service_already_resolved','node_doctor_preference','resolve_success','true');
 known.transition_condition.equations.push({left:'{{service_name}}',operator:'!=',right:''},{left:'{{qualified_practitioners}}',operator:'!=',right:'[]'},{left:'{{qualified_practitioners}}',operator:'!=',right:''});service.edges.unshift(known);
 service.else_edge={id:'service_capture_any_response',destination_node_id:'node_capture_service',transition_condition:{type:'prompt',prompt:'Else'}};
 service.instruction.text='Current patient {{client_name}} is established for verified cycle {{reset_attempt}}. Use only this cycle\'s explicit request {{fresh_request_summary}} and subsequent answers, never historical booking details. Use the established {{fresh_request_language}}. If service is resolved, continue silently to practitioner. Send any already supplied service phrase, including natural wording and aliases, to extraction/resolution immediately without asking for confirmation of a database label. If service is missing, ask only once: "And what would you like to book?" Arabic: "وشنو الخدمة اللي حاب تحجزها؟" After an unusable response proceed to extraction without repeating. Only the deterministic service gate may authorize one clarification. Do not ask practitioner preference before resolution. Never reuse historical patient, service, practitioner, dates, slots or consent.';
 service.edges.find(e=>e.id==='edge_service_resolve').transition_condition.prompt='A service phrase is already supplied, or caller has answered the missing-service question (including an unclear or unusable answer). Resolve before asking any service clarification.';
 const capture=nodes.get('node_capture_service');
 capture.variables[0].description=`Extract only the short service phrase from the latest service answer or explicit service change. On the first service capture only, use the current fresh_request_summary if no later service answer exists. After Clarify Service use ONLY the latest answer; empty/unusable means empty string, never fall back to the original unresolved phrase or a previous booking. Preserve natural service wording for the configured resolver and its aliases. Never require exact database spelling. Do not invent a canonical mapping or return a doctor, patient, date or whole summary.`;
 const guard=nodes.get('node_guard_service');
 // These unused contact/practitioner computations have no effect on service
 // input validation; omit them to fit Retell's existing flow storage limit.
 guard.code=guard.code.slice(0,guard.code.indexOf('const digits='))+guard.code.slice(guard.code.indexOf('if(!cycle||!nameOK)'));
 guard.code=guard.code.replace("if(!dv.service_query)error='service_missing';","const missing=!val(dv.service_query);").replace('service_query:query};','service_query:query,service_input_missing:missing};');
 guard.response_variables.service_input_missing='service_input_missing';
 const empty=eq('service_empty_once','node_service_result_gate','service_input_missing','true');
 empty.transition_condition.equations.push({left:'{{stage_ok}}',operator:'==',right:'true'});guard.edges.unshift(empty);
 // A resolved service can reach capture only through the existing intentional
 // service-change edge. Clear its dependent state here, after extracting the new
 // phrase. An unresolved clarification retains its already-consumed budget.
 const clear=nodes.get('node_guard_service_clear_result');
 clear.code=`const changed=dv.resolve_success===true||dv.resolve_success==='true';return {stage_ok:false,resolve_success:false,service_name:'',resolve_error_type:'',service_candidates:'[]',qualified_practitioners:'[]',...(changed?{service_clarification_attempts:0,selected_practitioner_id:'',selected_practitioner_name:'',practitioner_id:'',practitioner_name:'',practitioner_mode:'',practitioner_scope:''}:{})};`;
 for(const key of ['resolve_success','service_name','resolve_error_type','service_candidates','qualified_practitioners','service_clarification_attempts','selected_practitioner_id','selected_practitioner_name','practitioner_id','practitioner_name','practitioner_mode','practitioner_scope'])clear.response_variables[key]=key;
 // Reuse the existing concise human-assistance fallback unchanged.
 for(const n of f.nodes)for(const e of allEdges(n))if(e.destination_node_id==='node_service_fallback')e.destination_node_id='node_human_prepare';
 // Minify only changed code; keep readable source above. Preserve return values.
 for(const n of f.nodes)if(n.code&&n.code!==nodes.get(n.id)?.original_code&&n.code!==baseline.nodes.find(o=>o.id===n.id)?.code)n.code=transformSync('globalThis.__=(()=>{'+n.code+'})()',{minify:true,charset:'utf8',target:'es2020'}).code.replace('globalThis.__=','return ');
 Object.assign(f.default_dynamic_variables,{service_clarification_attempts:'0',service_clarification_cycle:'',service_clarification_used:'false',service_input_missing:'false',service_route:''});
 return f;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const root=new URL('./',import.meta.url);fs.writeFileSync(new URL('candidate.json',root),JSON.stringify(build(JSON.parse(fs.readFileSync(new URL('baseline-v21.json',root)))),null,2)+'\n');
}
