// Deterministic graph/code fixtures only. No agent execution, network, or SDK.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveService} from '../../supabase/functions/clinic-operations/logic.ts';
const root=new URL('./',import.meta.url);
const f=JSON.parse(fs.readFileSync(new URL('candidate.json',root)));
const before=JSON.parse(fs.readFileSync(new URL('published-v16.json',root)));
const nodes=new Map(f.nodes.map(n=>[n.id,n]));
const allEdges=n=>[...(n.edges||[]),n.else_edge,n.always_edge,n.edge].filter(Boolean);
const run=(id,dv)=>vm.runInNewContext(`(function(){${nodes.get(id).code}})()`,{dv,Date,JSON},{timeout:1000});
const store=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)]));
const base={...f.default_dynamic_variables,reset_attempt:'cycle-1',reset_verified_attempt:'cycle-1',reset_ready:'true',boundary_verified:'true',
 active_booking_state:JSON.stringify({cycle:'cycle-1',phase:'fresh'}),client_name:'Ahmed',intake_name_cycle:'cycle-1',intake_name_evidence:'I am Ahmed',
 resolve_success:'true',service_name:'Dental Cleaning',service_query:'Cleaning',practitioner_mode:'any',practitioner_id:'',practitioner_name:'',
 qualified_practitioners:JSON.stringify([{id:'dr-a',name:'Doctor A'},{id:'dr-b',name:'Doctor B'}]),
 client_phone:'+96599123456',patient_confirmed:'true',patient_evidence:'Ahmed +96599123456',search_mode:'earliest'};
test('approved Arabic aliases resolve to existing services; ambiguous and unsupported requests fail safely',()=>{
 const aliases=JSON.parse(fs.readFileSync(new URL('approved-arabic-aliases.json',root)));
 const staff=Object.keys(aliases).map((service,i)=>({id:String(i),full_name:'Doctor '+i,specialty:'',services:[service],aliases:[]}));
 for(const [service,values] of Object.entries(aliases))for(const alias of values){
  assert.equal(resolveService(staff,alias,aliases).service,service);
  const guarded=run('node_guard_service',{...base,service_query:alias});
  assert.equal(guarded.service_query,service);assert.equal(resolveService(staff,guarded.service_query,{}).service,service);
 }
 assert.equal(resolveService(staff,'spaceship repair',aliases).status,'not_found');
 assert.equal(resolveService(staff,'shared',{Consultation:['shared'],'Dental Cleaning':['shared']}).status,'ambiguous');
});
const route=dv=>run('node_intake_before_time',dv).intake_route;
const edgeMatch=(e,dv)=>{
 const c=e.transition_condition;if(c.type!=='equation')return false;
 const v=s=>String(s??'').replace(/{{(.*?)}}/g,(_,k)=>String(dv[k]??''));
 const values=c.equations.map(q=>q.operator==='=='?v(q.left)===v(q.right):q.operator==='!='?v(q.left)!==v(q.right):q.operator==='exists'?!!v(q.left):false);
 return c.operator==='||'?values.some(Boolean):values.every(Boolean);
};
const next=(id,dv)=>nodes.get(id).edges.find(e=>edgeMatch(e,dv))?.destination_node_id;

test('1 standard booking has enforced name, service, practitioner, contact, date, availability, selected slot, consent, booking',()=>{
 assert.equal(next('node_reset_verify',{reset_ready:'true',reset_verified_attempt:'x',reset_attempt:'x',first_cycle_proven:'true'}),'node_intake_name_capture');
 const empty={...base,client_name:'',intake_name_cycle:'',intake_name_evidence:'',resolve_success:'false',client_phone:''};
 assert.equal(run('node_intake_name_gate',empty).intake_route,'name');
 assert.equal(run('node_intake_name_gate',{...empty,client_name:'Ahmed',intake_name_evidence:'I am Ahmed'}).intake_route,'service');
 assert.equal(route({...base,resolve_success:'false'}),'service');
 assert.equal(route({...base,practitioner_mode:''}),'doctor');
 assert.equal(route({...base,client_phone:''}),'contact');
 assert.equal(route(base),'date');
 assert.equal(nodes.get('node_date_time').edges[0].destination_node_id,'node_capture_search');
 assert.equal(run('node_guard_search',base).stage_ok,true);
 assert.equal(nodes.get('node_offer').edges.find(e=>e.id==='edge_offer_select').destination_node_id,'node_capture_slot');
 assert.equal(nodes.get('node_guard_slot').edges[0].destination_node_id,'node_capture_patient');
 assert.equal(nodes.get('node_guard_patient').edges[0].destination_node_id,'node_final');
 assert.equal(nodes.get('node_guard_book').edges[0].destination_node_id,'node_book_wait_language_gate');
});
test('2 service supplied before name is retained and name is next',()=>{
 const dv={...base,client_name:'',intake_name_cycle:'',intake_name_evidence:''};
 assert.equal(route(dv),'name');assert.equal(run('node_intake_name_gate',dv).intake_route,'name');assert.equal(dv.service_name,'Dental Cleaning');
});
test('3 name and service supplied skips them and requires missing practitioner/contact',()=>{
 assert.equal(route({...base,practitioner_mode:'',client_phone:''}),'doctor');
 assert.equal(route({...base,client_phone:''}),'contact');
});
test('4 most information supplied skips known fields, missing contact still precedes time',()=>{
 const dv={...base,practitioner_mode:'specific',practitioner_id:'dr-a',practitioner_name:'Doctor A',requested_date:'2030-02-04',requested_time:'15:00',search_mode:'exact'};
 assert.equal(route(dv),'date');assert.equal(run('node_guard_search',dv).stage_ok,true);
 assert.equal(route({...dv,client_phone:''}),'contact');
 assert.equal(run('node_guard_search',{...dv,client_phone:''}).stage_ok,false);
});
for(const [number,field] of [[5,'client_name'],[6,'service_name'],[7,'practitioner_mode']]){
 test(`${number} missing ${field} blocks search and every booking tool entry`,()=>{
  const dv={...base,[field]:''};assert.equal(run('node_guard_search',dv).stage_ok,false);assert.equal(run('node_guard_book',dv).stage_ok,false);
  for(const n of f.nodes.filter(n=>/^node_intake_entry_/.test(n.id)&&!n.id.endsWith('_clear')))assert.throws(()=>run(n.id,dv));
 });
}
test('8 calendar unavailable and malformed/transport fallback remains unchanged',()=>{
 for(const id of ['node_check','node_check_arabic_wait','node_check_silent']){
  assert.deepEqual(nodes.get(id),before.nodes.find(n=>n.id===id));
  assert.equal(next(id,{apero_response_received:'true',apero_system_unavailable:'false',calendar_error:'calendar_unavailable'}),'node_calendar_unavailable');
  assert.equal(nodes.get(id).else_edge.destination_node_id,'node_calendar_unavailable');
 }
});
test('9 booking failure cannot confirm; true success requires booked flag and nonempty ID',()=>{
 for(const id of ['node_book','node_book_arabic_wait']){
  for(const result of [{booking_success:'false',booking_id:''},{booking_success:'true',booking_id:'',appointment_booked:'true'},{booking_success:'true',booking_id:'id',appointment_booked:'false'}]){
   assert.notEqual(next(id,{apero_response_received:'true',apero_system_unavailable:'false',...result}),'node_booked');
  }
  assert.equal(next(id,{apero_response_received:'true',apero_system_unavailable:'false',booking_success:'true',booking_id:'id',appointment_booked:'true'}),'node_booked');
  assert.equal(nodes.get(id).else_edge.destination_node_id,'node_book_failed');
 }
});
test('10 FAQ has original separate route and does not force booking intake',()=>{
 assert.deepEqual(nodes.get('node_initial_language'),before.nodes.find(n=>n.id==='node_initial_language'));
 assert.equal(nodes.get('node_initial_language').edges.find(e=>e.id.endsWith('greeting_faq')).destination_node_id,'node_initial_faq');
});
test('11 unknown answer and 12 human escalation/transfer/downtime retain exact nodes and tools',()=>{
 for(const old of before.nodes.filter(n=>/unknown|human|transfer|downtime|calendar/.test(n.id))){
  // Five scheduling tool entry wrappers are the only changed downtime nodes.
  if(/^node_downtime_prepare_node_(check|book)(_|$)/.test(old.id))continue;
  const expected=structuredClone(old);
  for(const e of allEdges(expected))if(/^node_downtime_prepare_node_check(_arabic_wait|_silent)?$/.test(e.destination_node_id))e.destination_node_id='node_intake_entry_'+e.destination_node_id.replace('node_downtime_prepare_','')+'_clear';
  assert.deepEqual(nodes.get(old.id),expected,old.id);
 }
 for(const old of before.tools.filter(t=>t.name!=='check_fresh_availability'))assert.deepEqual(f.tools.find(t=>t.tool_id===old.tool_id),old);
});
test('all code compiles; all targets and edge IDs are valid; no structural bypass of service/date/tool guards',()=>{
 assert.equal(nodes.size,f.nodes.length);const ids=new Set();
 for(const n of f.nodes){
  if(n.type==='code')new vm.Script(`(function(){${n.code}})()`);
  for(const e of allEdges(n)){assert.ok(nodes.has(e.destination_node_id),`${n.id} -> ${e.destination_node_id}`);assert.ok(!ids.has(e.id),e.id);ids.add(e.id);}
  for(const e of allEdges(n)){
   if(e.destination_node_id==='node_service')assert.ok(['node_intake_name_gate','node_intake_before_time'].includes(n.id));
   if(e.destination_node_id==='node_date_time')assert.equal(n.id,'node_intake_before_time');
   if(/^node_downtime_prepare_node_(check|book)(_|$)/.test(e.destination_node_id)&&!e.destination_node_id.includes('reschedule'))assert.equal(n.id,'node_intake_entry_'+e.destination_node_id.replace('node_downtime_prepare_',''));
  }
 }
});
test('missing code result cannot reuse a previous routing acknowledgement',()=>{
 for(const n of f.nodes.filter(n=>n.id.startsWith('node_intake_')&&n.type==='code'&&!n.id.endsWith('_clear'))){
  const clear=nodes.get(n.id+'_clear');assert.ok(clear);const out=run(clear.id,{...base,intake_route:'date',intake_entry_ok:'true'});
  const ack='intake_route' in out?'intake_route':'intake_entry_ok';assert.ok(!out[ack]);
  assert.equal(next(n.id,store(out)),undefined);
  assert.equal(n.else_edge.destination_node_id,'node_reset_failed');
 }
});
test('one practitioner auto-selects; any qualified mode reaches deployed backend as any',()=>{
 const result=run('node_intake_before_time',{...base,qualified_practitioners:'[{"id":"dr-a","name":"Doctor A"}]',practitioner_mode:''});
 assert.equal(result.intake_route,'date');assert.equal(result.practitioner_id,'dr-a');
 assert.equal(run('node_guard_search',base).stage_ok,true);assert.equal(run('node_guard_search',{...base,practitioner_mode:'any_qualified'}).stage_ok,false);
});
test('phone validation and current-cycle evidence prevent stale/metadata patient defaults',()=>{
 for(const dv of [{...base,client_phone:'123'},{...base,patient_evidence:'old patient'},{...base,intake_name_cycle:'older-cycle'},{...base,patient_confirmed:'false'}])assert.notEqual(route(dv),'date');
 const corrected=run('node_clear_correction',base);for(const key of ['client_name','client_phone','patient_confirmed','patient_evidence'])assert.ok(!(key in corrected));
 assert.equal(run('node_intake_name_gate',{...base,active_booking_state:'{"cycle":"old"}'}).intake_route,'blocked');
});
test('valid exact selected tuple reaches booking, tampered or missing fields fail closed',()=>{
 const slot={slot_id:'verified-offline-fixture',service_name:base.service_name,practitioner_id:'dr-a',date:'2030-02-04',time:'15:00'};
 let dv={...base,slot_id:slot.slot_id,availability_success:'true',slots:JSON.stringify([slot])};
 dv={...dv,...store(run('node_guard_slot',dv))};
 dv={...dv,...store(run('node_guard_patient',dv))};assert.equal(dv.stage_ok,'true');
 dv={...dv,consent_confirmed:'true',consent_tuple:dv.booking_readback};
 const result=run('node_guard_book',dv);assert.equal(result.stage_ok,true);dv={...dv,...store(result)};
 assert.equal(run('node_intake_entry_node_book',dv).intake_entry_ok,true);
 for(const key of ['client_name','client_phone','service_name','practitioner_id','slot_id','appointment_date','appointment_time'])assert.equal(run('node_guard_book',{...dv,[key]:''}).stage_ok,false,key);
});
