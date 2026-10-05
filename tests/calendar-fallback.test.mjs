import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {readFileSync} from 'node:fs';
import {availabilityWithFallback, calendarFollowUp, calendarBlocked, validateRanges} from '../supabase/functions/_shared/calendar-fallback.ts';
import {createClinicDatabase,asUser,tenants} from './helpers/clinic-database.mjs';
const db=await createClinicDatabase({appointments:true});after(()=>db.close());
await db.exec(readFileSync(new URL('../supabase/migrations/20261004180000_calendar_unavailable.sql',import.meta.url),'utf8'));
const [a,b]=tenants;
const details={clinicId:a.clinic,callId:a.call,patientName:'Secret Patient',patientPhone:'+12025550109',service:'Consultation',practitioner:a.staff,date:'2099-01-01',time:'10:00'};
function adapter({requestsDown=false, stateDown=false}={}) {
 return {from(table){let row,filters=[],single=false,upsert=false;const q={
  select:()=>q,abortSignal:()=>q,eq:(f,v)=>{filters.push([f,v]);return q},maybeSingle:()=>{single=true;return q},single:()=>{single=true;return q},
  insert:r=>{row=r;return q},upsert:r=>{row=r;upsert=true;return q},then:(yes,no)=>Promise.resolve().then(async()=>{
   if((requestsDown&&table==='voice_requests')||(stateDown&&table==='voice_call_state'))throw new Error('secret-token-private-provider-response');
   let sql,values;if(row){values=Object.values(row);sql=`insert into ${table} (${Object.keys(row).join(',')}) values (${values.map((_,i)=>'$'+(i+1)).join(',')})`;
   if(upsert)sql+=` on conflict (call_id) do update set ${Object.keys(row).filter(k=>k!=='call_id').map(k=>`${k}=excluded.${k}`).join(',')}`;
   sql+=' returning *';}else{values=filters.map(([,v])=>v);sql=`select * from ${table} where ${filters.map(([f],i)=>`${f}=$${i+1}`).join(' and ')}`;}
   try{const r=await db.query(sql,values);return {data:single?(r.rows[0]??null):r.rows,error:null}}catch(error){return {data:null,error}}
  }).then(yes,no)};return q}}
}
const limits={availabilityMs:15,followUpMs:500};let sequence=0;
const slot={slot_id:'signed.token',practitioner_id:a.staff,service_name:'Consultation',date:details.date,time:details.time};
const normal={success:true,available:true,slots:[slot]};
async function attempt(discover,store=adapter(),changes={}){const d={...details,callId:'calendar-test-'+(++sequence),...changes};const logs=[];const old=console.error;console.error=(...args)=>logs.push(args.join(' '));try{return {result:await availabilityWithFallback(store,d,discover,limits),logs,d}}finally{console.error=old}}
function unavailable(r){assert.equal(r.success,false);assert.equal(r.error_type,'calendar_unavailable');assert.deepEqual(r.slots,[]);assert.equal(r.available,false);assert.equal(r.requested_time_available,null);assert.equal(r.availability_checked,false);assert.equal(r.appointment_booked,false);assert.equal(r.appointment_confirmed,false);assert.equal(r.appointment_id,null);assert.equal(r.retry_allowed,false)}
test('normal availability and valid empty schedule pass through unchanged',async()=>{for(const result of [normal,{success:true,available:false,slots:[],error_type:'no_slots'}]){const r=await attempt(async()=>result);assert.deepEqual(r.result,result);assert.deepEqual(r.logs,[])}});
for(const [label,discover,category] of [
 ['database error',async()=>{throw {code:'XX000',message:'secret-token'}},'database_error'],
 ['backend error',async()=>({success:false,error_type:'database_error',message:'secret-token'}),'database_error'],
 ['throws/unreachable',async()=>{throw new Error('secret-token')},'dependency_unreachable'],
 ['timeout',()=>new Promise(()=>{}),'timeout'],
 ['malformed null',async()=>null,'invalid_response'],
 ['malformed slots',async()=>({success:true,available:true,slots:['invented']}),'invalid_response'],
 ['malformed failure',async()=>({success:false}),'invalid_response'],
 ['unknown failure',async()=>({success:false,error_type:'secret-token'}),'invalid_response'],
 ['malformed RPC',async()=>{validateRanges(null)},'invalid_response'],
 ['invalid RPC timestamp',async()=>{validateRanges([{start_time:'bad',end_time:'bad',duration_minutes:45}])},'invalid_response'],
 ['invalid RPC duration',async()=>{validateRanges([{start_time:'2099-01-01T10:00:00Z',end_time:'2099-01-01T10:45:00Z',duration_minutes:30}])},'invalid_response'],
]) test(label+': empty slots, unconfirmed, follow-up saved, safe logs',async()=>{const {result,logs,d}=await attempt(discover);unavailable(result);assert.equal(result.dependency_category,category);assert.equal(result.follow_up_saved,true);const row=(await db.query('select * from voice_requests where id=$1',[result.follow_up_request_id])).rows[0];assert.equal(row.clinic_id,a.clinic);assert.equal(row.call_id,d.callId);assert.equal(row.patient_name,d.patientName);assert.equal(row.phone,d.patientPhone);assert.equal(row.status,'Open');for(const v of ['Calendar unavailable — follow-up','calendar_unavailable',d.service,d.practitioner,d.date,d.time,'Failure timestamp:'])assert.ok(row.reason.includes(v));assert.equal(logs.length,1);assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(),['clinic_id','category','component','state','timestamp','dependency_category','follow_up_saved'].sort());for(const v of ['secret-token',d.patientName,d.patientPhone,d.practitioner])assert.ok(!logs.join('').includes(v));});
test('request persistence outage does not promise receipt',async()=>{const {result}=await attempt(async()=>{throw new Error()},adapter({requestsDown:true}));unavailable(result);assert.equal(result.follow_up_saved,false);assert.ok(result.patient_instruction.includes('contact the clinic directly'))});
test('whole database outage returns safe failure without executing discovery',async()=>{let called=0;const {result}=await attempt(async()=>{called++;return normal},adapter({stateDown:true,requestsDown:true}));unavailable(result);assert.equal(called,0);assert.equal(result.follow_up_saved,false)});
test('missing details can be collected later, saved once, and availability cannot retry',async()=>{const {result,d}=await attempt(async()=>{throw new Error()},adapter(),{patientName:'',patientPhone:''});assert.equal(result.follow_up_needs_details,true);const full={...d,patientName:details.patientName,patientPhone:details.patientPhone};const saved=await calendarFollowUp(adapter(),full,500);assert.equal(saved.follow_up_saved,true);let checks=0;const replay=await availabilityWithFallback(adapter(),full,async()=>{checks++;return normal},limits);assert.equal(checks,0);assert.equal(replay.follow_up_request_id,saved.follow_up_request_id);const blocked=await calendarBlocked(adapter(),full,500);unavailable(blocked);await db.query("update voice_requests set status='Closed' where id=$1",[saved.follow_up_request_id]);assert.ok(await calendarBlocked(adapter(),full,500));});
test('late discovery is aborted and cannot continue querying',async()=>{let finish,scoped;const {result}=await attempt(client=>{scoped=client;return new Promise(resolve=>{finish=resolve})});unavailable(result);assert.throws(()=>scoped.from('voice_checked_slots'));finish(normal);await Promise.resolve()});
test('follow-up retention remains isolated by existing clinic RLS',async()=>{const {result}=await attempt(async()=>{throw new Error()});await asUser(db,a.user,async sql=>assert.equal((await sql.query('select id from voice_requests where id=$1',[result.follow_up_request_id])).rows.length,1));await asUser(db,b.user,async sql=>{assert.equal((await sql.query('select id from voice_requests where id=$1',[result.follow_up_request_id])).rows.length,0);assert.equal((await sql.query("update voice_requests set status='Closed' where id=$1 returning id",[result.follow_up_request_id])).rows.length,0)})});
