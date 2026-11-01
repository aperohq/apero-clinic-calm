// Read-only graph/data-contract checks; never executes the agent or any tool.
import fs from 'node:fs';import assert from 'node:assert/strict';import vm from 'node:vm';import {allEdges} from './build.mjs';
const f=JSON.parse(fs.readFileSync(new URL('candidate.json',import.meta.url))),nodes=new Map(f.nodes.map(n=>[n.id,n]));
const roots=[f.start_node_id,...f.nodes.filter(n=>n.global_node_setting).map(n=>n.id)];
const reach=(root,removed)=>{const queue=[root],seen=new Set();while(queue.length){const id=queue.pop();if(seen.has(id)||removed.has(id))continue;seen.add(id);queue.push(...allEdges(nodes.get(id)).map(e=>e.destination_node_id));}return seen;};
const edgeIDs=new Set();let codeNodes=0;
for(const n of f.nodes){if(n.code){new vm.Script(`(function(){${n.code}})()`);assert.ok(n.code.length<=20000);codeNodes++;}for(const e of allEdges(n)){assert.ok(nodes.has(e.destination_node_id),`${n.id} → ${e.destination_node_id}`);assert.ok(!edgeIDs.has(e.id));edgeIDs.add(e.id);}}
for(const target of ['node_book','node_book_arabic_wait'])for(const guard of ['node_guard_patient','node_final','node_capture_consent','node_guard_book',target==='node_book'?'node_intake_entry_node_book':'node_intake_entry_node_book_arabic_wait'])for(const root of roots)assert.ok(!reach(root,new Set([guard])).has(target),`${target} bypasses ${guard}`);
for(const target of ['node_cancel_tool','node_cancel_tool_arabic_wait','node_reschedule_tool','node_reschedule_tool_arabic_wait'])for(const guard of ['node_r18_existing_approval','node_r18_existing_entry','node_r18_existing_fresh_lookup','node_r18_existing_fresh_guard','node_r18_entry_'+target])for(const root of roots)assert.ok(!reach(root,new Set([guard])).has(target));
for(const [target,guard]of [['node_booked','node_r18_booking_result'],['node_cancelled','node_r18_existing_result'],['node_rescheduled','node_r18_existing_result']])for(const root of roots)assert.ok(!reach(root,new Set([guard])).has(target));
const latchWriters=f.nodes.filter(n=>Object.hasOwn(n.response_variables||{},'booking_reconciliation_required')).map(n=>n.id).sort();
assert.deepEqual(latchWriters,['node_intake_entry_node_book','node_intake_entry_node_book_arabic_wait','node_r18_booking_result'].sort());
for(const n of f.nodes.filter(n=>n.type==='extract_dynamic_variables'))for(const v of n.variables)assert.ok(!['booking_reconciliation_required','existing_selected_id','existing_target_snapshot','current_availability_check','current_availability_snapshot'].includes(v.name));
for(const tool of f.tools.filter(t=>['cancel_appointment','reschedule_appointment'].includes(t.name)))for(const [key,p]of Object.entries(tool.parameters.properties))assert.ok(Object.hasOwn(p,'const')||key==='action'&&p.enum.length===1,tool.name+':'+key);
for(const id of ['node_cancel_tool','node_cancel_tool_arabic_wait','node_reschedule_tool','node_reschedule_tool_arabic_wait']){
 const clear=nodes.get('node_downtime_prepare_'+id).code;assert.ok(clear.includes('"cancelled_id":""'));assert.ok(clear.includes('"rescheduled_id":""'));
 assert.ok(!nodes.get(id).edges.some(e=>['node_cancelled','node_rescheduled'].includes(e.destination_node_id)));
}
for(const id of ['node_match_slot','node_correction_guard'])assert.ok(!nodes.get(id).code.includes('check!==token.q'));
const reachable=new Set(roots.flatMap(root=>[...reach(root,new Set())]));assert.equal(reachable.size,nodes.size);
console.log(JSON.stringify({passed:true,nodes:nodes.size,explicit_transitions:edgeIDs.size,code_nodes_compiled:codeNodes,reachable_nodes:reachable.size,
 current_creation_latch_writers:latchWriters,all_mutations_guarded:true,current_result_validators_required:true,target_ids_not_model_extracted:true,
 proof_scope:'Unavoidable entry/result guards plus producer restrictions and generated-code state fixtures. Phase-dependent correction skips are validated by data invariants, not false all-stage dominator claims.',calls:0},null,2));
