import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createClinicDatabase,asUser,tenants,uuid} from './helpers/clinic-database.mjs';
import {transferGate,transferFallback,transferEvent,withinTransferHours,configuredDestination,TRANSFER_FAILED_SAVED,TRANSFER_FAILED_UNSAVED} from '../supabase/functions/_shared/call-transfer.ts';
const db=await createClinicDatabase({settings:true,appointments:true});
await db.exec(await readFile(new URL('../supabase/migrations/20261005120000_call_transfer.sql',import.meta.url),'utf8'));
after(()=>db.close());const[a,b]=tenants;
const hours={days:Array.from({length:7},(_,day)=>({day,periods:[{start:'00:00',end:'23:59'}]}))};
const destination='+12025550123'; // Local synthetic fixture only; never deployed as clinic configuration.
const adapter={
 from(table){let fields='*',filters=[],row,single=false;const q={
 select(v){fields=v;return q},eq(k,v){filters.push([k,v]);return q},single(){single=true;return q},maybeSingle(){single=true;return q},abortSignal(){return q},insert(v){row=v;return q},
 then(resolve,reject){return Promise.resolve().then(async()=>{
 try{const values=row?Object.values(row):filters.map(([,v])=>v);
 const sql=row?`insert into ${table} (${Object.keys(row).join(',')}) values (${values.map((_,i)=>'$'+(i+1))}) returning ${fields}`:
 `select ${fields} from ${table} where ${filters.map(([k],i)=>`${k}=$${i+1}`).join(' and ')}`;
 const result=await db.query(sql,values);return{data:single?(result.rows[0]??null):result.rows,error:null};}catch(error){return{data:null,error};}
 }).then(resolve,reject)}};return q;},
 rpc(name,args){const q={abortSignal(){return q},then(resolve,reject){return Promise.resolve().then(async()=>{try{
 const result=await db.query(`select ${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) as value`,Object.values(args));return{data:result.rows[0].value,error:null};
 }catch(error){return{data:null,error}}}).then(resolve,reject)}};return q;}
};
async function configure(patch={}){await db.query('update clinics set fallback_phone=$1,opening_hours=$2::jsonb,timezone=$3,live_transfer_enabled=$4 where id=$5',[
 Object.hasOwn(patch,'phone')?patch.phone:destination,JSON.stringify(Object.hasOwn(patch,'hours')?patch.hours:hours),patch.timezone??'UTC',patch.enabled??true,a.clinic]);}
let seq=0;const context=(extra={})=>({clinicId:a.clinic,callId:'transfer-test-'+(++seq),category:'explicit_human_request',explicitHuman:true,liveAppropriate:false,callType:'phone_call',inboundNumber:'',...extra});
const details=c=>({...c,name:'',phone:''});
async function run(fn){const logs=[],old=console.info;console.info=(v)=>logs.push(JSON.parse(v));try{return{value:await fn(),logs};}finally{console.info=old;}}
test('explicit human request with configured destination during hours permits one attempt',async()=>{
 await configure();const c=context();const {value}=await run(()=>transferGate(adapter,c));
 assert.equal(value.transfer_allowed,true);assert.equal(value.transfer_destination,destination);
 assert.equal((await db.query('select count(*)::int n from voice_requests where call_id=$1',[c.callId])).rows[0].n,0);
 const second=(await run(()=>transferGate(adapter,c))).value;assert.equal(second.transfer_allowed,false);
});
test('appropriate existing escalation may transfer; follow-up-only and normal requests never do',async()=>{
 await configure();
 assert.equal((await transferGate(adapter,context({category:'appointment_dispute',explicitHuman:false,liveAppropriate:true}))).transfer_allowed,true);
 for(const extra of [{explicitHuman:false,liveAppropriate:false},{category:'supported_request'},{category:'booking_failed'},{category:'calendar_unavailable'},{category:'unknown_answer'}])
 assert.equal((await transferGate(adapter,context(extra))).transfer_allowed,false);
});
test('missing destination and after hours block transfer; existing human retention provides follow-up',async()=>{
 const {humanEscalationFollowUp}=await import('../supabase/functions/_shared/human-escalation.ts');
 for(const [patch,result]of [[{phone:null},'no_destination'],[{hours:{days:hours.days.map(d=>({...d,periods:[]}))}},'after_hours'],[{hours:null},'after_hours']]){
 await configure(patch);const c=context();const gate=(await run(()=>transferGate(adapter,c))).value;
 assert.equal(gate.transfer_allowed,false);assert.equal(gate.transfer_destination,null);assert.equal(gate.transfer_result,result);
 const saved=(await run(()=>humanEscalationFollowUp(adapter,{...details(c),requested:true,reason:'Please speak to clinic staff'}))).value;
 assert.equal(saved.follow_up_saved,true);
 assert.equal((await asUser(db,b.user,d=>d.query('select * from voice_requests where id=$1',[saved.follow_up_request_id]))).rows.length,0);
 }
});
test('activation defaults off and disabled/web calls/self destination fail closed',async()=>{
 const defaults=await db.query('select live_transfer_enabled from clinics where id=$1',[b.clinic]);assert.equal(defaults.rows[0].live_transfer_enabled,false);
 for(const [patch,extra]of [[{enabled:false},{}],[{}, {callType:'web_call'}],[{},{inboundNumber:destination}]]){
 await configure(patch);assert.equal((await run(()=>transferGate(adapter,context(extra)))).value.transfer_allowed,false);
 }
});
for(const [reason,category]of [['dial_busy','busy'],['dial_no_answer','no_answer'],['transfer_timeout','timeout'],['dial_failed','provider_error'],['user_declined','provider_error']])
 test(`${category}/${reason}: signed provider failure saves existing human escalation once`,async()=>{
 await configure();const c=context();await run(()=>transferGate(adapter,c));
 const {logs}=await run(()=>transferEvent(adapter,details(c),'transfer_cancelled',reason));
 const rows=(await db.query('select * from voice_requests where call_id=$1',[c.callId])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].status,'Open');assert.ok(rows[0].reason.startsWith('Human assistance required'));
 const again=(await run(()=>transferFallback(adapter,details(c)))).value;assert.equal(again.follow_up_saved,true);assert.equal(again.message,TRANSFER_FAILED_SAVED);
 assert.equal((await db.query('select count(*)::int n from voice_requests where call_id=$1',[c.callId])).rows[0].n,1);
 const log=logs.find(l=>l.transfer_result===category);assert.equal(log.transfer_attempted,true);assert.equal(log.fallback_escalation_saved,true);
 });
test('verified successful bridge never creates failure; late failure/started events cannot downgrade it',async()=>{
 await configure();const c=context();await run(()=>transferGate(adapter,c));
 await run(()=>transferEvent(adapter,details(c),'transfer_started',null));
 const {logs}=await run(()=>transferEvent(adapter,details(c),'transfer_bridged',null));assert.equal(logs[0].transfer_result,'success');
 await run(()=>transferEvent(adapter,details(c),'transfer_cancelled','dial_busy'));
 await run(()=>transferEvent(adapter,details(c),'transfer_started',null));
 assert.equal((await run(()=>transferFallback(adapter,details(c)))).value.transfer_result,'success');
 assert.equal((await run(()=>transferGate(adapter,c))).value.fallback_required,false);
 assert.equal((await db.query('select count(*)::int n from voice_requests where call_id=$1',[c.callId])).rows[0].n,0);
});
test('unknown native failure returns to safe follow-up even without a specific provider cause',async()=>{
 await configure();const c=context();await run(()=>transferGate(adapter,c));
 const result=(await run(()=>transferFallback(adapter,details(c)))).value;
 assert.equal(result.transfer_result,'provider_error');assert.equal(result.follow_up_saved,true);
});
test('save failure wording and operational logs contain no contacts/reason/provider secrets',async()=>{
 await configure();const c=context();await run(()=>transferGate(adapter,c));
 const failed={...adapter,from(table){if(table==='voice_requests')throw Error('secret-token-private-patient');return adapter.from(table);}};
 const {value,logs}=await run(()=>transferFallback(failed,{...c,name:'Private Patient',phone:'+12025550199'}));
 assert.equal(value.follow_up_saved,false);assert.equal(value.message,TRANSFER_FAILED_UNSAVED);
 const transfer=logs.find(l=>Object.hasOwn(l,'transfer_attempted'));assert.deepEqual(Object.keys(transfer).sort(),['call_id','clinic_id','fallback_escalation_saved','transfer_attempted','transfer_result']);
 for(const sensitive of ['Private Patient','+12025550199','secret-token','requested live transfer'])assert.equal(JSON.stringify(logs).includes(sensitive),false);
});
test('caller-supplied destination is ignored; foreign clinic cannot read destination or settings',async()=>{
 await configure();const c=context({transfer_destination:'+12025550999',clinic_id:b.clinic});
 assert.equal((await run(()=>transferGate(adapter,c))).value.transfer_destination,destination);
 assert.equal((await asUser(db,b.user,d=>d.query('select fallback_phone,live_transfer_enabled from clinics where id=$1',[a.clinic]))).rows.length,0);
 await assert.rejects(asUser(db,b.user,d=>d.query('select voice_claim_transfer($1,$2,$3,$4)',[a.clinic,'foreign','explicit_human_request',destination])),e=>e.code==='42501');
});
test('owner may change clinic activation through existing Settings RPC; foreign direct writes are blocked',async()=>{
 await configure({enabled:false});
 const saved=await asUser(db,a.user,d=>d.query("select live_transfer_enabled from update_clinic_settings('{\"live_transfer_enabled\":true}'::jsonb,'{\"live_transfer_enabled\":false}'::jsonb)"));
 assert.equal(saved.rows[0].live_transfer_enabled,true);
 const foreign=await asUser(db,b.user,d=>d.query('update clinics set live_transfer_enabled=false where id=$1 returning id',[a.clinic]));assert.equal(foreign.rows.length,0);
});
test('atomic claim preserves calendar/booking state and rejects concurrent or foreign claims',async()=>{
 await configure();const c=context();await db.query('insert into voice_call_state(call_id,clinic_id,current_check_id) values($1,$2,$3)',[c.callId,a.clinic,'00000000-0000-4000-8000-000000000555']);
 const claims=await Promise.all([transferGate(adapter,c),transferGate(adapter,c)]);assert.equal(claims.filter(c=>c.transfer_allowed).length,1);
 assert.equal((await db.query("select transfer_result from voice_call_state where call_id=$1",[c.callId])).rows[0].transfer_result,"ready");
 assert.equal((await db.query('select current_check_id from voice_call_state where call_id=$1',[c.callId])).rows[0].current_check_id,'00000000-0000-4000-8000-000000000555');
 const foreign=await db.query('select voice_claim_transfer($1,$2,$3,$4) ok',[b.clinic,c.callId,'explicit_human_request',destination]);assert.equal(foreign.rows[0].ok,false);
});
test('hours use configured timezone, closing boundary, breaks, and fail closed for invalid data',()=>{
 const h={days:hours.days.map(d=>({...d,periods:d.day===1?[{start:'09:00',end:'12:00'},{start:'13:00',end:'17:00'}]:[]}))};
 assert.equal(withinTransferHours(h,'Asia/Kuwait',new Date('2026-10-05T06:00:00Z')),true);
 assert.equal(withinTransferHours(h,'Asia/Kuwait',new Date('2026-10-05T09:00:00Z')),false);
 assert.equal(withinTransferHours(h,'Asia/Kuwait',new Date('2026-10-05T14:00:00Z')),false);
 assert.equal(withinTransferHours(h,'bad-zone'),false);assert.equal(withinTransferHours({days:[]},'UTC'),false);
 for(const v of [null,'2225 4100','sip:user@domain','{{caller_number}}','+12025550123#','+00012345678'])assert.equal(configuredDestination(v),null);
});

test('manager and staff cannot activate transfer through Settings or direct writes',async()=>{
 await configure({enabled:false});
 let id=800;
 for(const role of ['manager','staff']){
  const user=uuid(++id),profile=uuid(++id);
  await db.query('insert into auth.users(id,email) values($1,$2)',[user,role+'-transfer@example.test']);
  await db.query('insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3,$4,$5,$6)',[profile,user,a.clinic,role,role+'-transfer@example.test',role]);
  await assert.rejects(asUser(db,user,d=>d.query("select * from update_clinic_settings('{\"live_transfer_enabled\":true}'::jsonb,'{\"live_transfer_enabled\":false}'::jsonb)")),e=>e.code==='42501');
  const result=await asUser(db,user,d=>d.query('update clinics set live_transfer_enabled=true where id=$1 returning id',[a.clinic]));assert.equal(result.rows.length,0);
 }
});
test('database outage during transfer guard fails closed without destination or raw error logs',async()=>{
 const {value,logs}=await run(()=>transferGate({from(){throw Error('secret-token-phone')}} ,context()));
 assert.equal(value.transfer_allowed,false);assert.equal(value.transfer_destination,null);assert.equal(value.transfer_result,'provider_error');
 assert.equal(JSON.stringify(logs).includes('secret-token-phone'),false);
});
