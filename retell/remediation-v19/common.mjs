// Pure sandbox helpers. No network, SDK, database, or agent execution.
export function truth(v) { return v === true || v === 'true'; }
export function textValue(v) { return typeof v === 'string' ? v.trim() : ''; }
export function uuid(v) { return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }
export function parseObject(v) { try { const o=typeof v==='string'?JSON.parse(v):v; return o && typeof o==='object'&&!Array.isArray(o)?o:{}; } catch { return {}; } }
export function parseArray(v) { try { const a=typeof v==='string'?JSON.parse(v):v; return Array.isArray(a)?a:[]; } catch { return []; } }
export function phoneValid(v) { return typeof v==='string' && (/^[0-9]{8}$/.test(v.replace(/\D/g,'')) || /^965[0-9]{8}$/.test(v.replace(/\D/g,''))); }
export function decodeToken(raw) {
  const parts=String(raw||'').split('.'); if(parts.length!==2||!parts[1])throw Error('invalid_token');
  const abc='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let bits=0,bucket=0,out='';
  for(const ch of parts[0].replace(/-/g,'+').replace(/_/g,'/')){if(ch==='=')break;const n=abc.indexOf(ch);if(n<0)throw Error('invalid_encoding');bucket=(bucket<<6)|n;bits+=6;if(bits>=8){bits-=8;out+=String.fromCharCode((bucket>>bits)&255);}}
  return JSON.parse(out);
}
export function querySignature(dv) { return JSON.stringify({service:dv.service_name,practitioner_id:dv.practitioner_id,practitioner_name:dv.practitioner_name,practitioner_mode:dv.practitioner_mode,date:dv.requested_date,time:dv.requested_time,window_start:dv.window_start,window_end:dv.window_end,search_mode:dv.search_mode}); }
export function bookingTuple(dv) { return JSON.stringify({cycle:dv.reset_attempt,slot_id:dv.slot_id,client_name:dv.client_name,client_phone:dv.client_phone,service_name:dv.service_name,practitioner_id:dv.practitioner_id,appointment_date:dv.appointment_date,appointment_time:dv.appointment_time}); }
export function chooseReturnedSlot(rows,dv) {
  if(truth(dv.slot_choice_unclear))return null;
  const ordinal=textValue(dv.slot_choice_index),time=textValue(dv.slot_choice_time),date=textValue(dv.slot_choice_date),person=textValue(dv.slot_choice_practitioner).toLowerCase();
  let candidates=rows;
  if(ordinal){const index=Number(ordinal);if(!Number.isInteger(index)||index<1||index>rows.length)return null;candidates=[rows[index-1]];}
  if(time){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return null;candidates=candidates.filter(s=>s.time===time);}
  if(date)candidates=candidates.filter(s=>s.date===date);
  if(person)candidates=candidates.filter(s=>String(s.practitioner_name||'').toLowerCase()===person);
  if(!ordinal&&!time)return null;
  return candidates.length===1?candidates[0]:null;
}
export function validateSlots(dv, existing=false) {
  const rows=parseArray(dv.slots); if(!rows.length)throw Error('no_slots');let check='';const unique=new Set();
  for(const s of rows){const t=decodeToken(s.slot_id);
    if(!uuid(s.practitioner_id)||!textValue(s.service_name)||!/^\d{4}-\d{2}-\d{2}$/.test(s.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)||
      !uuid(t.i)||!uuid(t.q)||t.k!==dv.call_id||t.s!==s.practitioner_id||t.v!==s.service_name||!Number.isFinite(t.e)||t.e<=Date.now()+30000||
      !Number.isFinite(Date.parse(t.t))||unique.has(t.q)||(check&&check!==t.i))throw Error('invalid_or_stale_slot');
    if(existing && (s.practitioner_id!==dv.existing_staff_id||s.service_name!==dv.existing_service))throw Error('unsupported_reschedule_scope');
    if(!existing && (s.service_name!==dv.service_name||(dv.practitioner_mode==='specific'&&s.practitioner_id!==dv.practitioner_id)))throw Error('slot_request_mismatch');
    unique.add(t.q);check=t.i;
  }
  return {rows,check,snapshot:JSON.stringify(rows)};
}
export function selectedTargetValid(dv) {
  const rows=parseArray(dv.existing_lookup_snapshot),target=parseObject(dv.existing_target_snapshot);
  return uuid(dv.existing_selected_id)&&dv.existing_selected_id===target.id&&rows.some(a=>JSON.stringify(a)===JSON.stringify(target))&&
    target.staff_id===dv.existing_staff_id&&target.service===dv.existing_service&&target.start_time===dv.existing_start&&
    Date.parse(target.start_time)>Date.now()&&dv.existing_lookup_cycle===dv.existing_cycle&&
    dv.existing_patient_name===dv.client_name&&dv.existing_patient_phone===dv.client_phone&&phoneValid(dv.client_phone);
}
export function existingTuple(dv) {
  return JSON.stringify({cycle:dv.existing_cycle,action:dv.existing_action,appointment_id:dv.existing_selected_id,
    patient_name:dv.existing_patient_name,patient_phone:dv.existing_patient_phone,original:dv.existing_target_snapshot,
    slot_id:dv.existing_action==='reschedule'?dv.existing_slot_id:'',date:dv.existing_action==='reschedule'?dv.existing_new_date:'',time:dv.existing_action==='reschedule'?dv.existing_new_time:''});
}
