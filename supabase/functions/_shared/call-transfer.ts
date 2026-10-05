import { operationalLog } from "./operational-log.ts";
import { calendarDeadline } from "./calendar-fallback.ts";
import { humanEscalationFollowUp, isHumanCategory } from "./human-escalation.ts";
export const TRANSFER_ATTEMPT = "I’ll try to connect you with the clinic team now.";
export const TRANSFER_UNAVAILABLE = "The clinic team will need to assist you directly. I can pass your request to them for follow-up.";
export const TRANSFER_AFTER_HOURS = "The clinic team is not currently available for transfer. I can pass your request to them for follow-up.";
export const TRANSFER_FAILED_SAVED = "The clinic team could not be reached right now. Your request has been passed to them for follow-up.";
export const TRANSFER_FAILED_UNSAVED = "The clinic team could not be reached right now, and I couldn’t pass your request to them. Please contact the clinic directly.";
const FAILURE_REASON = "Clinic team could not be reached for a requested live transfer.";
const failures = new Set(["no_answer", "busy", "timeout", "provider_error"]);
export function transferCategory(reason: unknown) {
  return reason === "dial_busy" ? "busy" : reason === "dial_no_answer" ? "no_answer"
    : reason === "transfer_timeout" ? "timeout" : "provider_error";
}
export function configuredDestination(value: unknown): string | null {
  if (typeof value !== "string" || !/^\+[0-9 ().-]+$/.test(value)) return null;
  const cleaned = value.replace(/[ ().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null;
}
export function withinTransferHours(hours: unknown, timezone: unknown, now = new Date()) {
  try {
    if (typeof timezone !== "string" || !hours || typeof hours !== "object" || !("days" in hours) || !Array.isArray(hours.days) || hours.days.length !== 7) return false;
    const seen = new Set<number>();
    for (const day of hours.days) {
      if (!Number.isInteger(day?.day) || day.day < 0 || day.day > 6 || seen.has(day.day) || !Array.isArray(day.periods) || day.periods.length > 4) return false;
      seen.add(day.day); let end = "";
      for (const period of [...day.periods].sort((a,b) => String(a?.start).localeCompare(String(b?.start)))) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(period?.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(period?.end) || period.start >= period.end || period.start < end) return false;
        end = period.end;
      }
    }
    const parts = new Intl.DateTimeFormat("en-US", {timeZone: timezone, weekday: "short", hour:"2-digit", minute:"2-digit", hourCycle:"h23"}).formatToParts(now);
    const part = (key: string) => parts.find(p => p.type === key)?.value ?? "";
    const day = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(part("weekday"));
    const time = `${part("hour")}:${part("minute")}`;
    return hours.days.find(d => d.day === day)?.periods.some((p: {start:string;end:string}) => p.start <= time && time < p.end) === true;
  } catch { return false; }
}
export function transferLog(clinicId: string, callId: string, attempted: boolean, result: string, saved: boolean) {
  operationalLog(["success", "pending"].includes(result) ? "transfer_state" : "transfer_failed", "clinic-operations", {clinic_id:clinicId,call_id:callId,state:["success", "pending"].includes(result) ? "success" : "failure",transfer_attempted:attempted,transfer_result:result,fallback_escalation_saved:saved});
}
export function transferBlocked(result = "provider_error", fallback = true) {
  return {success:false,transfer_allowed:false,transfer_destination:null,transfer_result:result,
    fallback_required:fallback,message:result === "after_hours" ? TRANSFER_AFTER_HOURS : TRANSFER_UNAVAILABLE};
}
type Context = {clinicId:string;callId:string};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function state(db:any, c:Context) {
  const r = await calendarDeadline(signal => db.from("voice_call_state").select("transfer_attempt_reserved,transfer_result,transfer_category,transfer_fallback_saved")
    .eq("clinic_id",c.clinicId).eq("call_id",c.callId).maybeSingle().abortSignal(signal),1500) as {data:any;error:unknown};
  if(r.error) throw new Error(); return r.data;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function record(db:any,c:Context,result:string,attempted:boolean,saved=false) {
  const r = await calendarDeadline(signal => db.rpc("voice_record_transfer",{p_clinic_id:c.clinicId,p_call_id:c.callId,p_result:result,p_attempted:attempted,p_fallback_saved:saved}).abortSignal(signal),1500) as {data:any;error:unknown};
  if(r.error) throw new Error();return r.data;
}
// Only trusted clinic config supplies the destination. No caller destination is accepted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function transferGate(db:any,c:Context & {category:string;explicitHuman:boolean;liveAppropriate:boolean;callType:string;inboundNumber:string},now=new Date()) {
  if(!isHumanCategory(c.category) || !(c.explicitHuman || c.liveAppropriate)) return transferBlocked("not_requested",false);
  let result="provider_error";
  try {
    const prior=await state(db,c);
    if(prior?.transfer_attempt_reserved) return transferBlocked(prior.transfer_result === "success" ? "success" : failures.has(prior.transfer_result) ? "previous_failure" : "already_attempted",failures.has(prior.transfer_result));
    const settings=await calendarDeadline(signal=>db.from("clinics").select("fallback_phone,opening_hours,timezone,live_transfer_enabled").eq("id",c.clinicId).single().abortSignal(signal),1500) as {data:any;error:unknown};
    if(settings.error||!settings.data)throw new Error();
    const clinic=settings.data,destination=configuredDestination(clinic.fallback_phone);
    if(!destination)result="no_destination";
    else if(!withinTransferHours(clinic.opening_hours,clinic.timezone,now))result="after_hours";
    else if(clinic.live_transfer_enabled !== true || c.callType !== "phone_call" || destination===configuredDestination(c.inboundNumber))result="provider_error";
    else {
      const claim=await calendarDeadline(signal=>db.rpc("voice_claim_transfer",{p_clinic_id:c.clinicId,p_call_id:c.callId,p_category:c.category,p_destination:destination}).abortSignal(signal),1500) as {data:unknown;error:unknown};
      if(!claim.error && claim.data===true)return {success:true,transfer_allowed:true,transfer_destination:destination,transfer_result:"ready",fallback_required:false,message:TRANSFER_ATTEMPT};
      const concurrent=await state(db,c);
      if(concurrent?.transfer_attempt_reserved)return transferBlocked(concurrent.transfer_result==="success" ? "success" : failures.has(concurrent.transfer_result) ? "previous_failure" : "already_attempted",failures.has(concurrent.transfer_result));
    }
    await record(db,c,result,false);
  }catch{ /* Fail closed; never log raw configuration or provider errors. */ }
  transferLog(c.clinicId,c.callId,false,result,false);
  return transferBlocked(result);
}
// Reuse existing human retention, with one canonical reason for event/flow retry dedupe.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function transferFallback(db:any,c:Context & {name:string;phone:string},ms=2000) {
  let prior;
  try {prior=await state(db,c);}catch{transferLog(c.clinicId,c.callId,false,"provider_error",false);return {follow_up_saved:false,message:TRANSFER_FAILED_UNSAVED};}
  if(prior?.transfer_result==="success")return {success:true,follow_up_saved:false,transfer_result:"success",message:""};
  if(!prior?.transfer_attempt_reserved)return {follow_up_saved:false,message:TRANSFER_FAILED_UNSAVED};
  const result=failures.has(prior.transfer_result) ? prior.transfer_result : "provider_error";
  try {const recorded=failures.has(prior.transfer_result) ? null : await record(db,c,result,true);if(recorded?.result==="success")return {success:true,follow_up_saved:false,transfer_result:"success",message:""};}catch{ /* Persistence still uses existing Human Escalation. */ }
  const saved=await humanEscalationFollowUp(db,{...c,requested:true,category:isHumanCategory(prior.transfer_category) ? prior.transfer_category : "explicit_human_request",reason:FAILURE_REASON},ms);
  try {await record(db,c,result,true,saved.follow_up_saved);}catch{ /* The confirmed request result remains authoritative. */ }
  transferLog(c.clinicId,c.callId,true,result,saved.follow_up_saved);
  return {...saved,transfer_result:result,message:saved.follow_up_saved ? TRANSFER_FAILED_SAVED : TRANSFER_FAILED_UNSAVED};
}
// Observe an existing Human Escalation save after a blocked gate; never save twice.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function observeTransferFallback(db:any,c:Context,saved:boolean) {
  try {const s=await state(db,c);if(!s?.transfer_result||s.transfer_result==="success")return;
    await record(db,c,s.transfer_result,s.transfer_attempt_reserved===true,saved);
    transferLog(c.clinicId,c.callId,s.transfer_attempt_reserved===true,s.transfer_result,saved);
  }catch{ /* Operational metadata cannot change the existing escalation response. */ }
}
// Called only by the existing signed webhook, never from an LLM-supplied success argument.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function transferEvent(db:any,c:Context & {name:string;phone:string},event:string,reason:unknown) {
  const result=event==="transfer_bridged" ? "success" : event==="transfer_started" ? "started" : transferCategory(reason);
  const recorded=await record(db,c,result,true);
  if(!recorded?.accepted)return;
  if(event==="transfer_cancelled") {await transferFallback(db,c);return;}
  transferLog(c.clinicId,c.callId,true,result==="started"?"pending":result,false);
}
