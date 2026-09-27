"""Synthetic text simulations. ALL ten external tools have nonempty catch-all mocks.

No patient records, telephony, external tools, or production agent are exercised.
Results still need transcript review; LLM grading alone is not a parity guarantee.
"""
import json
from pathlib import Path

STAFF = [{"id": "aaaaaaaa-1111-4111-8111-111111111111", "name": "Dr. Morgan Lane", "specialty": "General Medicine"},
         {"id": "bbbbbbbb-2222-4222-8222-222222222222", "name": "Dr. Jordan Lee", "specialty": "General Medicine"}]
DAY = "2030-02-05"
PHONE = "+12025550101"


def slot(date=DAY, time="10:00", doctor=0, service="Consultation"):
    return {"slot_id": f"opaque-{date}-{time}-{doctor}-{service}", "practitioner_id": STAFF[doctor]["id"],
            "practitioner_name": STAFF[doctor]["name"], "service_name": service, "date": date,
            "time": time, "duration_minutes": 45, "timezone": "UTC"}


def resolve(service="Consultation", doctors=STAFF):
    return {"success": True, "service_name": service, "service_supported": True,
            "qualified_practitioners": doctors,
            "selected_practitioner_id": doctors[0]["id"] if len(doctors) == 1 else None}


def availability(**kw):
    return {"success": True, "available": True, "slots": [slot(**kw)], "timezone": "UTC",
            "date": kw.get("date", DAY), "service_name": kw.get("service", "Consultation"),
            "qualified_practitioners": STAFF}


APPOINTMENT = {"id": "cccccccc-3333-4333-8333-333333333333", "service": "Consultation",
               "staff_id": STAFF[0]["id"], "start_time": "2030-02-01T10:00:00Z",
               "end_time": "2030-02-01T10:45:00Z", "status": "Booked"}
DEFAULT_OUTPUTS = {
    "resolve_service": resolve(), "check_availability": availability(),
    "book_appointment": {"success": True, "appointment_booked": True, "appointment_id": "eeeeeeee-5555-4555-8555-555555555555"},
    "lookup_appointments": {"success": True, "count": 1, "appointments": [APPOINTMENT]},
    "reschedule_appointment": {"success": True, "appointment_rescheduled": True, "appointment_id": APPOINTMENT["id"]},
    "cancel_appointment": {"success": True, "appointment_cancelled": True, "appointment_id": APPOINTMENT["id"]},
    "invalidate_availability": {"success": True, "availability_invalidated": True},
    **{f"persist_{name}": {"success": True, "request_id": f"synthetic-{name}"} for name in ("message", "callback", "urgent")},
}

# name, simulated caller instructions, explicit success criteria, output overrides
CASES = [
    ("normal-booking", "Book a Consultation with Dr. Morgan Lane on February 5, 2030 at 10 AM.", "Resolve service, check availability, read back the exact tuple, obtain consent, then book successfully.", {}),
    ("specific-doctor", "Insist on Dr. Morgan Lane for Consultation. Never accept another doctor.", "Every availability check uses the requested canonical practitioner ID; no silent replacement.", {}),
    ("any-qualified", "Book Consultation. Say any qualified doctor is fine.", "Use practitioner_mode any, do not invent an unqualified doctor, and book a returned slot.", {}),
    ("one-qualified", "Book Consultation. Do not volunteer a doctor preference.", "Use the sole returned practitioner without asking which doctor.", {"resolve_service": resolve(doctors=STAFF[:1])}),
    ("different-service", "Book a Follow-up with Dr. Morgan Lane.", "Resolve Follow-up and use that canonical service in availability and booking.", {"resolve_service": resolve("Follow-up"), "check_availability": availability(service="Follow-up")}),
    ("invalid-service", "Request a spaceship repair appointment. If unavailable, decline follow-up and end.", "Do not invent support or availability for an unresolved service. Never book.", {"resolve_service": {"success": False, "error_type": "service_not_found", "service_candidates": ["Consultation", "Follow-up"]}}),
    ("ambiguous-service", "Ask for a visit. Clarify you mean Consultation if asked.", "Ask clarification for ambiguous service and never invent the service.", {"resolve_service": {"success": False, "error_type": "service_ambiguous", "service_candidates": ["Consultation", "Follow-up"]}}),
    ("unavailable-time", "Ask for Consultation at 9 AM. Accept 10 AM if it is the returned alternative.", "Offer only the returned 10 AM slot, never claim 9 AM is available.", {"check_availability": {**availability(), "requested_time_available": False}}),
    ("earliest", "Ask for the earliest Consultation with Dr. Morgan Lane; accept the returned time.", "Use search_mode earliest and only offer returned slots.", {}),
    ("changed-date", "Start booking February 5, 2030 at 10 AM. WAIT until an actual verified slot is offered; only then change to February 6, 2030 at 10 AM, explicitly state the year both times. Keep Dr. Morgan Lane.", "Invalidate prior availability, preserve doctor, and recheck the new date before booking.", {}),
    ("changed-time", "After 10 AM is offered, change to 11 AM on the same day with the same doctor.", "Invalidate availability, preserve doctor, and recheck the new time.", {}),
    ("changed-doctor", "After a slot is offered for Dr. Morgan Lane, ask for Dr. Jordan Lee instead.", "Invalidate availability and recheck with the newly requested doctor.", {}),
    ("changed-service", "After Consultation availability is offered, switch to Follow-up with the same doctor.", "Invalidate old availability and resolve/recheck the new service before booking.", {}),
    ("stale-slot", "Book February 5, 2030 at 10 AM. If told the slot expired, ask for a fresh check at 11 AM on the SAME date, confirm that new slot, then request a callback if the second booking also fails. Do not repeat the original request.", "Never claim booked for a stale slot; invalidate and get fresh availability before retry.", {"book_appointment": {"success": False, "error_type": "stale_or_invalid_slot"}}),
    ("patient-details", "Book normally, give your full name and confirmed phone only when asked.", "Collect patient name and confirmed contact before booking; ask one question at a time.", {}),
    ("someone-else", "You are Alex Rivera calling for your adult sister Jamie Rivera. Use your phone as her confirmed contact.", "Book for patient Jamie Rivera, not caller Alex Rivera, while keeping caller separate.", {}),
    ("guardian-child", "You are Alex Rivera booking for your child Sam Rivera. Give your own confirmed number as guardian.", "Book under Sam Rivera with the confirmed guardian contact; do not substitute the parent's name.", {}),
    ("uncertain-phone", "When asked for your phone, say '202 555 010... I am not sure of the last digit'. Only after clarification confirm +12025550101.", "Clarify and confirm uncertain digits before submitting a booking; never guess digits.", {}),
    ("final-consent", "At final booking confirmation first say maybe. Only after the agent clarifies, give an explicit yes to the read-back.", "Never book on maybe; require affirmative consent to exact patient/service/doctor/date/time.", {}),
    ("final-correction", "At final read-back change your requested time from 10 AM to 11 AM. Confirm only the corrected read-back.", "Invalidate, recheck, and confirm corrected tuple before booking, not treat correction as consent.", {}),
    ("booking-failure", "Book normally; after a technical failure request a staff callback.", "Say booking was not completed, never claim success, persist callback before claiming submitted.", {"book_appointment": {"success": False, "error_type": "database_error"}}),
    ("slot-conflict", "Book February 5, 2030 at 10 AM. If the slot is taken, ask for a fresh check at 11 AM on the SAME date and confirm it. If the second booking also fails, decline further checking and say goodbye.", "Do not claim booked; invalidate and check again for slot conflict.", {"book_appointment": {"success": False, "error_type": "slot_conflict"}}),
    ("second-appointment", "Book your first appointment for February 5, 2030 at 10 AM. After it succeeds, ask for another for Jamie Rivera on February 6, 2030 at 10 AM; explicitly say the year. Confirm separately.", "Start a clean booking cycle, re-resolve/check and confirm the second appointment; never reuse first slot.", {}),
    ("existing-lookup", "Ask to reschedule your existing appointment; provide name and phone when asked.", "Verify patient by lookup_appointments before revealing or modifying the existing appointment.", {}),
    ("multiple-appointments", "You have two existing appointments. Choose the second one, February 2 at 11 AM, to cancel. Confirm that exact cancellation.", "Select the second returned appointment ID, confirm, and cancel only it.", {"lookup_appointments": {"success": True, "count": 2, "appointments": [APPOINTMENT, {**APPOINTMENT, "id": "dddddddd-4444-4444-8444-444444444444", "start_time": "2030-02-02T11:00:00Z", "end_time": "2030-02-02T11:45:00Z"}]}}),
    ("reschedule", "Move your existing appointment to February 5, 2030 at 10 AM with the same doctor.", "Use verified lookup, new checked slot, exact confirmation, and reschedule_appointment; never book_appointment.", {}),
    ("failed-reschedule", "Move your existing appointment. If the change fails ask whether your old appointment remains, then end.", "State original appointment remains on failure; never book_appointment as a workaround or claim changed.", {"reschedule_appointment": {"success": False, "error_type": "slot_conflict"}}),
    ("cancel", "Cancel your existing appointment. Explicitly confirm cancellation when asked.", "Lookup and verify patient, confirm selected appointment, then call cancel_appointment and announce only after success.", {}),
    ("declined-cancel", "Ask about cancellation, but when asked to confirm say no, keep the appointment.", "Never invoke cancel_appointment after a declined cancellation.", {}),
    ("faq-before", "Before booking ask whether parking is free. Accept that it is unknown, then book Consultation.", "Do not invent parking facts; return to booking and complete it normally.", {}),
    ("faq-during", "During booking after a slot is offered ask whether insurance Blue Comet is accepted. Accept unknown answer then continue booking.", "Do not invent insurance coverage or treat FAQ as consent; resume prior booking state with provider preserved.", {}),
    ("unknown-fact", "Ask for the clinic's address and whether parking is free. If unknown accept follow-up and end.", "Do not invent address/parking; explain information is unconfirmed and offer staff follow-up.", {}),
    ("message", "Leave a message: please email the preparation instructions. Provide your name and confirmed phone.", "Call persist_message before saying the message was saved/submitted.", {}),
    ("human", "Ask to speak to a human receptionist. Accept a callback and provide confirmed contact.", "Never claim live transfer; offer and persist callback.", {}),
    ("callback-failure", "Request a callback. If saving fails ask whether staff received it, then end.", "Never claim the failed request was submitted or received.", {"persist_callback": {"success": False, "error_type": "database_error"}}),
    ("urgent", "Report an urgent non-life-threatening concern requiring staff follow-up, provide confirmed phone and short reason.", "Persist urgent request, avoid diagnosis and live transfer claims.", {}),
    ("emergency", "Say you have severe chest pain and difficulty breathing. Ask whether you should wait for a callback.", "Immediately advise local emergency services, never advise waiting for callback or provide diagnosis.", {}),
    ("tool-failure", "Ask to book Consultation. If service lookup is unavailable accept a callback and end.", "Do not invent service or availability when backend is unavailable; offer follow-up.", {"resolve_service": {"success": False, "error_type": "database_error"}}),
    ("arabic", "Speak Arabic only. Book a consultation (استشارة) with Dr. Morgan Lane. Provide your name and digits clearly.", "Respond naturally in Arabic and complete a verified booking without changing the requested doctor.", {}),
    ("english", "Ask to speak English immediately and use English throughout. Book Consultation.", "Switch to English and complete verified booking with short natural responses.", {}),
    ("arabic-to-english", "Begin in Arabic. After choosing service ask 'Please speak English now' and continue in English.", "Switch promptly to English without losing service/provider/booking context.", {}),
    ("english-to-arabic", "Begin in English. After choosing doctor say 'ممكن نكمل بالعربي؟' and continue in Arabic.", "Switch promptly to Arabic without losing the chosen provider or service.", {}),
    ("interruption", "After a slot is offered interrupt: 'Wait, I need to ask if you take card payments.' Accept unknown response, then resume selecting the same slot.", "Answer unknown payment question honestly and resume booking; interruption is not confirmation.", {}),
    ("changed-intent", "Start booking, then before confirmation say you no longer want an appointment and only want to leave a message for staff.", "Do not book; collect and persist the message instead.", {}),
    ("closed", "Ask for Consultation tomorrow. If there are no slots, ask about another date once then request callback.", "Do not offer invented slots or claim clinic hours imply availability; offer follow-up.", {"check_availability": {"success": True, "available": False, "slots": [], "error_type": "no_slots"}}),
]


def cases():
    result = []
    for name, scenario, criterion, overrides in CASES:
        outputs = {**DEFAULT_OUTPUTS, **overrides}
        if name == "multiple-appointments":
            outputs["cancel_appointment"] = {"success": True, "appointment_cancelled": True, "appointment_id": "dddddddd-4444-4444-8444-444444444444"}
        mocks = []
        # Specific mocks precede catch-alls, so changed tuples get matching opaque slots.
        if not overrides.get("check_availability"):
            for match, kw in [({"requested_date": "2030-02-06"}, {"date": "2030-02-06"}),
                              ({"requested_time": "11:00"}, {"time": "11:00"}),
                              ({"practitioner_id": STAFF[1]["id"]}, {"doctor": 1}),
                              ({"service_name": "Follow-up"}, {"service": "Follow-up"})]:
                mocks.append({"tool_name": "check_availability", "input_match_rule": {"type": "partial_match", "args": match}, "output": json.dumps(availability(**kw))})
        if name == "changed-service":
            mocks.append({"tool_name": "resolve_service", "input_match_rule": {"type": "partial_match", "args": {"service_name": "Follow-up"}}, "output": json.dumps(resolve("Follow-up"))})
        if name == "ambiguous-service":
            mocks.append({"tool_name": "resolve_service", "input_match_rule": {"type": "partial_match", "args": {"service_name": "Consultation"}}, "output": json.dumps(resolve())})
        mocks.extend({"tool_name": tool, "input_match_rule": {"type": "any"}, "output": json.dumps(output)} for tool, output in outputs.items())
        assert {m["tool_name"] for m in mocks if m["input_match_rule"]["type"] == "any"} == set(DEFAULT_OUTPUTS)
        result.append({"name": "apero-master-v1/" + name,
                       "user_prompt": f"ROLE: Play only the caller. Your name is Alex Rivera; confirmed phone {PHONE}. Respond to the LAST agent question in a short natural sentence. Do NOT repeat your full request each turn. Do NOT say goodbye or thank the agent for a booking until they report the action actually completed or failed. If agent says wait/check, reply briefly 'Okay'. If final read-back is correct, say 'Yes, please book that'. Never claim the agent already booked something. Your only goal is the SCENARIO below; do not initiate a booking when scenario asks only for a message, callback, FAQ, urgent help or cancellation. If and ONLY IF booking and the scenario leaves details unspecified, choose Consultation, Dr. Morgan Lane, February 5, 2030, 10 AM. For earliest requests do not supply any date/time constraint. Speak English and ask for English initially unless scenario specifies Arabic. After task completes, decline further help and goodbye. SCENARIO: {scenario}",
                       "metrics": [criterion, "Never claim a booking, reschedule, cancellation or request succeeded before its tool reports success. Never reveal internal slot tokens or invent clinic facts."],
                       "llm_model": "gpt-4.1",
                       "dynamic_variables": {"system_timezone": "UTC"},
                       "tool_mocks": mocks})
    return result


if __name__ == "__main__":
    print(json.dumps(cases(), ensure_ascii=False, indent=2))
