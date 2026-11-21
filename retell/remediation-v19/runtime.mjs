import {
  truth,
  textValue,
  uuid,
  parseObject,
  parseArray,
  phoneValid,
  decodeToken,
  querySignature,
  bookingTuple,
  validateSlots,
  selectedTargetValid,
  existingTuple,
  chooseReturnedSlot,
} from "./common.mjs";

export function captureAvailability(dv) {
  if (
    !truth(dv.apero_response_received) ||
    truth(dv.apero_system_unavailable) ||
    !truth(dv.availability_success) ||
    !truth(dv.available)
  )
    throw Error("no_current_availability");
  const result = validateSlots(dv);
  return {
    current_availability_check: result.check,
    current_availability_snapshot: result.snapshot,
    current_availability_signature: querySignature(dv),
    r18_route: "offer",
  };
}
export function matchBookingSlot(dv) {
  const result = {
    slot_id: "",
    slot_match_status: "block",
    slot_match_reason: "invalid_current_check",
  };
  try {
    const state = parseObject(dv.active_booking_state);
    if (
      !truth(dv.reset_ready) ||
      !truth(dv.boundary_verified) ||
      dv.reset_verified_attempt !== dv.reset_attempt ||
      state.cycle !== dv.reset_attempt ||
      state.phase !== "search" ||
      !truth(dv.availability_success) ||
      !truth(dv.available)
    )
      return result;
    const current = validateSlots(dv);
    if (
      current.check !== dv.current_availability_check ||
      current.snapshot !== dv.current_availability_snapshot ||
      querySignature(dv) !== dv.current_availability_signature ||
      dv.availability_query_signature !== dv.current_availability_signature
    )
      return result;
    const selected = chooseReturnedSlot(current.rows, dv);
    if (!selected)
      return {
        ...result,
        slot_match_status: "clarify",
        slot_match_reason: "not_a_unique_returned_slot",
      };
    return { slot_id: selected.slot_id, slot_match_status: "matched", slot_match_reason: "" };
  } catch {
    return {
      ...result,
      slot_match_status: "refresh",
      slot_match_reason: "invalid_or_expired_check",
    };
  }
}
export function practitionerState(dv) {
  const qualified = parseArray(dv.qualified_practitioners);
  if (!truth(dv.resolve_success) || !qualified.length || qualified.some((p) => !uuid(p.id)))
    throw Error("unresolved_service");
  if (dv.practitioner_mode === "any") {
    // Backend-supported scope sentinel is MODE any; an ID sentinel is rejected by the backend.
    if (dv.practitioner_id !== "" || dv.practitioner_name !== "") throw Error("invalid_any_filter");
    return { practitioner_scope: "any" };
  }
  if (
    dv.practitioner_mode !== "specific" ||
    !uuid(dv.practitioner_id) ||
    !qualified.some((p) => p.id === dv.practitioner_id)
  )
    throw Error("missing_practitioner");
  return { practitioner_scope: dv.practitioner_id };
}
export function bookingEntry(dv) {
  const state = parseObject(dv.active_booking_state),
    rows = parseArray(dv.current_availability_snapshot),
    slot = rows.find((s) => s.slot_id === dv.slot_id),
    token = decodeToken(dv.slot_id);
  if (truth(dv.booking_reconciliation_required)) throw Error("unresolved_booking_no_retry");
  if (
    !truth(dv.reset_ready) ||
    !truth(dv.boundary_verified) ||
    !dv.reset_attempt ||
    dv.reset_verified_attempt !== dv.reset_attempt ||
    state.cycle !== dv.reset_attempt ||
    state.phase !== "readback" ||
    dv.intake_name_cycle !== dv.reset_attempt ||
    !textValue(dv.client_name) ||
    !phoneValid(dv.client_phone) ||
    !textValue(dv.service_name) ||
    !uuid(dv.practitioner_id) ||
    !slot ||
    slot.practitioner_id !== dv.practitioner_id ||
    slot.service_name !== dv.service_name ||
    slot.date !== dv.appointment_date ||
    slot.time !== dv.appointment_time ||
    token.i !== dv.current_availability_check ||
    token.k !== dv.call_id ||
    token.s !== dv.practitioner_id ||
    token.v !== dv.service_name ||
    token.e <= Date.now() + 30000 ||
    dv.selection_cycle !== dv.reset_attempt ||
    dv.patient_cycle !== dv.reset_attempt ||
    dv.consent_cycle !== dv.reset_attempt ||
    !truth(dv.patient_confirmed) ||
    !truth(dv.consent_confirmed) ||
    state.slot !== dv.slot_id ||
    state.patient !== dv.client_name ||
    dv.booking_readback !== bookingTuple(dv) ||
    dv.consent_tuple !== bookingTuple(dv)
  )
    throw Error("booking_fields_or_consent_missing");
  return {
    intake_entry_ok: true,
    booking_reconciliation_required: true,
    booking_attempt_tuple: bookingTuple(dv),
    booking_attempt_cycle: dv.reset_attempt,
  };
}
export function bookingResult(dv) {
  const valid =
    truth(dv.apero_response_received) &&
    !truth(dv.apero_system_unavailable) &&
    truth(dv.booking_success) &&
    truth(dv.appointment_booked) &&
    uuid(dv.booking_id) &&
    truth(dv.booking_reconciliation_required) &&
    dv.booking_attempt_cycle === dv.reset_attempt &&
    dv.booking_attempt_tuple === bookingTuple(dv);
  return { booking_result_verified: valid, booking_reconciliation_required: !valid };
}
export function identityCorrection(dv) {
  if (truth(dv.booking_reconciliation_required)) return { r18_route: "locked" };
  const state = parseObject(dv.active_booking_state),
    name = textValue(dv.corrected_patient_name),
    phone = textValue(dv.corrected_patient_phone),
    evidence = textValue(dv.identity_correction_evidence);
  if (
    !dv.reset_attempt ||
    state.cycle !== dv.reset_attempt ||
    (!name && !phone) ||
    (name && !evidence.toLowerCase().includes(name.toLowerCase())) ||
    (phone &&
      (!phoneValid(phone) || !evidence.replace(/\D/g, "").includes(phone.replace(/\D/g, ""))))
  )
    return { r18_route: "clarify" };
  const client_name = name || dv.client_name,
    client_phone = phone || dv.client_phone;
  const confirmed =
    !!textValue(client_name) &&
    phoneValid(client_phone) &&
    (!!phone || truth(dv.patient_confirmed));
  const selected =
    !!dv.slot_id &&
    dv.selection_cycle === dv.reset_attempt &&
    ["selected", "readback"].includes(state.phase);
  return {
    client_name,
    client_phone,
    patient_confirmed: confirmed,
    patient_evidence: confirmed ? `${client_name} ${client_phone}` : "",
    intake_name_cycle: dv.reset_attempt,
    intake_name_evidence: client_name,
    consent_confirmed: false,
    consent_cycle: "",
    consent_tuple: "",
    booking_readback: "",
    patient_cycle: "",
    active_booking_state: JSON.stringify({
      ...state,
      phase: selected ? "selected" : state.phase,
      patient: "",
      consent: "",
    }),
    r18_route: truth(dv.identity_also_changes_schedule)
      ? "schedule"
      : selected
        ? "readback"
        : state.phase === "search"
          ? "offer"
          : "intake",
  };
}
export function operationBoundary(dv) {
  return {
    operation_kind: "existing_lookup",
    existing_cycle: String(Date.now()) + "-" + String(Math.random()),
    existing_lookup_cycle: "",
    existing_lookup_snapshot: "[]",
    existing_target_snapshot: "{}",
    existing_selected_id: "",
    existing_staff_id: "",
    existing_service: "",
    existing_start: "",
    existing_action: "",
    existing_patient_name: "",
    existing_patient_phone: "",
    existing_readback: "",
    existing_approval: false,
    existing_approval_tuple: "",
    existing_attempt: "",
    existing_attempt_tuple: "",
    existing_attempt_action: "",
    existing_attempt_target: "",
    existing_slot_id: "",
    existing_new_date: "",
    existing_new_time: "",
    existing_current_check: "",
    existing_slots_snapshot: "[]",
    slot_id: "",
    slots: "[]",
    current_availability_check: "",
    current_availability_snapshot: "[]",
    current_availability_signature: "",
    availability_query_signature: "",
    availability_success: false,
    available: false,
    booking_success: false,
    appointment_booked: false,
    booking_id: "",
    booking_error_type: "",
    cancel_success: false,
    cancelled_id: "",
    cancel_error_type: "",
    reschedule_success: false,
    rescheduled_id: "",
    reschedule_error_type: "",
    consent_confirmed: false,
    consent_tuple: "",
    consent_cycle: "",
    booking_readback: "",
    selection_cycle: "",
    patient_cycle: "",
    lookup_success: false,
    appointments: "[]",
    appointment_count: 0,
    existing_choice_index: "",
    existing_choice_action: "",
    existing_choice_unclear: false,
    existing_requested_date: "",
    existing_requested_time: "",
    existing_window_start: "",
    existing_window_end: "",
    existing_search_mode: "",
    reschedule_changes_service: false,
    reschedule_changes_practitioner: false,
    existing_target_fresh: false,
    existing_target_verified_attempt: "",
    existing_fresh_lookup_success: false,
    existing_fresh_appointments: "[]",
    existing_fresh_attempt: "",
    r18_route: "identity",
  };
}
export function captureLookup(dv) {
  const rows = parseArray(dv.appointments);
  if (
    !truth(dv.apero_response_received) ||
    truth(dv.apero_system_unavailable) ||
    !truth(dv.lookup_success) ||
    !textValue(dv.client_name) ||
    !phoneValid(dv.client_phone) ||
    !dv.existing_cycle ||
    !rows.length ||
    rows.some(
      (a) =>
        !uuid(a.id) ||
        !uuid(a.staff_id) ||
        !textValue(a.service) ||
        !Number.isFinite(Date.parse(a.start_time)) ||
        Date.parse(a.start_time) <= Date.now(),
    )
  )
    throw Error("lookup_not_current");
  return {
    existing_lookup_snapshot: JSON.stringify(rows),
    existing_lookup_cycle: dv.existing_cycle,
    existing_patient_name: dv.client_name,
    existing_patient_phone: dv.client_phone,
    r18_route: "select",
  };
}
export function selectExisting(dv) {
  const rows = parseArray(dv.existing_lookup_snapshot),
    index = Number(dv.existing_choice_index);
  const empty = {
    existing_selected_id: "",
    existing_target_snapshot: "{}",
    existing_readback: "",
    existing_approval: false,
    existing_approval_tuple: "",
    existing_slot_id: "",
    existing_current_check: "",
    existing_slots_snapshot: "[]",
    existing_new_date: "",
    existing_new_time: "",
    existing_attempt: "",
    existing_attempt_tuple: "",
    existing_attempt_action: "",
    existing_attempt_target: "",
    reschedule_changes_service: false,
    reschedule_changes_practitioner: false,
    r18_route: "select",
  };
  if (
    dv.existing_lookup_cycle !== dv.existing_cycle ||
    truth(dv.existing_choice_unclear) ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > rows.length ||
    !["cancel", "reschedule"].includes(dv.existing_choice_action)
  )
    return empty;
  const target = rows[index - 1];
  if (
    !uuid(target.id) ||
    Date.parse(target.start_time) <= Date.now() ||
    dv.client_name !== dv.existing_patient_name ||
    dv.client_phone !== dv.existing_patient_phone
  )
    return empty;
  return {
    ...empty,
    existing_selected_id: target.id,
    existing_target_snapshot: JSON.stringify(target),
    existing_staff_id: target.staff_id,
    existing_service: target.service,
    existing_start: target.start_time,
    existing_action: dv.existing_choice_action,
    operation_kind: dv.existing_choice_action,
    r18_route: dv.existing_choice_action,
  };
}
export function existingReadback(dv) {
  if (!selectedTargetValid(dv))
    return {
      r18_route: "select",
      existing_readback: "",
      existing_approval: false,
      existing_approval_tuple: "",
    };
  if (dv.existing_action === "reschedule") {
    const slots = parseArray(dv.existing_slots_snapshot),
      s = slots.find((s) => s.slot_id === dv.existing_slot_id),
      t = decodeToken(dv.existing_slot_id);
    if (
      !s ||
      s.practitioner_id !== dv.existing_staff_id ||
      s.service_name !== dv.existing_service ||
      s.date !== dv.existing_new_date ||
      s.time !== dv.existing_new_time ||
      t.i !== dv.existing_current_check ||
      t.e <= Date.now() + 30000
    )
      return {
        r18_route: "reschedule_search",
        existing_readback: "",
        existing_approval: false,
        existing_approval_tuple: "",
      };
  }
  return {
    existing_readback: existingTuple(dv),
    existing_approval: false,
    existing_approval_tuple: "",
    r18_route: dv.existing_action,
  };
}
export function existingEntry(dv) {
  const action = dv.existing_action;
  if (
    !["cancel", "reschedule"].includes(action) ||
    dv.operation_kind !== action ||
    !selectedTargetValid(dv) ||
    !truth(dv.existing_approval) ||
    dv.existing_approval_tuple !== existingTuple(dv) ||
    dv.existing_readback !== existingTuple(dv)
  )
    return { r18_route: "select", existing_attempt: "" };
  if (action === "reschedule") {
    if (truth(dv.reschedule_changes_service) || truth(dv.reschedule_changes_practitioner))
      return { r18_route: "select", existing_attempt: "" };
    const s = parseArray(dv.existing_slots_snapshot).find((s) => s.slot_id === dv.existing_slot_id),
      t = decodeToken(dv.existing_slot_id);
    if (
      !s ||
      t.i !== dv.existing_current_check ||
      t.k !== dv.call_id ||
      t.s !== dv.existing_staff_id ||
      t.v !== dv.existing_service ||
      t.e <= Date.now() + 30000 ||
      s.date !== dv.existing_new_date ||
      s.time !== dv.existing_new_time
    )
      return { r18_route: "reschedule_search", existing_attempt: "" };
  }
  return {
    existing_attempt: String(Date.now()) + "-" + String(Math.random()),
    existing_attempt_tuple: existingTuple(dv),
    existing_attempt_action: action,
    existing_attempt_target: dv.existing_selected_id,
    cancel_success: false,
    cancelled_id: "",
    cancel_error_type: "",
    reschedule_success: false,
    rescheduled_id: "",
    reschedule_error_type: "",
    current_cancelled: false,
    current_rescheduled: false,
    current_result_service: "",
    current_result_staff: "",
    current_result_start: "",
    existing_result_verified: false,
    apero_response_received: false,
    apero_system_unavailable: false,
    apero_downtime_message: "",
    r18_route: action,
  };
}
export function existingResult(dv) {
  const action = dv.existing_attempt_action,
    id = action === "cancel" ? dv.cancelled_id : dv.rescheduled_id,
    success = action === "cancel" ? dv.cancel_success : dv.reschedule_success,
    flag = action === "cancel" ? dv.current_cancelled : dv.current_rescheduled;
  let valid =
    ["cancel", "reschedule"].includes(action) &&
    truth(dv.apero_response_received) &&
    !truth(dv.apero_system_unavailable) &&
    !!dv.existing_attempt &&
    truth(dv.existing_target_fresh) &&
    dv.existing_target_verified_attempt === dv.existing_attempt &&
    selectedTargetValid(dv) &&
    dv.existing_attempt_target === dv.existing_selected_id &&
    dv.existing_attempt_tuple === existingTuple(dv) &&
    truth(success) &&
    truth(flag) &&
    uuid(id) &&
    id === dv.existing_selected_id;
  if (valid && action === "reschedule") {
    const expected = decodeToken(dv.existing_slot_id);
    valid =
      dv.current_result_staff === dv.existing_staff_id &&
      dv.current_result_service === dv.existing_service &&
      Date.parse(dv.current_result_start) === Date.parse(expected.t);
  }
  return { existing_result_verified: valid, r18_route: valid ? action : "failure" };
}
export function revalidateExistingTarget(dv) {
  const rows = parseArray(dv.existing_fresh_appointments),
    expected = parseObject(dv.existing_target_snapshot),
    current = rows.find((a) => a.id === dv.existing_selected_id);
  const valid =
    truth(dv.apero_response_received) &&
    !truth(dv.apero_system_unavailable) &&
    truth(dv.existing_fresh_lookup_success) &&
    selectedTargetValid(dv) &&
    !!dv.existing_attempt &&
    dv.existing_fresh_attempt === dv.existing_attempt &&
    dv.existing_attempt_tuple === existingTuple(dv) &&
    !!current &&
    ["id", "staff_id", "service", "start_time", "end_time", "status"].every(
      (k) => current[k] === expected[k],
    );
  if (valid)
    return {
      existing_target_fresh: true,
      existing_target_verified_attempt: dv.existing_attempt,
      r18_route: dv.existing_action,
    };
  return {
    existing_target_fresh: false,
    existing_target_verified_attempt: "",
    existing_selected_id: "",
    existing_target_snapshot: "{}",
    existing_readback: "",
    existing_approval: false,
    existing_approval_tuple: "",
    existing_attempt: "",
    existing_attempt_tuple: "",
    existing_lookup_snapshot: JSON.stringify(rows),
    existing_lookup_cycle: dv.existing_cycle,
    r18_route: rows.length ? "select" : "not_found",
  };
}
export function rescheduleSearch(dv) {
  if (!selectedTargetValid(dv) || dv.existing_action !== "reschedule")
    return { r18_route: "select" };
  if (truth(dv.reschedule_changes_service) || truth(dv.reschedule_changes_practitioner))
    return { r18_route: "unsupported" };
  if (
    !["date", "earliest"].includes(dv.existing_search_mode) ||
    (dv.existing_search_mode !== "earliest" &&
      !/^\d{4}-\d{2}-\d{2}$/.test(dv.existing_requested_date))
  )
    return { r18_route: "clarify" };
  for (const t of [dv.existing_requested_time, dv.existing_window_start, dv.existing_window_end])
    if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return { r18_route: "clarify" };
  return {
    existing_slot_id: "",
    existing_new_date: "",
    existing_new_time: "",
    existing_current_check: "",
    existing_slots_snapshot: "[]",
    existing_readback: "",
    existing_approval: false,
    existing_approval_tuple: "",
    existing_attempt: "",
    existing_attempt_tuple: "",
    r18_route: "search",
  };
}
export function captureRescheduleAvailability(dv) {
  if (
    !selectedTargetValid(dv) ||
    !truth(dv.apero_response_received) ||
    truth(dv.apero_system_unavailable) ||
    !truth(dv.availability_success) ||
    !truth(dv.available)
  )
    throw Error("no_current_reschedule_availability");
  const current = validateSlots(dv, true);
  return {
    existing_current_check: current.check,
    existing_slots_snapshot: current.snapshot,
    r18_route: "offer",
  };
}
export function matchRescheduleSlot(dv) {
  if (!selectedTargetValid(dv)) return { r18_route: "select", existing_slot_id: "" };
  try {
    const current = validateSlots(dv, true);
    if (
      current.check !== dv.existing_current_check ||
      current.snapshot !== dv.existing_slots_snapshot
    )
      throw Error("stale");
    const s = chooseReturnedSlot(current.rows, dv);
    if (!s) return { r18_route: "clarify", existing_slot_id: "" };
    return {
      existing_slot_id: s.slot_id,
      existing_new_date: s.date,
      existing_new_time: s.time,
      r18_route: "readback",
    };
  } catch {
    return { existing_slot_id: "", r18_route: "search" };
  }
}
export function clearExistingTarget(dv) {
  return {
    operation_kind: "",
    existing_selected_id: "",
    existing_target_snapshot: "{}",
    existing_staff_id: "",
    existing_service: "",
    existing_start: "",
    existing_action: "",
    existing_readback: "",
    existing_approval: false,
    existing_approval_tuple: "",
    existing_attempt: "",
    existing_attempt_tuple: "",
    existing_attempt_target: "",
    existing_attempt_action: "",
    existing_slot_id: "",
    existing_slots_snapshot: "[]",
    existing_current_check: "",
    existing_new_date: "",
    existing_new_time: "",
    cancel_success: false,
    cancelled_id: "",
    reschedule_success: false,
    rescheduled_id: "",
    current_cancelled: false,
    current_rescheduled: false,
    existing_result_verified: false,
    r18_route: "done",
  };
}
