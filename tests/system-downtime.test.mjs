import assert from 'node:assert/strict';
import test from 'node:test';
import {downtimeBoundary,downtimeResponse,downtimeResult,trustedContact,DOWNTIME_MESSAGE} from '../supabase/functions/_shared/system-downtime.ts';
const request = new Request('https://local.test');
function capture(run){const logs=[];const old=console.error;console.error=(x)=>logs.push(x);return Promise.resolve().then(()=>run(logs)).finally(()=>{console.error=old})}
test('runtime/bootstrap unavailable returns safe JSON, never empty',()=>capture(async logs=>{
 const r=await downtimeBoundary(async()=>{throw new Error('TOKEN patient transcript private payload')})(request);
 const b=await r.json();assert.equal(b.system_unavailable,true);assert.equal(b.message,DOWNTIME_MESSAGE);
 assert.deepEqual(JSON.parse(logs[0]),{clinic_id:null,call_id:null,category:'system_unavailable',dependency_category:'backend_unavailable',fallback_response_returned:true});
 assert.ok(!JSON.stringify(logs).includes('TOKEN'));
}));
for(const body of [null,{},[], ''])test('empty/malformed critical result cannot be success: '+JSON.stringify(body),()=>capture(async()=>{
 const b=await (await downtimeBoundary(async()=>Response.json(body))(request)).json();assert.equal(b.success,false);assert.equal(b.error_type,'system_unavailable');
}));
test('all confirmation flags and IDs safe',()=>{
 const b=downtimeResult();for(const field of ['success','available','requested_time_available','appointment_booked','resolved','follow_up_saved','transfer_allowed','availability_invalidated'])assert.equal(b[field],false);
 for(const field of ['appointment_id','follow_up_request_id','request_id','transfer_destination'])assert.equal(b[field],null);
});
test('specific fallbacks and confirmed success pass unchanged except current receipt',async()=>{
 for(const body of [{success:false,error_type:'booking_timeout',follow_up_saved:true},{success:false,error_type:'calendar_unavailable',follow_up_saved:false},{success:true,category:'unknown_answer',follow_up_saved:true},{success:true,category:'human_assistance',follow_up_saved:true},{success:true,transfer_result:'success'},{success:true,appointment_booked:true,appointment_id:'confirmed'}]){
  const b=await (await downtimeBoundary(async()=>Response.json(body))(request)).json();assert.deepEqual(b,{...body,apero_response_received:true,system_unavailable:false});
 }
});
test('authentication and foreign ownership denials remain closed',async()=>{
 for(const status of [401,403]){const r=await downtimeBoundary(async()=>new Response('Unauthorized',{status}))(request);assert.equal(r.status,status);assert.equal(await r.text(),'Unauthorized');}
});
test('only validated configured contact number formats are permitted',()=>{
 assert.equal(trustedContact('+965 2225 4100'),'+96522254100');assert.equal(trustedContact('2225-4100'),'22254100');
 for(const v of [null,{},'call +96522254100','+123<script>','++96522254100','+000000','+1234567890123456'])assert.equal(trustedContact(v),null);
});
function config(data,error=null){let reads=0;let filters=[];const q={select(){return q},eq(k,v){filters.push([k,v]);return q},single(){return q},abortSignal(){return Promise.resolve({data,error})}};return {db:{from(table){assert.equal(table,'clinics');reads++;return q}},check(){assert.equal(reads,1);assert.deepEqual(filters,[['id','clinic-a']])}}}
test('trusted clinic scoped config read supplies fallback then clinic phone',()=>capture(async()=>{
 for(const data of [{fallback_phone:'+96522254100',phone:'+96522254101'},{fallback_phone:'bad',phone:'+96522254101'}]){
 const c=config(data);const b=await (await downtimeResponse({clinicId:'clinic-a',callId:'call-a',dependency:'internal_error',db:c.db})).json();c.check();assert.ok(b.message.includes(data.fallback_phone.startsWith('+')?data.fallback_phone:data.phone));
 }
}));
test('no contact or failed read produces generic wording without retry',()=>capture(async()=>{
 for(const data of [null,{}, {phone:'patient claimed number'}]){const c=config(data);const b=await (await downtimeResponse({clinicId:'clinic-a',callId:'call-a',dependency:'internal_error',db:c.db})).json();c.check();assert.equal(b.message,DOWNTIME_MESSAGE)}
 const c=config(null,{message:'SECRET database error'});const b=await (await downtimeResponse({clinicId:'clinic-a',callId:'call-a',dependency:'internal_error',db:c.db})).json();c.check();assert.equal(b.message,DOWNTIME_MESSAGE);
}));
test('no trusted ownership means no config access',()=>capture(async()=>{
 await downtimeResponse({clinicId:'clinic-a',dependency:'internal_error',db:{from(){assert.fail('untrusted call config read')}}});
}));
