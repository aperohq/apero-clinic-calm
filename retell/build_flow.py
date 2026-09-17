"""Generate a clinic flow from common Apero behavior and clinic configuration.

Usage: python3 retell/build_flow.py --config retell/config/dental-zone.json --output /tmp/flow.json
No external resources are created or published.
"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--config", default="retell/config/dental-zone.json")
parser.add_argument("--source", default="retell/dental-zone-flow.json", help="Saved flow used for model defaults")
parser.add_argument("--output", default="retell/dental-zone-flow.json")
args = parser.parse_args()
config = json.loads(Path(args.config).read_text())
required = ("clinic_id", "clinic_name", "clinic_name_ar", "clinic_address", "clinic_phone", "clinic_hours", "timezone", "languages", "clinic_type", "knowledge_base_id", "tool_url")
missing = [key for key in required if not config.get(key)]
if missing: parser.error("Missing clinic config: " + ", ".join(missing))
old = json.loads(Path(args.source).read_text())
URL = config["tool_url"]

def prompt(text): return {"type": "prompt", "prompt": text}
def equation(*parts):
    return {"type": "equation", "operator": "&&", "equations": [
        {"left": "{{" + name + "}}", "operator": op, **({"right": str(right)} if right is not None else {})}
        for name, op, right in parts]}
def edge(target, condition, tag): return {"id": f"edge_{tag}", "destination_node_id": target, "transition_condition": condition}
def convo(id, name, instruction, edges=None, else_to=None, global_condition=None, always_to=None, static=False):
    node = {"id": id, "name": name, "type": "conversation", "skippable": False,
            "display_position": {"x": 0, "y": 0}, "instruction": {"type": "static_text" if static else "prompt", "text": instruction}, "edges": edges or []}
    if else_to: node["else_edge"] = edge(else_to, prompt("Else"), id + "_else")
    if always_to: node["always_edge"] = edge(always_to, prompt("Always"), id + "_always")
    if global_condition: node["global_node_setting"] = {"condition": global_condition, "cool_down": 3,
        "go_back_conditions": [{"id": id + "_go_back", "transition_condition": prompt("The brief general question has been answered and the caller wants to resume the previous request")}]} if id == "node_global_faq" else {"condition": global_condition, "cool_down": 3}
    return node
def fn(id, name, tool_id, edges=None, else_to=None, always_to=None):
    node = {"id": id, "name": name, "type": "function", "skippable": False,
            "display_position": {"x": 0, "y": 0}, "tool_id": tool_id, "tool_type": "local",
            "wait_for_result": True, "speak_during_execution": False, "edges": edges or []}
    if else_to: node["else_edge"] = edge(else_to, prompt("Else"), id + "_else")
    if always_to: node["always_edge"] = edge(always_to, prompt("Always"), id + "_always")
    return node
def tool(name, action, fields, required, response, description, tool_id):
    properties = {"action": {"type": "string", "enum": [action], "description": f"Always {action}."}}
    properties.update(fields)
    return {"type": "custom", "tool_id": tool_id, "name": name, "url": URL, "method": "POST",
            "headers": {}, "query_params": {}, "description": description,
            "parameters": {"type": "object", "properties": properties, "required": ["action", *required]},
            "response_variables": response, "args_at_root": False, "parameter_type": "json",
            "timeout_ms": 20000, "max_retry": 0, "speak_during_execution": True,
            "execution_message_type": "static_text", "execution_message_description": "One moment, let me check that for you.",
            "speak_after_execution": True}
S = lambda description: {"type": "string", "description": description}

tools = [
 tool("resolve_service", "resolve", {"service_name": S("Patient's requested service, in their own words.")}, ["service_name"],
      {"resolve_success":"success","resolve_error_type":"error_type","service_name":"service_name","qualified_practitioners":"qualified_practitioners","service_candidates":"service_candidates"},
      "Resolve the service against current staff assignments before asking doctor preference.", "tool-apero-resolve"),
 tool("check_availability", "availability", {"service_name":S("Final requested service."),"practitioner_name":S("Requested name; omit for any qualified practitioner."),
      "practitioner_id":S("Canonical staff ID when known; omit for any qualified practitioner."),
      "practitioner_mode":{"type":"string","enum":["specific","any"],"description":"Specific only when caller prefers a named practitioner; any only when they accept any qualified practitioner. Never silently switch."},
      "requested_date":S("YYYY-MM-DD in the clinic time zone."),
      "requested_time":S("Optional exact time, HH:mm."),"window_start":S("Optional earliest accepted time, HH:mm."),"window_end":S("Optional latest accepted time, HH:mm."),
      "appointment_id":S("Only for a verified reschedule: exact existing appointment ID from lookup."),
      "client_name":S("Required with appointment_id: verified existing patient's name."),
      "client_phone":S("Required with appointment_id: verified existing patient's phone."),
      "search_mode":{"type":"string","enum":["date","earliest"],"description":"Use earliest for earliest-available requests; date otherwise."}},
      ["service_name","practitioner_mode","search_mode"],
      {"availability_success":"success","available":"available","slots":"slots","availability_error_type":"error_type",
       "requested_time_available":"requested_time_available","practitioner_found":"practitioner_found","qualified_practitioners":"qualified_practitioners","service_name":"service_name",
       "selected_practitioner_id":"selected_practitioner_id","selected_practitioner_name":"selected_practitioner_name"},
      "Check real, service-qualified slots. Never offer a time absent from the returned slots array.", "tool-1789478621144"),
 tool("book_appointment", "book", {"slot_id":S("Exact opaque slot_id from the latest availability result."),"client_name":S("Patient's final full name, not caller name if different."),
      "client_phone":S("Confirmed contact number for the patient, often guardian's number for a child."),"caller_name":S("Caller name if different from patient."),
      "caller_phone":S("Caller's number if different from patient contact."),"service_name":S("Exact canonical service_name from selected slot."),
      "practitioner_id":S("Exact canonical practitioner_id from selected slot."),"appointment_date":S("Exact selected slot date, YYYY-MM-DD."),
      "appointment_time":S("Exact selected slot time, HH:mm.")},
      ["slot_id","client_name","client_phone","service_name","practitioner_id","appointment_date","appointment_time"],
      {"booking_success":"success","appointment_booked":"appointment_booked","booking_id":"appointment_id","booking_error_type":"error_type"},
      "Book only after an explicit final read-back confirmation of this exact patient, service, practitioner, date and time.", "tool-1789479554809"),
 tool("lookup_appointments", "lookup", {"client_name":S("Verified patient's full name."),"client_phone":S("Verified patient contact number.")},
      ["client_name","client_phone"], {"lookup_success":"success","appointments":"appointments","appointment_count":"count","lookup_error_type":"error_type"},
      "Look up this patient's future appointments before rescheduling or cancellation.", "tool-apero-lookup"),
 tool("reschedule_appointment", "reschedule", {"appointment_id":S("Exact existing appointment ID from lookup."),"slot_id":S("Selected fresh checked slot ID."),
      "client_name":S("Verified patient name."),"client_phone":S("Verified patient contact."),"service_name":S("Canonical service in selected slot."),
      "practitioner_id":S("Canonical staff ID in selected slot."),"appointment_date":S("Selected date YYYY-MM-DD."),"appointment_time":S("Selected time HH:mm.")},
      ["appointment_id","slot_id","client_name","client_phone","service_name","practitioner_id","appointment_date","appointment_time"],
      {"reschedule_success":"success","rescheduled_id":"appointment_id","reschedule_error_type":"error_type"},
      "Atomically update the selected existing appointment after explicit final confirmation. Never create a new booking.", "tool-apero-reschedule"),
 tool("cancel_appointment", "cancel", {"appointment_id":S("Exact appointment ID from lookup."),"client_name":S("Verified patient name."),
      "client_phone":S("Verified patient contact."),"confirmed":{"type":"boolean","enum":[True],"description":"True only after caller explicitly confirms cancellation of the selected appointment."}},
      ["appointment_id","client_name","client_phone","confirmed"],
      {"cancel_success":"success","cancelled_id":"appointment_id","cancel_error_type":"error_type"},
      "Cancel only the verified selected appointment after explicit confirmation.", "tool-apero-cancel"),
 tool("invalidate_availability", "invalidate", {}, [], {"availability_invalidated":"availability_invalidated"},
      "Clear the previous checked slot immediately when any booking parameter changes or a booking completes.", "tool-apero-invalidate"),
]
for kind in ("message","callback","urgent"):
    tools.append(tool("persist_"+kind,kind,{"caller_name":S("Caller name."),"patient_name":S("Patient name if different."),
        "caller_phone":S("Confirmed callback number."),"reason":S("Concise request or message for staff.")},["caller_phone","reason"],
        {kind+"_success":"success",kind+"_request_id":"request_id",kind+"_error_type":"error_type"},
        "Persist this request before promising staff follow-up. {transfer_policy}","tool-apero-"+kind))

nodes = [
 convo("node_greeting","Greeting","هلا فيك، معك سارة من {clinic_name_ar}. شلون أقدر أساعدك اليوم؟",[
   edge("node_service",prompt("Caller wants a new appointment or only wants to check new appointment availability"),"greeting_book"),
   edge("node_existing_identity",prompt("Caller wants to change or cancel an existing appointment"),"greeting_existing"),
   edge("node_faq",prompt("Caller asks a general clinic question"),"greeting_faq"),
   edge("node_message_collect",prompt("Caller wants to leave a message"),"greeting_message"),
   edge("node_urgent_collect",prompt("Caller reports urgent symptoms or needs urgent staff attention"),"greeting_urgent"),
   edge("node_callback_collect",prompt("Caller asks for a human receptionist"),"greeting_human")],static=True),
 convo("node_service","Understand Service","If the service is already clear, move straight to resolution without another question. Otherwise ask what visit they need. Do not ask about a doctor until the service resolver returns qualified practitioners.",
   [edge("node_resolve","prompt" if False else prompt("The requested service is clear enough to send to service resolver"),"service_resolve")]),
 fn("node_resolve","Resolve Service","tool-apero-resolve",[edge("node_doctor_preference",equation(("resolve_success","==","true")),"resolve_ok")],"node_service_clarify"),
 convo("node_service_clarify","Clarify Service","The service could not be resolved or is ambiguous. Ask one short clarifying question using only returned service candidates. Do not invent availability.",
   [edge("node_service",prompt("Caller clarifies the service"),"service_clarified")]),
 convo("node_doctor_preference","Doctor Preference","Use the resolved service and qualified_practitioners. If a valid specific doctor or any-qualified preference is already established, do not ask again: continue. If only one practitioner qualifies, use that practitioner and continue without asking. Ask preference only when several qualify and preference is missing, ambiguous, invalid, or the caller changed doctor/service. Keep the canonical practitioner ID once resolved. Never silently switch doctors.",
   [edge("node_date_time",prompt("A specific doctor preference or any-qualified preference is clear; or only one qualified practitioner exists"),"doctor_chosen")]),
 convo("node_date_time","Date and Time Preference","Keep the resolved service, practitioner_mode and canonical practitioner ID from prior states. If date and time preference are already clear, proceed without asking. Otherwise ask only the next missing question. Accept exact time, window, flexible date or earliest. Clarify ambiguous relative dates in the clinic time zone. Do not imply an unchecked time is free.",
   [edge("node_check",prompt("There is enough information to check: canonical service, doctor preference mode, and date or earliest search mode"),"date_check")]),
 fn("node_check","Check Qualified Availability","tool-1789478621144",[
   edge("node_offer",equation(("availability_success","==","true"),("available","==","true")),"availability_yes"),
   edge("node_no_slots",equation(("availability_success","==","true"),("available","==","false")),"availability_no"),
   edge("node_check_error",equation(("availability_success","==","false")),"availability_error")],"node_tool_failure"),
 convo("node_check_error","Availability Validation","The availability result failed. If practitioner_not_found or practitioner_ambiguous, ask for the name again; if service_mismatch, explain that this practitioner does not provide the service and offer qualified alternatives. For invalid or past date, clarify the date. For tool/database errors, say you could not verify availability and offer staff follow-up. Never say the practitioner is merely fully booked for a service mismatch.",
   [edge("node_invalidate_booking",prompt("Caller corrects the request and wants another check"),"check_error_retry"),
    edge("node_callback_collect",prompt("Caller requests staff follow-up"),"check_error_callback")]),
 convo("node_no_slots","No Verified Slots","Say briefly that the requested time is unavailable. Ask ONE next question, usually whether another time or date works. Offer another doctor only if a different practitioner is qualified and the caller agrees. Keep the existing canonical doctor and service unless the caller changes them. Never call it booked.",
   [edge("node_invalidate_booking",prompt("Caller changes doctor, service, date, time or flexibility"),"no_slots_change"),
    edge("node_anything_else",prompt("Caller does not want to continue checking"),"no_slots_end")]),
 convo("node_offer","Offer Verified Slots","Offer only a few actual slots from the latest slots array. Speak the practitioner, date and exact time for each. A date-level available flag alone is not an offered time. Keep the opaque slot_id internal. If caller only asked availability, answer without booking. If caller changes any parameter, go through invalidation before checking again.",
   [edge("node_invalidate_booking",prompt("Caller corrects or changes service, doctor, any-doctor preference, date, time, window or location"),"offer_change"),
    edge("node_patient",prompt("Caller selects one exact returned slot and wants to book it"),"offer_select"),
    edge("node_anything_else",prompt("Caller only wanted availability or declines to book"),"offer_inquiry")]),
 convo("node_patient","Patient and Contact","Ask whether the appointment is for the caller only if unclear. Collect the PATIENT'S full name and a confirmed usable contact number; for a child, use the guardian's confirmed contact but the child's name. Keep caller and patient names separate. Read back uncertain names or digits. Ask one question at a time.",
   [edge("node_final",prompt("Patient name and valid confirmed contact are collected for the selected slot"),"patient_done"),
    edge("node_invalidate_booking",prompt("Caller changes service, doctor, date or time"),"patient_change")]),
 convo("node_final","Final Booking Confirmation","Read back exactly patient, canonical service, practitioner, date and time from the selected latest slot. Ask 'Would you like me to book that?' A yes to another question, silence, maybe or unclear response is not consent. Do not say booked yet.",
   [edge("node_invalidate_booking",prompt("Caller corrects any booking detail or selects another slot"),"final_change"),
    edge("node_book",prompt("Caller clearly affirms booking the exact just-read patient, service, practitioner, date and time"),"final_yes"),
    edge("node_anything_else",prompt("Caller declines booking"),"final_no")]),
 fn("node_book","Book Appointment","tool-1789479554809",[
   edge("node_booked",equation(("booking_success","==","true"),("booking_id","exists",None)),"book_success")],"node_book_failed"),
 convo("node_booked","Booking Confirmed","Only now the backend reported success and an appointment ID. Confirm the patient, service, practitioner, date and time naturally. Do not mention internal systems.",always_to="node_invalidate_after_book"),
 convo("node_book_failed","Booking Not Completed","The booking did not succeed. Say clearly it is NOT booked. For a slot conflict or stale slot, apologize briefly and offer a fresh check. For phone/validation errors, correct the information. For technical failure, offer a durable staff callback. Never use the old slot without a new check.",
   [edge("node_invalidate_booking",prompt("Caller wants fresh availability or corrects details"),"book_failed_retry"),
    edge("node_callback_collect",prompt("Caller wants staff follow-up"),"book_failed_callback")]),
 fn("node_invalidate_booking","Invalidate Changed Booking","tool-apero-invalidate",always_to="node_change_booking"),
 convo("node_change_booking","Collect Correction","The old slot is invalid. Keep all unaffected details, especially canonical service, practitioner ID, practitioner_mode and patient. Acknowledge the correction in one short sentence. Ask only for a missing detail. A date/time-only change keeps the selected doctor and goes straight to a fresh check. Never ask doctor preference again unless it changed or became invalid.",
   [edge("node_resolve",prompt("The SERVICE changed, so resolve the new service and reassess doctor qualification"),"change_service_resolve"),
    edge("node_doctor_preference",prompt("Doctor preference was changed or is missing or ambiguous and must be clarified"),"change_doctor_clarify"),
    edge("node_date_time",prompt("Only date or time changed, but the new date or time preference is still incomplete; preserve the same canonical service and doctor"),"change_date_time_clarify"),
    edge("node_check",prompt("Only date/time/window changed and final values are clear, or a new specific doctor was clearly named; preserve the service and established doctor mode, use the new doctor only when explicitly changed, and check fresh availability"),"change_recheck")]),
 fn("node_invalidate_after_book","Clear Completed Booking State","tool-apero-invalidate",always_to="node_anything_else"),
 convo("node_existing_identity","Verify Existing Patient","Ask for the patient's full name and the contact phone on the appointment. If caller is a parent or other person, keep caller and patient distinct. This is required before discussing existing appointment details.",
   [edge("node_lookup",prompt("Patient name and phone were clearly provided and confirmed"),"existing_lookup")]),
 fn("node_lookup","Look Up Future Appointments","tool-apero-lookup",[
   edge("node_select_existing",equation(("lookup_success","==","true"),("appointment_count",">","0")),"lookup_found"),
   edge("node_existing_not_found",equation(("lookup_success","==","true"),("appointment_count","==","0")),"lookup_none")],"node_tool_failure"),
 convo("node_existing_not_found","No Matching Appointment","No matching future appointment was found for verified patient details. Clarify name/phone once, then offer staff follow-up if still unresolved.",
   [edge("node_existing_identity",prompt("Caller corrects identifying details"),"existing_retry"),
    edge("node_callback_collect",prompt("Caller requests staff follow-up"),"existing_callback")]),
 convo("node_select_existing","Select Existing Appointment","Read only the matching future appointments returned by lookup. If several, ask which exact appointment. Capture its appointment_id. Ask whether caller wants to reschedule or cancel; do not change anything yet.",
   [edge("node_reschedule_details",prompt("One exact existing appointment is identified and caller wants to change it"),"existing_reschedule"),
    edge("node_cancel_confirm",prompt("One exact existing appointment is identified and caller wants to cancel it"),"existing_cancel")]),
 convo("node_reschedule_details","New Appointment Details","Preserve the selected existing appointment_id and patient identity. Ask what should change, one question at a time. Preserve unchanged service/doctor/date/time from the existing appointment only after confirming them. Establish service and doctor preference before checking. Never create a second booking.",
   [edge("node_reschedule_check",prompt("Final service, doctor preference and new date/time or earliest search are clear"),"reschedule_check")]),
 fn("node_reschedule_check","Check Reschedule Slot","tool-1789478621144",[
   edge("node_reschedule_offer",equation(("availability_success","==","true"),("available","==","true")),"reschedule_available"),
   edge("node_reschedule_no_slots",equation(("availability_success","==","true"),("available","==","false")),"reschedule_unavailable"),
   edge("node_reschedule_check_error",equation(("availability_success","==","false")),"reschedule_check_error")],"node_tool_failure"),
 convo("node_reschedule_check_error","Reschedule Validation","The new slot was not verified. Clarify any invalid practitioner, service, date or patient information; for a technical error, say the original appointment remains unchanged and offer staff follow-up. Never claim the reschedule succeeded.",
   [edge("node_invalidate_reschedule",prompt("Caller corrects the new request"),"reschedule_error_retry"),
    edge("node_callback_collect",prompt("Caller wants staff follow-up"),"reschedule_error_callback")]),
 convo("node_reschedule_no_slots","No New Slot","The original appointment remains unchanged. Explain no verified new slot matched and ask for another date/time or permission to try another qualified practitioner.",
   [edge("node_invalidate_reschedule",prompt("Caller offers different reschedule details"),"reschedule_no_change"),
    edge("node_anything_else",prompt("Caller keeps the original appointment"),"reschedule_keep")]),
 convo("node_reschedule_offer","Offer Reschedule Slots","Offer only returned verified new slots. The original appointment remains intact. Ask the caller to choose one; if any detail changes, invalidate and recheck.",
   [edge("node_invalidate_reschedule",prompt("Caller changes service, doctor, date, time, window or selected slot"),"reschedule_offer_change"),
    edge("node_reschedule_final",prompt("Caller selects one exact returned new slot"),"reschedule_offer_choose"),
    edge("node_anything_else",prompt("Caller keeps original appointment"),"reschedule_offer_keep")]),
 convo("node_reschedule_final","Final Reschedule Confirmation","Read back patient, service, practitioner, OLD appointment and NEW date/time. Ask explicitly whether to move this exact appointment. A correction or ambiguity is not confirmation.",
   [edge("node_invalidate_reschedule",prompt("Caller changes any reschedule detail"),"reschedule_final_change"),
    edge("node_reschedule_tool",prompt("Caller clearly confirms moving this exact appointment to the selected verified slot"),"reschedule_final_yes"),
    edge("node_anything_else",prompt("Caller declines and keeps original appointment"),"reschedule_final_no")]),
 fn("node_reschedule_tool","Reschedule Existing Appointment","tool-apero-reschedule",[
   edge("node_rescheduled",equation(("reschedule_success","==","true"),("rescheduled_id","exists",None)),"reschedule_success")],"node_reschedule_failed"),
 convo("node_rescheduled","Reschedule Confirmed","Only after backend success, say the selected appointment has moved. Repeat the patient, practitioner, service and new date/time.",always_to="node_invalidate_after_book"),
 convo("node_reschedule_failed","Reschedule Not Completed","Say the change did not complete and the original appointment remains. If the slot was taken, offer a fresh check. If technical failure, offer a durable callback.",
   [edge("node_invalidate_reschedule",prompt("Caller wants to try another new slot"),"reschedule_failed_retry"),
    edge("node_callback_collect",prompt("Caller requests staff follow-up"),"reschedule_failed_callback")]),
 fn("node_invalidate_reschedule","Invalidate Reschedule Slot","tool-apero-invalidate",always_to="node_reschedule_details"),
 convo("node_cancel_confirm","Final Cancellation Confirmation","Read back the exact patient's appointment, practitioner, date and time. Ask clearly whether to CANCEL that appointment. Do not imply cancellation has occurred.",
   [edge("node_cancel_tool",prompt("Caller explicitly confirms cancellation of that exact selected appointment"),"cancel_yes"),
    edge("node_anything_else",prompt("Caller declines cancellation"),"cancel_no")]),
 fn("node_cancel_tool","Cancel Existing Appointment","tool-apero-cancel",[
   edge("node_cancelled",equation(("cancel_success","==","true"),("cancelled_id","exists",None)),"cancel_success")],"node_cancel_failed"),
 convo("node_cancelled","Cancellation Confirmed","Only after backend success, say the selected appointment was cancelled. Ask whether anything else is needed.",always_to="node_anything_else"),
 convo("node_cancel_failed","Cancellation Not Completed","Say the appointment was NOT cancelled. Briefly apologize; offer to verify details or submit a staff callback.",
   [edge("node_existing_identity",prompt("Caller wants to correct patient details"),"cancel_retry"),
    edge("node_callback_collect",prompt("Caller wants staff follow-up"),"cancel_callback")]),
 convo("node_faq","Clinic Questions","Answer briefly using approved clinic facts only. This is a {clinic_type}. {pricing_policy} {insurance_policy} Ask if anything else is needed.",
   [edge("node_anything_else",prompt("Question answered"),"faq_done")]),
 convo("node_global_faq","Brief Question During Another Task","Answer the short clinic question from approved facts, then return to the previous booking or existing-appointment state. Do not interpret the question as consent. Do not lose the patient's existing details.",
   global_condition="Caller briefly asks a general clinic question such as hours, location, price or insurance in the middle of another request, and does not abandon that request."),
 convo("node_global_urgent","Urgent Concern","Acknowledge concern without diagnosis. {transfer_policy} Say staff follow-up is needed, ask for a callback number and concise reason. For potentially life-threatening symptoms, advise the caller to contact local emergency services immediately. Do not claim a transfer is happening.",
   global_condition="Caller describes urgent or potentially emergency dental or medical symptoms.",always_to="node_urgent_collect"),
 convo("node_global_human","Human Request","Acknowledge the request. {transfer_policy} Offer a real persisted staff callback; do not say a transfer is occurring.",
   global_condition="Caller explicitly requests a human, manager or receptionist, or is frustrated and asks for staff.",always_to="node_callback_collect"),
 convo("node_message_collect","Take Message","Ask for caller name, callback phone and message, one at a time. Read back uncertain details. Do not promise delivery before persistence.",
   [edge("node_message_tool",prompt("Caller confirms message and contact details"),"message_submit")]),
 fn("node_message_tool","Persist Message","tool-apero-message",[
   edge("node_message_saved",equation(("message_success","==","true")),"message_saved")],"node_request_failed"),
 convo("node_message_saved","Message Submitted","The message was saved. Tell caller staff can follow up; do not promise an exact time.",always_to="node_anything_else"),
 convo("node_callback_collect","Collect Callback","Ask for caller name, confirmed callback phone and concise reason. {transfer_policy} Do not promise follow-up until saved.",
   [edge("node_callback_tool",prompt("Callback details confirmed"),"callback_submit")]),
 fn("node_callback_tool","Persist Callback","tool-apero-callback",[
   edge("node_callback_saved",equation(("callback_success","==","true")),"callback_saved")],"node_request_failed"),
 convo("node_callback_saved","Callback Submitted","The request was saved. Say staff follow-up is needed; do not promise an exact time or a transfer.",always_to="node_anything_else"),
 convo("node_urgent_collect","Collect Urgent Contact","Stay brief. Ask for confirmed callback phone and a short reason. Do not diagnose or claim live transfer. If no number can be collected, clearly say the request could not be submitted and advise caller to contact clinic or emergency services as appropriate.",
   [edge("node_urgent_tool",prompt("Urgent callback phone and reason confirmed"),"urgent_submit")]),
 fn("node_urgent_tool","Persist Urgent Escalation","tool-apero-urgent",[
   edge("node_urgent_saved",equation(("urgent_success","==","true")),"urgent_saved")],"node_request_failed"),
 convo("node_urgent_saved","Urgent Request Submitted","The urgent request was saved. Say staff need to follow up. Do not claim a live transfer occurred.",always_to="node_anything_else"),
 convo("node_request_failed","Request Not Submitted","The message or callback request was NOT saved. Say so plainly and offer the clinic phone number from the approved clinic record; do not promise staff received it.",always_to="node_anything_else"),
 convo("node_tool_failure","Tool Unavailable","The operation did not return a reliable result. Do not claim availability, booking, cancellation or rescheduling. Apologize briefly and offer staff callback if contact can be collected.",
   [edge("node_callback_collect",prompt("Caller accepts staff callback"),"tool_failure_callback"),
    edge("node_anything_else",prompt("Caller declines callback"),"tool_failure_end")]),
 convo("node_anything_else","Anything Else","Ask briefly whether there is anything else you can help with. For another appointment, start a fresh booking cycle with no old slot, service or doctor.",
   [edge("node_greeting",prompt("Caller has another request"),"anything_yes"),
    edge("node_end",prompt("Caller is finished"),"anything_no")]),
 {"id":"node_end","name":"End Call","type":"end","skippable":False,"display_position":{"x":0,"y":0}},
]

global_prompt = """You are Sara, the calm {clinic_name} receptionist in {clinic_address}. Speak naturally in the caller's {languages}, including mixed-language doctor and service names. Usually speak in one or two short sentences and ask one question at a time. Acknowledge corrections briefly. Do not repeat known details or narrate tools, checks, databases or internal logic. Accuracy takes priority over brevity. Never invent clinic, doctor, price, insurance or appointment facts. Use the approved knowledge base and backend results only.

Clinic time zone is {timezone}. Resolve relative dates using {current_time_variable} and {current_calendar_variable}. Clarify ambiguity. No past slots. Speak dates and times naturally; send machine-readable YYYY-MM-DD and HH:mm to tools. Do not reveal IDs, slot tokens, JSON, APIs or internal actions.

Service first, then doctor preference before the FIRST availability check. If multiple qualified practitioners offer the service, ask whether a specific one is preferred only if the preference is missing. If only one qualifies, use them without asking. Once a valid practitioner or any-qualified preference is established, preserve it across checks, slot selection, corrections, interruptions, general questions and final confirmation. Do not ask for the doctor again after a date/time-only change; recheck the new date/time with the same canonical practitioner ID. Reassess preference only if doctor or service changes, or the name was ambiguous or invalid. If any doctor is fine, search only qualified practitioners. The server resolves Arabic and English name variants. If resolution is ambiguous, ask; never guess. Never silently replace a requested doctor.

Only offer exact slots in the latest successful check_availability slots array. Each slot carries an opaque slot_id and canonical practitioner_id. Preserve the selected slot_id internally. A positive date-level flag is not a time. If doctor, service, date, exact time, window, location or any-versus-specific preference changes, immediately use invalidate_availability and check again. The old slot_id must not be reused. The backend rejects stale or mismatched slots.

Booking for someone else is allowed. Patient name is the person attending; caller name is separate. A guardian's phone may be the child's contact. Confirm uncertain names and phone digits. Never call booking with malformed or unconfirmed contact details. For a second appointment, clear booking-specific state and start again.

Before book_appointment, read back patient, service, practitioner, date and time for the latest selected returned slot. State the already selected doctor in the read-back; do not ask which doctor again. Require a clear affirmative answer to THAT exact tuple. Silence, maybe, an unrelated yes or a correction is not consent. If anything changes, invalidate and re-check. Say 'I found a slot' before booking; say 'booked' ONLY after backend success and an appointment ID. On failure say it was not completed. Do not retry an uncertain operation with altered details.

Existing appointment details require patient name and phone lookup. Reschedule uses only reschedule_appointment on the identified appointment; cancellation uses only cancel_appointment after explicit confirmation. The original appointment remains if reschedule fails. Never call book_appointment to reschedule. State success only after the corresponding backend success.

{transfer_policy} Never say a transfer occurred. A message, callback or urgent escalation is submitted only after its persistence tool succeeds. If it fails, say it was not submitted. Do not diagnose or give personalized treatment advice. For a potentially life-threatening situation, advise local emergency services and seek an urgent staff callback. {pricing_policy} {insurance_policy}

For a brief general question during scheduling, answer from approved facts and return to the prior state. Do not treat that interruption as confirmation. If a tool is slow, one short 'Let me check' is enough; never announce success before the result."""

output = {"global_prompt":global_prompt,"nodes":nodes,"tools":tools,"components":[],"start_node_id":"node_greeting",
          "start_speaker":"agent","model_choice":old["model_choice"],"model_temperature":0,"tool_call_strict_mode":True,
          "default_dynamic_variables":{key:config[key] for key in ("clinic_name", "clinic_address", "clinic_phone", "clinic_hours")},
          "knowledge_base_ids":[config["knowledge_base_id"]],"kb_config":old.get("kb_config",{"top_k":3,"filter_score":0.6})}
# Render clinic wording in the common prompt and nodes. Retell tools use one shared endpoint.
replacements = {key: str(config[key]) for key in ("clinic_name", "clinic_name_ar", "clinic_address", "timezone", "languages", "clinic_type", "pricing_policy", "insurance_policy", "current_time_variable", "current_calendar_variable")}
replacements["transfer_policy"] = "No live transfer destination is configured. Offer a persisted staff callback."
def render(value):
    if isinstance(value, str):
        for key, replacement in replacements.items(): value = value.replace("{" + key + "}", replacement)
        return value
    if isinstance(value, list): return [render(item) for item in value]
    if isinstance(value, dict): return {key: render(item) for key, item in value.items()}
    return value
output = render(output)
Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(f"Prepared {len(nodes)} nodes and {len(tools)} tools for {config['clinic_name']} at {args.output}")
