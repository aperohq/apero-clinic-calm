import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { runProviderBatch } from "./core.mjs";

export default {fetch: withSupabase({auth:"secret",cors:"disabled"}, async (req,ctx) => {
  const runId=crypto.randomUUID();
  const headers={"cache-control":"no-store","x-content-type-options":"nosniff"};
  if(req.method!=="POST") return new Response(null,{status:405,headers});
  try {
    const reader=req.body?.getReader();let body="";let size=0;
    if(reader){const decoder=new TextDecoder();try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
    if(size>1024){await reader.cancel();return new Response(null,{status:413,headers});}body+=decoder.decode(next.value,{stream:true});}body+=decoder.decode();}finally{reader.releaseLock();}}
    const input=JSON.parse(body);
    if(!input || Object.keys(input).length!==1 || typeof input.clinicId!=="string" || !/^[0-9a-f-]{36}$/i.test(input.clinicId)) return new Response(null,{status:400,headers});
    const counts=await runProviderBatch(ctx.supabaseAdmin,(name:string)=>Deno.env.get(name),input.clinicId);
    console.info(JSON.stringify({run_id:runId,timestamp:new Date().toISOString(),category:"retention_provider",clinic_id:input.clinicId,...counts,state:counts.failed?"failure":"success"}));
    return Response.json({run_id:runId,...counts},{headers});
  } catch {
    console.error(JSON.stringify({run_id:runId,timestamp:new Date().toISOString(),category:"retention_provider",state:"failure",failure_category:"database_error"}));
    return Response.json({run_id:runId,state:"failure"},{status:503,headers});
  }
})};
