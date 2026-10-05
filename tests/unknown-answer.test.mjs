import assert from "node:assert/strict";
import test, { after } from "node:test";
import { unknownAnswerFollowUp, unknownAnswerResult, UNKNOWN_MESSAGE, UNKNOWN_SAVE_FAILED } from "../supabase/functions/_shared/unknown-answer.ts";
import { createClinicDatabase, asUser, tenants } from "./helpers/clinic-database.mjs";
const db = await createClinicDatabase({ appointments: true });
after(() => db.close());
const [a,b] = tenants;
function adapter({ unavailable = false } = {}) {
  return {
    from(table) {
      assert.equal(table, "voice_requests");
      let row,
        filters = [],
        single = false;
      const q = {
        select: () => q,
        abortSignal: () => q,
        eq: (field, value) => {
          filters.push([field, value]);
          return q;
        },
        maybeSingle: () => {
          single = true;
          return q;
        },
        single: () => {
          single = true;
          return q;
        },
        insert: (value) => {
          row = value;
          return q;
        },
        then: (resolve, reject) =>
          Promise.resolve()
            .then(async () => {
              if (unavailable) throw new Error("secret-token-private-patient");
              const values = row ? Object.values(row) : filters.map(([, value]) => value);
              const sql = row
                ? `insert into voice_requests (${Object.keys(row).join(",")}) values (${values.map((_, i) => `$${i + 1}`).join(",")}) returning id,status`
                : `select id,status from voice_requests where ${filters.map(([field], i) => `${field} = $${i + 1}`).join(" and ")}`;
              try {
                const result = await db.query(sql, values);
                return { data: single ? (result.rows[0] ?? null) : result.rows, error: null };
              } catch (error) {
                return { data: null, error };
              }
            })
            .then(resolve, reject),
      };
      return q;
    },
  };
}

let sequence=0;
const details={clinicId:a.clinic,callId:a.call,requested:true,question:"What does this treatment cost?",name:"Private Patient",phone:"+12025550109"};
async function run(overrides={},store=adapter(),ms=1000){
 const logs=[],old=console.info,oldError=console.error;console.info=console.error=(...args)=>logs.push(args.join(" "));
 try{return {result:await unknownAnswerFollowUp(store,{...details,callId:`unknown-${++sequence}`,...overrides},ms),logs};}
 finally{console.info=old;console.error=oldError;}
}
test("unknown information result contains no invented answer or price",()=>{
 const result=unknownAnswerResult();assert.equal(result.answer,null);assert.equal(result.answer_known,false);
 assert.equal(result.category,"unknown_answer");assert.equal(result.message,UNKNOWN_MESSAGE);
 assert.equal(result.follow_up_saved,false);assert.equal(result.follow_up_status,"not_requested");
 assert.equal(Object.hasOwn(result,"price"),false);assert.equal(Object.hasOwn(result,"practitioner"),false);
});
test("no requested follow-up means no collection, database writes or logs",async()=>{
 const store={from(){throw Error("must not access database");}};
 const {result,logs}=await run({requested:false},store);assert.deepEqual(result,unknownAnswerResult());assert.deepEqual(logs,[]);
});
test("requested question is retained in existing Requests queue and clinic RLS blocks other clinics",async()=>{
 const {result,logs}=await run();assert.equal(result.follow_up_saved,true);assert.equal(result.follow_up_status,"Open");
 const row=(await asUser(db,a.user,sql=>sql.query("select * from voice_requests where id=$1",[result.follow_up_request_id]))).rows[0];
 assert.equal(row.clinic_id,a.clinic);assert.equal(row.kind,"message");assert.equal(row.patient_name,details.name);
 assert.equal(row.phone,details.phone);assert.ok(row.created_at);assert.ok(row.call_id);
 assert.equal(row.reason,"AI couldn’t answer — follow-up\nCategory: unknown_answer\nQuestion: "+details.question);
 assert.equal((await asUser(db,b.user,sql=>sql.query("select * from voice_requests where id=$1",[result.follow_up_request_id]))).rows.length,0);
 assert.equal(logs.length,1);assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(),["category","clinic_id","component","follow_up_saved","state","timestamp"]);
 for(const sensitive of [details.name,details.phone,details.question,"secret-token"])assert.equal(logs.join().includes(sensitive),false);
});
test("name and phone are optional and absent data is not fabricated",async()=>{
 const {result}=await run({name:"",phone:""});assert.equal(result.follow_up_saved,true);
 const row=(await db.query("select patient_name,phone from voice_requests where id=$1",[result.follow_up_request_id])).rows[0];
 assert.equal(row.patient_name,null);assert.equal(row.phone,"");
});
test("same question is idempotent; a different question in the same call is kept",async()=>{
 const callId="unknown-dedupe";
 const first=(await run({callId})).result,second=(await run({callId})).result;
 assert.equal(second.follow_up_request_id,first.follow_up_request_id);
 const third=(await run({callId,question:"What are the holiday hours?"})).result;
 assert.notEqual(third.follow_up_request_id,first.follow_up_request_id);
});
for(const [label,store,overrides,ms] of [
 ["throw",adapter({unavailable:true}),{},1000],
 ["database error",{from:()=>({select(){return this},eq(){return this},maybeSingle(){return this},abortSignal(){return Promise.resolve({data:null,error:{message:"secret-token"}})}})}, {},1000],
 ["timeout",{from:()=>({select(){return this},eq(){return this},maybeSingle(){return this},abortSignal(){return new Promise(()=>{})}})}, {},10],
 ["empty question",adapter(),{question:""},1000],
])test(`${label}: save failure is safe and logs no question or dependency secrets`,async()=>{
 const {result,logs}=await run(overrides,store,ms);assert.equal(result.follow_up_saved,false);
 assert.equal(result.follow_up_status,"not_saved");assert.equal(result.message,UNKNOWN_SAVE_FAILED);assert.equal(result.answer,null);
 assert.equal(logs.length,1);assert.equal(JSON.parse(logs[0]).follow_up_saved,false);
 for(const sensitive of [details.question,details.name,details.phone,"secret-token"])assert.equal(logs.join().includes(sensitive),false);
});

test("actual Requests card renders unknown-answer follow-up, question, Open status and optional contact",async()=>{
 const {readFileSync}=await import('node:fs');
 const {transpileModule}=await import('typescript');
 const React=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const source=readFileSync(new URL('../src/components/requests.tsx',import.meta.url),'utf8');
 const card=source.slice(source.indexOf('const kindLabel:'),source.indexOf('function RequestState('));
 const js=transpileModule(card+'\nreturn RequestCard;', {compilerOptions:{target:99,jsx:2}}).outputText;
 const Button=({children,...props})=>React.createElement('button',props,children);
 const Card=new Function('React','useState','useCloseVoiceRequest','cn','AlertCircle','Phone','Check','Button','formatDate','formatTime','toast',js)(
  React,React.useState,()=>({isPending:false}),(...values)=>values.filter(Boolean).join(' '),()=>null,()=>null,()=>null,Button,()=>"date",()=>"time",{success(){}});
 const row={id:'test-request',kind:'message',status:'Open',created_at:'2026-10-05T00:00:00Z',reason:'AI couldn’t answer — follow-up\nCategory: unknown_answer\nQuestion: Holiday opening hours?',phone:'',patient_name:null,caller_name:null};
 const html=renderToStaticMarkup(React.createElement(Card,{row,timeZone:'Asia/Kuwait'}));
 assert.ok(html.includes('<h3 class="font-semibold">AI couldn’t answer — follow-up</h3>'));
 assert.ok(html.includes('Holiday opening hours?'));assert.ok(html.includes('Open'));assert.ok(html.includes('No contact number supplied'));assert.equal(html.includes('href="tel:'),false);
 const withPhone=renderToStaticMarkup(React.createElement(Card,{row:{...row,phone:'+12025550109'}}));assert.ok(withPhone.includes('href="tel:+12025550109"'));
 for(const label of ['Calendar unavailable — follow-up','Booking not confirmed — follow-up']){
  const other=renderToStaticMarkup(React.createElement(Card,{row:{...row,reason:label}}));
  assert.ok(other.includes(label.startsWith('Booking')?'Failed booking — follow-up':label));
 }
});
