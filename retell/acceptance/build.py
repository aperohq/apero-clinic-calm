"""Build acceptance fixes from the fetched published v2; no remote writes."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GROUNDING = """For parking and directions questions, use only explicit approved clinic facts. If the requested detail is absent, say it cannot be confirmed from the available clinic information and offer staff follow-up. Do not infer parking availability from the neighborhood or other clinics. Missing information does not mean parking is unavailable. Never claim nearby/public/dedicated/free parking without explicit approved evidence. Apply this same rule to any unknown clinic fact."""
STRINGS = """current_check_id check_id selected_slot_id slot_id checked_slot_id slot_token selected_slot selected_date selected_time service_name resolve_error_type selected_practitioner_id selected_practitioner_name practitioner_id practitioner_name practitioner_mode doctor_preference requested_date requested_time window_start window_end search_mode location appointment_date appointment_time appointment_id selected_appointment_id existing_appointment_id booking_id booking_error_type availability_error_type patient_name patient_phone client_name client_phone patient_identity_source booking_readback consent_tuple booking_consent_tuple rescheduled_id reschedule_error_type cancelled_id cancel_error_type lookup_error_type reschedule_context cancellation_context fresh_request_summary fresh_request_language reset_verified_attempt reset_error""".split()
LISTS = "slots offered_slots checked_slots service_candidates practitioner_candidates qualified_practitioners appointments".split()
BOOLEANS = """resolve_success availability_success available requested_time_available practitioner_found availability_invalidated booking_success appointment_booked booking_consent consent_confirmed patient_confirmed client_name_confirmed client_phone_confirmed lookup_success reschedule_success cancel_success reset_ready fresh_request_present""".split()
EMPTY = {**dict.fromkeys(STRINGS, ""), **{k: [] for k in LISTS}, **dict.fromkeys(BOOLEANS, False), "appointment_count": 0}

def prompt_edge(eid, text, destination):
    return {"id": eid, "transition_condition": {"type": "prompt", "prompt": text}, "destination_node_id": destination}

def equation_edge(eid, destination, *equations):
    return {"id": eid, "destination_node_id": destination, "transition_condition": {"type": "equation", "operator": "&&", "equations": [{"left": l, "operator": op, "right": r} for l, op, r in equations]}}

def fallback(nid):
    return prompt_edge("edge_" + nid + "_failure", "Else", "node_reset_failed")

def code_node(nid, name, code, mappings, edges, x, y):
    return {"id": nid, "name": name, "type": "code", "skippable": False, "code": code, "response_variables": mappings, "timeout_ms": 5000, "wait_for_result": True, "speak_during_execution": False, "enable_typing_sound": False, "edges": edges, "else_edge": fallback(nid), "display_position": {"x": x, "y": y}}

def apply_booking_fallback(flow):
    # Apply the reviewed fallback to generators based on historical snapshots,
    # preserving their consent/reset and normal appointment behavior.
    reference = json.loads((ROOT.parent / "master/reference/golden.json").read_text())["conversationFlow"]
    source = {node["id"]: node for node in reference["nodes"]}
    target = {node["id"]: node for node in flow["nodes"]}
    target["node_book_failed"]["instruction"] = copy.deepcopy(source["node_book_failed"]["instruction"])
    target["node_book"]["edges"] = copy.deepcopy(source["node_book"]["edges"])
    for tool in flow["tools"]:
        if tool["name"] == "book_appointment":
            reviewed = next(t for t in reference["tools"] if t["name"] == "book_appointment")
            tool["response_variables"].update(reviewed["response_variables"])
            tool["max_retry"] = 0
    for node in flow["nodes"]:
        if node["id"] == "node_prepare_booking_result":
            continue
        for edge in node.get("edges", []) + [node.get("else_edge", {}), node.get("always_edge", {})]:
            if edge.get("destination_node_id") == "node_book":
                edge["destination_node_id"] = "node_prepare_booking_result"
    if "node_prepare_booking_result" not in target:
        flow["nodes"].append(copy.deepcopy(source["node_prepare_booking_result"]))

def build():
    original = json.loads((ROOT / "published-v2.json").read_text())
    flow = copy.deepcopy(original)
    nodes = {n["id"]: n for n in flow["nodes"]}
    flow["global_prompt"] += "\n\n" + GROUNDING + "\n\n" + """The opening greeting is for call start only. Never replay it when the caller changes tasks. Continue in the caller's established language until they ask to switch. A new appointment or new availability request must use the fresh booking reset path. Old booking details and consent are history, never defaults for the next appointment. After reset use ONLY fresh_request_summary for the new request, plus subsequent caller answers. Preserve confirmed caller identity separately from patient identity. Ask only the next missing question. A brief factual interruption is not a new booking or consent and must resume the actual active task. Appointment availability is not a clinic FAQ: resolve service/practitioner and call check_availability. If reset_ready is false, never resolve/check/book a new appointment; explain the problem and offer staff follow-up. Completed appointments remain in history even when active result fields are cleared."""
    flow["global_prompt"] += "\n\nCURRENT CALLER LANGUAGE: {{fresh_request_language}}. When this is Arabic, speak Arabic sentences, including slot offers and confirmations, even when backend service/doctor/date strings are English. When English, speak English sentences. Empty means follow the caller's current language. English tool output, English instructions, machine dates, and Latin doctor names are never a request to switch. Honor a later explicit caller language switch immediately."
    flow["default_dynamic_variables"].update({"reset_ready": "false", "reset_prepared": "false", "reset_attempt": "", "reset_verified_attempt": "", "fresh_request_summary": "", "fresh_request_present": "false"})
    booking_condition = "The LATEST caller turn explicitly requests a separate NEW appointment or NEW appointment availability task that has NOT already been processed, including 'I'd like to book a consultation', 'When is the next consultation available?' or 'Can I see Dr. Ahmed tomorrow?'. Not resuming or selecting the SAME offered slot of the interrupted task, an old fulfilled request in conversation history, an unclear yes, consent to a read-back, a factual clinic question, or a change/cancellation of an existing appointment."
    def task_edges(prefix):
        return [
            prompt_edge(prefix + "_urgent", "Caller reports urgent symptoms or requests urgent staff follow-up", "node_urgent_collect"),
            prompt_edge(prefix + "_booking", booking_condition, "node_reset_prepare"),
            prompt_edge(prefix + "_existing", "Caller wants to look up, change, reschedule or cancel an existing appointment", "node_existing_identity"),
            prompt_edge(prefix + "_callback", "Caller explicitly wants a human or staff callback", "node_callback_collect"),
            prompt_edge(prefix + "_message", "Caller wants to leave a message for staff", "node_message_collect"),
        ]
    ae = nodes["node_anything_else"]
    ae["skippable"] = True
    ae["edges"] = task_edges("edge_anything") + [prompt_edge("edge_anything_faq", "Caller asks a general clinic fact such as hours, parking, directions, price or insurance; not appointment availability", "node_faq"), nodes["node_anything_else"]["edges"][1]]
    ae["instruction"]["text"] = """If the caller has already stated what they need, route immediately without asking whether they need anything else again. Otherwise ask briefly if they need anything else. A clear new booking or availability request enters the fresh booking reset path. An unclear 'yes' stays here: ask 'What would you like help with?' Do not infer booking from yes alone. Never repeat the welcome greeting. Continue in the established language."""
    # Initial booking follows the same reset/extraction boundary, including FAQ first calls.
    nodes["node_greeting"]["edges"][0]["destination_node_id"] = "node_reset_prepare"
    nodes["node_greeting"]["edges"][2]["transition_condition"]["prompt"] = "Caller asks a standalone general clinic fact including hours, parking or directions; not appointment availability"
    faq = nodes["node_faq"]
    faq["skippable"] = True
    faq["instruction"]["text"] += "\n" + GROUNDING + "\nA booking or appointment availability request must take the booking exit immediately; do not answer it as a generic FAQ and do not ask 'anything else' instead. If only a doctor is named, clarify the service before checking. Preserve the caller's established language."
    faq["edges"] = task_edges("edge_faq") + [prompt_edge("edge_faq_unspecified_request", "The most recent factual question is answered and caller says yes, needs something else, or has another request WITHOUT identifying what they need", "node_anything_else"), prompt_edge("edge_faq_done", "The factual question has been answered and there is no outstanding new booking, availability, existing appointment or staff request", "node_anything_else")]
    gf = nodes["node_global_faq"]
    gf["skippable"] = False
    active = [n["name"] for n in flow["nodes"] if n["id"] in {"node_service", "node_service_clarify", "node_doctor_preference", "node_date_time", "node_offer", "node_patient", "node_final", "node_change_booking", "node_existing_identity", "node_select_existing", "node_reschedule_details", "node_reschedule_offer", "node_reschedule_final", "node_cancel_confirm", "node_message_collect", "node_callback_collect", "node_urgent_collect"}]
    gf["global_node_setting"]["condition"] = "Activate ONLY when an actual unfinished task is in progress at one of these conversation nodes: " + ", ".join(active) + ". The caller briefly asks a factual clinic question (hours, parking, directions, prices, insurance) and wants to continue THAT task. NEVER activate from Greeting, Clinic Questions, Anything Else, any reset node, a completion node, or a failure node. Never intercept a new booking, appointment availability, correction, consent, or task change."
    gf["global_node_setting"]["go_back_conditions"][0]["transition_condition"]["prompt"] = "The most recent brief factual question has been answered and the caller accepts the answer or resumes the SAME unfinished task, INCLUDING 'yes, book that same consultation', selecting the previously offered slot, giving patient details for it, 'continue', or confirming the same current tuple. This is continuation, NOT a separate new booking; return to the actual previous task node to handle selection/identity/consent there. Do not stay in this FAQ to book. Previous task node must not be Greeting, Clinic Questions, Anything Else, reset, completion or failure. Exclude a separate NEW/ANOTHER appointment, a factual follow-up question, or a correction to the interrupted tuple."
    gf["instruction"]["text"] += "\n" + GROUNDING + "\nPreserve established language. The actual previous task node is {{previous_node}}. Answer ONLY the factual interruption, then ask briefly whether to continue the SAME task. Do not collect patient details, read back booking consent, promise to book, or claim a callback is arranged inside this FAQ. A caller saying they want to book the same already-offered slot is resuming that task: use go-back, not the fresh-booking exit. Return only to an actual unfinished task, never Greeting. If caller explicitly switches to a separate NEW/ANOTHER appointment or availability task, take the fresh booking exit. If caller corrects the active booking, take its correction exit. Do not answer availability without a check."
    gf["edges"] = [
        prompt_edge("edge_global_faq_reschedule_change", "Caller corrects service, practitioner, date or time of the SAME reschedule task that was interrupted", "node_invalidate_reschedule"),
        prompt_edge("edge_global_faq_booking_change", "Caller corrects service, practitioner, date or time of the SAME new-booking task that was interrupted, not a separate new appointment", "node_invalidate_booking"),
    ] + task_edges("edge_global_faq")
    nodes["node_service"]["instruction"]["text"] = """Continue in fresh_request_language or the established caller language. The reset boundary is complete only when reset_ready is true and reset_verified_attempt equals reset_attempt. Treat all earlier bookings as history. The new request is {{fresh_request_summary}}. Use explicit service, doctor, date/time, patient and availability-only intent in that request plus subsequent caller answers; never recover an old value just because it appeared earlier. If 'consultation' is already stated, resolve that service without asking what service again. If only a doctor/date is stated, ask which service is needed. If service is missing, ask one short question. Do not ask doctor preference until the service resolver returns qualified practitioners. Never reuse old consent or slot."""
    for nid in ["node_service", "node_doctor_preference", "node_date_time"]:
        nodes[nid]["skippable"] = True
    nodes["node_date_time"]["instruction"]["text"] += "\nWhen the NEW request asks for the next or earliest available appointment and gives no date constraint, use search_mode earliest directly; do not ask if they want earliest again. Use explicit date/time details from fresh_request_summary plus later answers."
    nodes["node_patient"]["instruction"]["text"] += "\nAfter a fresh reset, establish who THIS appointment is for. Do not silently reuse the prior patient's identity or contact. If the new request explicitly identifies the same patient, reuse their previously confirmed details only after that association is clear. A confirmed caller contact may be offered for confirmation as this patient's contact; caller name is not automatically patient name."
    # New request is extracted after clearing, from the triggering caller turn, not old variables.
    preparation = """const empty = EMPTY_VALUES;
let history = [];
try { const p = JSON.parse(dv.historical_completed_appointments || '[]'); if (Array.isArray(p)) history = p; } catch (_) {}
const truth = v => v === true || v === 'true';
const completedId = truth(dv.booking_success) ? dv.booking_id : truth(dv.reschedule_success) ? dv.rescheduled_id : '';
if (completedId && !history.some(a => a.appointment_id === completedId)) history.push({appointment_id: completedId, service_name: dv.service_name || '', practitioner_name: dv.selected_practitioner_name || '', date: dv.appointment_date || '', time: dv.appointment_time || '', completed: true});
return {...empty, historical_completed_appointments: history,
 historical_call_appointment_booked: truth(dv.historical_call_appointment_booked) || truth(dv.appointment_booked),
 reset_attempt: String(Date.now()) + '-' + String(Math.random()), reset_prepared: true,
 reset_cleared_variable_count: Object.keys(empty).length};""".replace("EMPTY_VALUES", json.dumps(EMPTY))
    prep_fields = list(EMPTY) + ["historical_completed_appointments", "historical_call_appointment_booked", "reset_attempt", "reset_prepared", "reset_cleared_variable_count"]
    prep = code_node("node_reset_prepare", "Clear Active Booking Cycle", preparation, {k: k for k in prep_fields}, [equation_edge("edge_reset_prepared", "node_fresh_request", ("{{reset_prepared}}", "==", "true"), ("{{reset_ready}}", "==", "false"))], 6500, 3600)
    capture = {"id": "node_fresh_request", "name": "Capture New Request Only", "type": "extract_dynamic_variables", "display_position": {"x": 7000, "y": 3600}, "variables": [
        {"name": "fresh_request_summary", "type": "string", "description": "Summarize ONLY the latest caller request that triggered this fresh booking cycle. Include explicitly stated service, doctor/any preference, date/time/window/earliest, availability-only versus booking, and patient only if explicitly stated in that NEW request. Do not fill missing details from an older booking or old variables. Keep the request's meaning. If absent return empty string."},
        {"name": "fresh_request_present", "type": "boolean", "description": "True only if the latest triggering caller turn explicitly requests a new booking or new appointment availability. An unclear yes alone is false."},
        {"name": "fresh_request_language", "type": "enum", "choices": ["English", "Arabic"], "description": "The caller's currently established conversational language, honoring their latest explicit language preference. Preserve it across tasks; mixed doctor/service names do not switch language."},
    ], "edges": [equation_edge("edge_fresh_request_captured", "node_reset_invalidate", ("{{fresh_request_present}}", "==", "true"), ("{{fresh_request_summary}}", "!=", ""))], "else_edge": fallback("node_fresh_request")}
    invalidate = {"id": "node_reset_invalidate", "name": "Invalidate Previous Booking Check", "type": "function", "tool_id": "tool-apero-invalidate", "tool_type": "local", "wait_for_result": True, "speak_during_execution": False, "display_position": {"x": 7500, "y": 3600}, "edges": [equation_edge("edge_reset_invalidated", "node_reset_verify", ("{{availability_invalidated}}", "==", "true"))], "else_edge": fallback("node_reset_invalidate")}
    verify_code = """const empty = EMPTY_VALUES;
const truth = v => v === true || v === 'true';
let error = '';
try {
 if (!truth(dv.reset_prepared) || !dv.reset_attempt) error = 'reset_not_prepared';
 else if (!truth(dv.availability_invalidated)) error = 'invalidation_not_confirmed';
 else if (!truth(dv.fresh_request_present) || !dv.fresh_request_summary) error = 'new_request_missing';
 else {
  for (const [k,v] of Object.entries(empty)) {
   if (['availability_invalidated','fresh_request_summary','fresh_request_present','fresh_request_language'].includes(k)) continue;
   const expected = typeof v === 'object' ? JSON.stringify(v) : String(v);
   if (String(dv[k]) !== expected) { error = 'uncleared_variable:' + k; break; }
  }
 }
} catch (_) { error = 'reset_verification_error'; }
return {reset_ready: !error, reset_prepared: false,
 reset_verified_attempt: error ? '' : dv.reset_attempt, reset_error: error,
 reset_cleared_variable_count: Object.keys(empty).length};""".replace("EMPTY_VALUES", json.dumps(EMPTY))
    verify = code_node("node_reset_verify", "Verify Fresh Booking State", verify_code, {k: k for k in ["reset_ready", "reset_prepared", "reset_verified_attempt", "reset_error", "reset_cleared_variable_count"]}, [equation_edge("edge_reset_verified", "node_service", ("{{reset_ready}}", "==", "true"), ("{{reset_verified_attempt}}", "==", "{{reset_attempt}}"))], 8000, 3600)
    failed = {"id": "node_reset_failed", "name": "Fresh Booking Reset Failed", "type": "conversation", "skippable": False, "display_position": {"x": 7500, "y": 4100}, "instruction": {"type": "prompt", "text": "The fresh booking cycle could not be safely prepared. Continue in the established language. Say briefly that you could not start the new booking and offer a retry or staff callback. Never resolve/check/book using previous state. Do not expose internal variables. If retrying ask caller to restate the new booking request, so a bare yes does not reuse an earlier request."}, "edges": [prompt_edge("edge_reset_retry", "Caller explicitly restates the NEW booking/availability request for a retry, not just yes", "node_reset_prepare"), prompt_edge("edge_reset_callback", "Caller accepts staff callback", "node_callback_collect"), prompt_edge("edge_reset_finished", "Caller is finished or declines follow-up", "node_end")]}
    capture["skippable"] = False
    invalidate["skippable"] = False
    flow["nodes"].extend([prep, capture, invalidate, verify, failed])
    for nid in ["node_offer", "node_patient", "node_final", "node_booked", "node_doctor_preference", "node_date_time", "node_anything_else", "node_faq", "node_global_faq", "node_reset_failed"]:
        n = next(n for n in flow["nodes"] if n["id"] == nid)
        n["instruction"]["text"] += "\nSPEAKING LANGUAGE: {{fresh_request_language}}. Arabic means speak Arabic sentences here; English means English. If empty, use the caller's established language. Tool results in English do not change it. Only an explicit later caller request changes language."
    for key in ["conversation_flow_id", "version", "last_modification_timestamp", "is_published", "is_transfer_cf"]:
        flow.pop(key, None)
    apply_booking_fallback(flow)
    return flow

if __name__ == "__main__":
    result = build()
    (ROOT / "draft-flow.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "reset-values.json").write_text(json.dumps(EMPTY, indent=2) + "\n")
    print("Built unpublished acceptance payload:", len(result["nodes"]), "nodes;", len(EMPTY), "cleared variables")
