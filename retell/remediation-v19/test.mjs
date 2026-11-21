// Executes generated code nodes and graph conditions only. No network or agent SDK.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { build, allEdges } from "./build.mjs";
const root = new URL("./", import.meta.url),
  baseline = JSON.parse(fs.readFileSync(new URL("baseline-v17.json", root))),
  flow = JSON.parse(fs.readFileSync(new URL("candidate.json", root)));
const nodes = new Map(flow.nodes.map((n) => [n.id, n])),
  tools = new Map(flow.tools.map((t) => [t.name, t]));
const NOW = Date.parse("2099-01-01T09:00:00.000Z");
class Clock extends Date {
  static now() {
    return NOW;
  }
}
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stored = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]),
  );
function run(id, dv) {
  return vm.runInNewContext(
    `(function(){${nodes.get(id).code}})()`,
    { dv, JSON, Date: Clock, Math },
    { timeout: 1000 },
  );
}
function apply(dv, id) {
  const out = run(id, dv);
  for (const key of Object.keys(nodes.get(id).response_variables || {}))
    if (Object.hasOwn(out, key)) dv[key] = stored({ [key]: out[key] })[key];
  return out;
}
function resultMap(dv, tool, response) {
  for (const [key, path] of Object.entries(tools.get(tool).response_variables))
    if (Object.hasOwn(response, path)) dv[key] = stored({ [key]: response[path] })[key];
}
function seed() {
  return {
    ...flow.default_dynamic_variables,
    call_id: "offline-only",
    reset_attempt: "cycle",
    reset_verified_attempt: "cycle",
    reset_ready: "true",
    boundary_verified: "true",
    fresh_request_language: "English",
    client_name: "Ahmed",
    client_phone: "+96599123456",
    patient_confirmed: "true",
    patient_evidence: "Ahmed +96599123456",
    intake_name_cycle: "cycle",
    intake_name_evidence: "Ahmed",
    service_name: "Dental Cleaning",
    service_query: "Cleaning",
    resolve_success: "true",
    practitioner_mode: "any",
    practitioner_id: "",
    practitioner_name: "",
    practitioner_scope: "any",
    qualified_practitioners: JSON.stringify([
      { id: uid(1), name: "Doctor One" },
      { id: uid(2), name: "Doctor Two" },
    ]),
    search_mode: "earliest",
    requested_date: "",
    requested_time: "",
    window_start: "",
    window_end: "",
    active_booking_state: JSON.stringify({ cycle: "cycle", phase: "fresh" }),
    slot_choice_index: "",
    slot_choice_practitioner: "",
    slot_choice_unclear: "false",
  };
}
function slot(index, check = uid(10), person = uid(1), time) {
  const date = "2099-01-02";
  time ??= `${String(10 + index).padStart(2, "0")}:00`;
  const token = {
    c: uid(999),
    s: person,
    v: "Dental Cleaning",
    t: `${date}T${String(Number(time.slice(0, 2)) - 3).padStart(2, "0")}:00:00.000Z`,
    e: NOW + 600000,
    k: "offline-only",
    i: check,
    q: uid(100 + index),
    m: 45,
  };
  return {
    slot_id: Buffer.from(JSON.stringify(token)).toString("base64url") + ".OFFLINE-INERT-SIGNATURE",
    service_name: "Dental Cleaning",
    practitioner_id: person,
    practitioner_name: person === uid(1) ? "Doctor One" : "Doctor Two",
    date,
    time,
  };
}
function checked(count = 5) {
  const dv = seed();
  apply(dv, "node_r18_practitioner_scope");
  assert.equal(apply(dv, "node_guard_search").stage_ok, true);
  const slots = Array.from({ length: count }, (_, i) => slot(i));
  Object.assign(dv, {
    slots: JSON.stringify(slots),
    availability_success: "true",
    available: "true",
    apero_response_received: "true",
    apero_system_unavailable: "false",
  });
  apply(dv, "node_r18_capture_availability");
  return { dv, slots };
}
function selected(count = 5, index = 2) {
  const { dv, slots } = checked(count);
  Object.assign(dv, { slot_choice_time: slots[index].time, slot_choice_date: slots[index].date });
  assert.equal(apply(dv, "node_match_slot").slot_match_status, "matched");
  assert.equal(apply(dv, "node_guard_slot").stage_ok, true);
  assert.equal(apply(dv, "node_guard_patient").stage_ok, true);
  return { dv, slots };
}
function approved() {
  const { dv, slots } = selected();
  Object.assign(dv, { consent_confirmed: "true", consent_tuple: dv.booking_readback });
  assert.equal(apply(dv, "node_guard_book").stage_ok, true);
  return { dv, slots };
}
function existing(action = "cancel") {
  const dv = seed();
  apply(dv, "node_r18_existing_boundary");
  const rows = [
    {
      id: uid(30),
      staff_id: uid(1),
      service: "Dental Cleaning",
      start_time: "2099-02-01T10:00:00.000Z",
      end_time: "2099-02-01T10:45:00.000Z",
      status: "Booked",
    },
    {
      id: uid(31),
      staff_id: uid(1),
      service: "Dental Cleaning",
      start_time: "2099-03-01T10:00:00.000Z",
      end_time: "2099-03-01T10:45:00.000Z",
      status: "Booked",
    },
  ];
  Object.assign(dv, {
    lookup_success: "true",
    appointments: JSON.stringify(rows),
    apero_response_received: "true",
    apero_system_unavailable: "false",
  });
  apply(dv, "node_r18_lookup_snapshot");
  Object.assign(dv, {
    existing_choice_index: "1",
    existing_choice_action: action,
    existing_choice_unclear: "false",
  });
  assert.equal(apply(dv, "node_r18_existing_select").r18_route, action);
  if (action === "reschedule") {
    Object.assign(dv, {
      existing_search_mode: "date",
      existing_requested_date: "2099-01-02",
      existing_requested_time: "",
      existing_window_start: "",
      existing_window_end: "",
      reschedule_changes_service: "false",
      reschedule_changes_practitioner: "false",
    });
    assert.equal(apply(dv, "node_r18_reschedule_search_guard").r18_route, "search");
    const slots = [slot(0), slot(1), slot(2)];
    Object.assign(dv, {
      slots: JSON.stringify(slots),
      availability_success: "true",
      available: "true",
      apero_response_received: "true",
      apero_system_unavailable: "false",
    });
    apply(dv, "node_r18_reschedule_provenance");
    dv.slot_choice_time = slots[1].time;
    assert.equal(apply(dv, "node_r18_reschedule_slot_match").r18_route, "readback");
  }
  assert.equal(apply(dv, "node_r18_existing_readback").r18_route, action);
  dv.existing_approval = "true";
  dv.existing_approval_tuple = dv.existing_readback;
  assert.equal(apply(dv, "node_r18_existing_entry").r18_route, action);
  apply(dv, "node_r18_existing_fresh_prepare");
  resultMap(dv, "verify_selected_appointment", {
    success: true,
    appointments: rows,
    apero_response_received: true,
    system_unavailable: false,
  });
  assert.equal(apply(dv, "node_r18_existing_fresh_guard").r18_route, action);
  return { dv, rows };
}
function validResult(dv, action) {
  return action === "cancel"
    ? {
        success: true,
        appointment_cancelled: true,
        appointment_id: dv.existing_selected_id,
        apero_response_received: true,
        system_unavailable: false,
      }
    : {
        success: true,
        appointment_rescheduled: true,
        appointment_id: dv.existing_selected_id,
        staff_id: dv.existing_staff_id,
        service_name: dv.existing_service,
        start_time: JSON.parse(
          Buffer.from(dv.existing_slot_id.split(".")[0], "base64url").toString(),
        ).t,
        apero_response_received: true,
        system_unavailable: false,
      };
}
function match(e, dv) {
  const c = e.transition_condition;
  if (c.type !== "equation") return false;
  const value = (s) => String(s ?? "").replace(/{{([^}]+)}}/g, (_, k) => String(dv[k] ?? ""));
  const r = c.equations.map((q) =>
    q.operator === "=="
      ? value(q.left) === value(q.right)
      : q.operator === "!="
        ? value(q.left) !== value(q.right)
        : q.operator === "exists"
          ? !!value(q.left)
          : q.operator === ">"
            ? Number(value(q.left)) > Number(value(q.right))
            : false,
  );
  return c.operator === "||" ? r.some(Boolean) : r.every(Boolean);
}
function enabled(id, dv) {
  return (nodes.get(id).edges || []).filter((e) => match(e, dv)).map((e) => e.destination_node_id);
}

for (const count of [1, 2, 5])
  for (const index of [...new Set([0, Math.floor(count / 2), count - 1])])
    test(`H1 ${count} returned slots select index ${index + 1}`, () => {
      const { dv, slots } = checked(count);
      dv.slot_choice_time = slots[index].time;
      assert.equal(apply(dv, "node_match_slot").slot_match_status, "matched");
      assert.equal(dv.slot_id, slots[index].slot_id);
    });
test("H1 explicit ordinal #2/#3/last and same-time practitioner discrimination", () => {
  const { dv, slots } = checked(5);
  for (const i of [2, 3, 5]) {
    dv.slot_choice_index = String(i);
    dv.slot_choice_time = "";
    assert.equal(apply(dv, "node_match_slot").slot_match_status, "matched");
    assert.equal(dv.slot_id, slots[i - 1].slot_id);
  }
  const same = [slot(0, uid(10), uid(1), "15:00"), slot(1, uid(10), uid(2), "15:00")];
  Object.assign(dv, {
    slots: JSON.stringify(same),
    slot_choice_index: "",
    slot_choice_time: "15:00",
  });
  apply(dv, "node_r18_capture_availability");
  assert.equal(run("node_match_slot", dv).slot_match_status, "clarify");
  dv.slot_choice_practitioner = "Doctor Two";
  assert.equal(run("node_match_slot", dv).slot_id, same[1].slot_id);
});
test("H1 invented slot/ordinal rejected", () => {
  const { dv } = checked();
  dv.slot_choice_time = "23:59";
  assert.equal(run("node_match_slot", dv).slot_match_status, "clarify");
  dv.slot_choice_index = "999";
  assert.equal(run("node_match_slot", dv).slot_id, "");
});
test("H1 stale slot from previous request cannot match latest provenance", () => {
  const { dv, slots } = checked();
  const current = [slot(0, uid(20)), slot(1, uid(20))];
  dv.slots = JSON.stringify(current);
  apply(dv, "node_r18_capture_availability");
  dv.slots = JSON.stringify(slots);
  dv.slot_choice_time = slots[0].time;
  assert.notEqual(run("node_match_slot", dv).slot_match_status, "matched");
});
test("H1 mixed-check and expired tokens fail; same-query clarification keeps multi-slot result", () => {
  const { dv, slots } = checked();
  dv.correction_search_mode = "earliest";
  assert.equal(run("node_correction_guard", dv).correction_decision, "same");
  dv.slots = JSON.stringify([slots[0], slot(1, uid(20))]);
  assert.throws(() => run("node_r18_capture_availability", dv));
  const old = structuredClone(slots[0]);
  const t = JSON.parse(Buffer.from(old.slot_id.split(".")[0], "base64url").toString());
  t.e = NOW - 1;
  old.slot_id = Buffer.from(JSON.stringify(t)).toString("base64url") + ".OFFLINE";
  dv.slots = JSON.stringify([old]);
  assert.notEqual(run("node_match_slot", dv).slot_match_status, "matched");
});
test("H3 any scope uses backend mode sentinel; specific ID remains valid", () => {
  const any = seed();
  assert.equal(run("node_r18_practitioner_scope", any).practitioner_scope, "any");
  for (const value of [undefined, null, "any"])
    assert.throws(() => run("node_r18_practitioner_scope", { ...any, practitioner_id: value }));
  const specific = {
    ...any,
    practitioner_mode: "specific",
    practitioner_id: uid(1),
    practitioner_name: "Doctor One",
  };
  assert.equal(run("node_r18_practitioner_scope", specific).practitioner_scope, uid(1));
  assert.equal(
    tools.get("check_fresh_availability").parameters.properties.practitioner_mode.const,
    "{{practitioner_mode}}",
  );
});
for (const value of ["", null, undefined])
  test(`H3 missing concrete practitioner ${value} cannot enter creation`, () => {
    const { dv } = approved();
    dv.practitioner_id = value;
    assert.throws(() => run("node_intake_entry_node_book", dv));
    assert.throws(() => run("node_guard_book", dv));
  });
for (const fields of [
  { corrected_patient_name: "Ali", identity_correction_evidence: "My name is Ali" },
  {
    corrected_patient_phone: "+96599887766",
    identity_correction_evidence: "My phone is +96599887766",
  },
  {
    corrected_patient_name: "Ali",
    corrected_patient_phone: "+96599887766",
    identity_correction_evidence: "Ali +96599887766",
  },
])
  test("H2 selected-slot identity correction " + Object.keys(fields).join(","), () => {
    const { dv } = approved(),
      old = {
        slot: dv.slot_id,
        service: dv.service_name,
        person: dv.practitioner_id,
        check: dv.current_availability_check,
      };
    Object.assign(dv, {
      corrected_patient_name: "",
      corrected_patient_phone: "",
      identity_also_changes_schedule: "false",
      ...fields,
    });
    assert.equal(apply(dv, "node_r18_identity_apply").r18_route, "readback");
    assert.equal(dv.slot_id, old.slot);
    assert.equal(dv.service_name, old.service);
    assert.equal(dv.practitioner_id, old.person);
    assert.equal(dv.current_availability_check, old.check);
    assert.equal(dv.consent_confirmed, "false");
    assert.equal(apply(dv, "node_guard_patient").stage_ok, true);
    assert.equal(run("node_guard_book", dv).stage_ok, false);
    dv.reset_ready = "true";
    dv.consent_confirmed = "true";
    dv.consent_tuple = dv.booking_readback;
    assert.equal(apply(dv, "node_guard_book").stage_ok, true);
    assert.equal(run("node_intake_entry_node_book", dv).intake_entry_ok, true);
    assert.equal(dv.client_name, fields.corrected_patient_name || "Ahmed");
    assert.equal(dv.client_phone, fields.corrected_patient_phone || "+96599123456");
  });
test("H2 identity edits at intake/search have exits without rechecking availability", () => {
  for (const [factory, expected] of [
    [seed, "intake"],
    [() => checked().dv, "offer"],
  ]) {
    const dv = factory();
    Object.assign(dv, {
      corrected_patient_name: "Ali",
      corrected_patient_phone: "",
      identity_correction_evidence: "Ali",
      identity_also_changes_schedule: "false",
    });
    assert.equal(run("node_r18_identity_apply", dv).r18_route, expected);
  }
});
test("C3 reserve before creation; uncertain/no-retry locks a second call even for another slot/reset/type", () => {
  const { dv, slots } = approved();
  apply(dv, "node_intake_entry_node_book");
  assert.equal(dv.booking_reconciliation_required, "true");
  resultMap(dv, "book_appointment", {
    success: false,
    appointment_booked: false,
    appointment_id: null,
    retry_allowed: false,
    follow_up_saved: true,
    error_type: "booking_timeout",
    apero_response_received: true,
    system_unavailable: false,
  });
  assert.equal(apply(dv, "node_r18_booking_result").booking_result_verified, false);
  assert.equal(dv.booking_reconciliation_required, "true");
  assert.throws(() => run("node_intake_entry_node_book", dv));
  dv.slot_id = slots[4].slot_id;
  assert.throws(() => run("node_intake_entry_node_book", dv));
  assert.equal(run("node_r18_new_booking_gate", dv).r18_route, "locked");
  apply(dv, "node_reset_prepare");
  assert.equal(dv.booking_reconciliation_required, "true");
  apply(dv, "node_r18_existing_boundary");
  assert.equal(dv.booking_reconciliation_required, "true");
  assert.equal(run("node_r18_new_booking_gate", dv).r18_route, "locked");
  assert.equal(
    nodes
      .get("node_book_failed")
      .edges.some(
        (e) =>
          e.destination_node_id.includes("invalidate") || e.destination_node_id.includes("reset"),
      ),
    false,
  );
});
test("C3 valid current verified success unlocks and confirms normally", () => {
  const { dv } = approved();
  apply(dv, "node_intake_entry_node_book");
  resultMap(dv, "book_appointment", {
    success: true,
    appointment_booked: true,
    appointment_id: uid(88),
    apero_response_received: true,
    system_unavailable: false,
  });
  assert.equal(apply(dv, "node_r18_booking_result").booking_result_verified, true);
  assert.equal(dv.booking_reconciliation_required, "false");
  assert.ok(enabled("node_r18_booking_result", dv).includes("node_booked"));
});
for (const response of [
  { success: true },
  { success: false },
  { success: true, appointment_booked: true, appointment_id: null },
  { success: true, appointment_booked: true, appointment_id: "invalid" },
  {},
])
  test("C3 malformed/failed booking cannot unlock " + JSON.stringify(response), () => {
    const { dv } = approved();
    apply(dv, "node_intake_entry_node_book");
    apply(dv, "node_downtime_prepare_node_book");
    resultMap(dv, "book_appointment", {
      ...response,
      apero_response_received: true,
      system_unavailable: false,
    });
    assert.equal(run("node_r18_booking_result", dv).booking_result_verified, false);
    assert.equal(dv.booking_reconciliation_required, "true");
  });

for (const action of ["cancel", "reschedule"]) {
  test(
    "C1 " + action + " selected target and approval bound; injected arbitrary model ID irrelevant",
    () => {
      const { dv, rows } = existing(action);
      assert.equal(dv.existing_selected_id, rows[0].id);
      assert.equal(
        tools.get(action === "cancel" ? "cancel_appointment" : "reschedule_appointment").parameters
          .properties.appointment_id.const,
        "{{existing_selected_id}}",
      );
      dv.appointment_id = rows[1].id;
      assert.equal(
        run("node_r18_entry_node_" + (action === "cancel" ? "cancel_tool" : "reschedule_tool"), dv)
          .r18_route,
        "execute",
      );
      dv.existing_selected_id = rows[1].id;
      assert.throws(() =>
        run("node_r18_entry_node_" + (action === "cancel" ? "cancel_tool" : "reschedule_tool"), dv),
      );
    },
  );
  test(
    "C1 " +
      action +
      " reselecting B clears old approval/slot/attempt; ambiguous target cannot mutate",
    () => {
      const { dv } = existing(action);
      dv.existing_choice_index = "2";
      apply(dv, "node_r18_existing_select");
      assert.equal(dv.existing_approval, "false");
      assert.equal(dv.existing_approval_tuple, "");
      assert.equal(run("node_r18_existing_entry", dv).r18_route, "select");
      dv.existing_choice_index = "999";
      apply(dv, "node_r18_existing_select");
      assert.equal(dv.existing_selected_id, "");
    },
  );
  for (const variant of [
    action === "cancel" ? "node_cancel_tool" : "node_reschedule_tool",
    action === "cancel" ? "node_cancel_tool_arabic_wait" : "node_reschedule_tool_arabic_wait",
  ])
    for (const scenario of [
      "previous-success-current-failure",
      "previous-id-success-only",
      "failure",
      "timeout",
      "malformed",
      "valid",
      "wrong-target",
      "wrong-operation",
    ])
      test("C2 " + variant + " " + scenario, () => {
        const { dv } = existing(action);
        Object.assign(dv, {
          cancel_success: "true",
          cancelled_id: uid(99),
          reschedule_success: "true",
          rescheduled_id: uid(99),
          current_cancelled: "true",
          current_rescheduled: "true",
        });
        apply(dv, "node_downtime_prepare_" + variant);
        assert.equal(dv.cancel_success, "false");
        assert.equal(dv.cancelled_id, "");
        assert.equal(dv.reschedule_success, "false");
        assert.equal(dv.rescheduled_id, "");
        const response =
          scenario === "valid"
            ? validResult(dv, action)
            : scenario === "wrong-target"
              ? { ...validResult(dv, action), appointment_id: uid(99) }
              : scenario === "wrong-operation"
                ? {
                    success: true,
                    appointment_booked: true,
                    appointment_id: dv.existing_selected_id,
                    apero_response_received: true,
                  }
                : scenario === "previous-id-success-only"
                  ? { success: true, apero_response_received: true }
                  : scenario === "timeout"
                    ? {}
                    : scenario === "malformed"
                      ? { garbage: true, apero_response_received: true }
                      : {
                          success: false,
                          error_type: "invalid_request",
                          apero_response_received: true,
                        };
        resultMap(
          dv,
          action === "cancel" ? "cancel_appointment" : "reschedule_appointment",
          response,
        );
        assert.equal(
          run("node_r18_existing_result", dv).existing_result_verified,
          scenario === "valid",
        );
      });
}
test("H4 date/time-only reschedule preserves original service/practitioner at every bound argument", () => {
  const { dv } = existing("reschedule"),
    tool = tools.get("check_availability");
  assert.equal(tool.parameters.properties.practitioner_mode.const, "specific");
  assert.equal(tool.parameters.properties.practitioner_id.const, "{{existing_staff_id}}");
  assert.equal(tool.parameters.properties.service_name.const, "{{existing_service}}");
  assert.equal(tool.parameters.properties.appointment_id.const, "{{existing_selected_id}}");
  for (const key of ["reschedule_changes_service", "reschedule_changes_practitioner"]) {
    dv[key] = "true";
    assert.equal(run("node_r18_reschedule_search_guard", dv).r18_route, "unsupported");
    dv[key] = "false";
  }
  dv.service_name = "Different";
  dv.practitioner_id = uid(2);
  assert.equal(
    tools.get("reschedule_appointment").parameters.properties.service_name.const,
    "{{existing_service}}",
  );
  assert.equal(
    tools.get("reschedule_appointment").parameters.properties.practitioner_id.const,
    "{{existing_staff_id}}",
  );
});
test("state isolation: boundary clears cross-operation IDs/results/consent, preserves patient and reconciliation lock", () => {
  const dv = {
    ...seed(),
    booking_id: uid(77),
    booking_success: "true",
    appointment_booked: "true",
    cancelled_id: uid(78),
    cancel_success: "true",
    rescheduled_id: uid(79),
    reschedule_success: "true",
    consent_confirmed: "true",
    existing_approval: "true",
    existing_approval_tuple: "OLD",
    existing_attempt: "OLD",
    slot_id: "OLD",
    current_availability_check: "OLD",
    booking_reconciliation_required: "true",
  };
  apply(dv, "node_r18_existing_boundary");
  for (const key of [
    "booking_id",
    "cancelled_id",
    "rescheduled_id",
    "slot_id",
    "consent_tuple",
    "existing_approval_tuple",
    "existing_attempt",
    "current_availability_check",
  ])
    assert.equal(dv[key], "", key);
  for (const key of [
    "booking_success",
    "cancel_success",
    "reschedule_success",
    "consent_confirmed",
    "existing_approval",
  ])
    assert.equal(dv[key], "false", key);
  assert.equal(dv.client_name, "Ahmed");
  assert.equal(dv.client_phone, "+96599123456");
  assert.equal(dv.booking_reconciliation_required, "true");
  assert.equal(run("node_r18_existing_result", dv).existing_result_verified, false);
});
test("state isolation: booking cannot cancel; cancellation cannot report reschedule success", () => {
  const { dv } = existing("cancel");
  resultMap(dv, "cancel_appointment", {
    success: true,
    appointment_booked: true,
    appointment_id: dv.existing_selected_id,
    apero_response_received: true,
  });
  assert.equal(run("node_r18_existing_result", dv).existing_result_verified, false);
  const moved = existing("reschedule").dv;
  resultMap(moved, "reschedule_appointment", {
    success: true,
    appointment_cancelled: true,
    appointment_id: moved.existing_selected_id,
    apero_response_received: true,
  });
  assert.equal(run("node_r18_existing_result", moved).existing_result_verified, false);
});
test("build deterministic/idempotent; code compiles and every graph reference valid", () => {
  assert.equal(JSON.stringify(build(baseline)), JSON.stringify(flow));
  assert.equal(JSON.stringify(build(flow)), JSON.stringify(flow));
  assert.equal(nodes.size, flow.nodes.length);
  const ids = new Set();
  for (const n of flow.nodes) {
    if (n.code) {
      new vm.Script(`(function(){${n.code}})()`);
      assert.ok(n.code.length <= 20000, n.id);
    }
    if (n.tool_id) assert.ok(flow.tools.some((t) => t.tool_id === n.tool_id));
    for (const e of allEdges(n)) {
      assert.ok(nodes.has(e.destination_node_id), n.id + " → " + e.destination_node_id);
      assert.ok(!ids.has(e.id), e.id);
      ids.add(e.id);
    }
  }
});
test("static re-audit: all mutation paths have their required code guards and result validators", () => {
  const reach = (start, removed = new Set()) => {
    const q = [start],
      seen = new Set();
    while (q.length) {
      const id = q.pop();
      if (seen.has(id) || removed.has(id)) continue;
      seen.add(id);
      q.push(...allEdges(nodes.get(id)).map((e) => e.destination_node_id));
    }
    return seen;
  };
  const roots = [
    flow.start_node_id,
    ...flow.nodes.filter((n) => n.global_node_setting).map((n) => n.id),
  ];
  // Identity correction legitimately skips already completed service/search stages.
  // A plain graph ignores phase predicates. Prove unavoidable hard entry guards from
  // every global root; phase/data provenance is checked by generated-code fixtures.
  for (const target of ["node_book", "node_book_arabic_wait"])
    for (const gate of [
      "node_guard_patient",
      "node_final",
      "node_capture_consent",
      "node_guard_book",
      target === "node_book"
        ? "node_intake_entry_node_book"
        : "node_intake_entry_node_book_arabic_wait",
    ])
      for (const root of roots)
        assert.equal(
          reach(root, new Set([gate])).has(target),
          false,
          `${root} bypass ${gate} to ${target}`,
        );
  for (const target of [
    "node_cancel_tool",
    "node_cancel_tool_arabic_wait",
    "node_reschedule_tool",
    "node_reschedule_tool_arabic_wait",
  ])
    for (const gate of [
      "node_r18_lookup_snapshot",
      "node_r18_existing_select",
      "node_r18_existing_readback",
      "node_r18_existing_approval",
      "node_r18_existing_entry",
      "node_r18_entry_" + target,
    ]) {
      const sources = [
        "node_r18_existing_approval",
        "node_r18_existing_entry",
        "node_r18_entry_" + target,
      ].includes(gate)
        ? roots
        : [flow.start_node_id];
      for (const root of sources)
        assert.equal(
          reach(root, new Set([gate])).has(target),
          false,
          `${root} bypass ${gate} to ${target}`,
        );
    }
  for (const [success, validator] of [
    ["node_booked", "node_r18_booking_result"],
    ["node_cancelled", "node_r18_existing_result"],
    ["node_rescheduled", "node_r18_existing_result"],
  ])
    for (const root of roots)
      assert.equal(
        reach(root, new Set([validator])).has(success),
        false,
        success + " bypasses current result validation",
      );
  assert.equal(
    nodes.get("node_date_time").edges.some((e) => e.destination_node_id === "node_capture_search"),
    true,
  );
  for (const variable of [
    "current_availability_check",
    "current_availability_snapshot",
    "existing_selected_id",
  ]) {
    for (const n of flow.nodes.filter((n) => n.type === "extract_dynamic_variables"))
      assert.equal(
        n.variables.some((v) => v.name === variable),
        false,
        "model extractor cannot write " + variable,
      );
  }
});
test("existing specific safety paths/tools and agent-independent settings preserved", () => {
  for (const old of baseline.nodes.filter((n) =>
    /^(node_(unknown|human|transfer|system_downtime|downtime_clear)|node_global_(human|urgent)|node_calendar_(unavailable|collect|save|saved|save_failed)$)/.test(
      n.id,
    ),
  ))
    assert.deepEqual(nodes.get(old.id), old, old.id);
  for (const old of baseline.tools.filter(
    (t) =>
      ![
        "check_availability",
        "book_appointment",
        "cancel_appointment",
        "reschedule_appointment",
        "lookup_appointments",
      ].includes(t.name),
  ))
    assert.deepEqual(tools.get(old.name), old, old.name);
  for (const key of [
    "knowledge_base_ids",
    "kb_config",
    "model_config",
    "start_node_id",
    "start_speaker",
  ])
    assert.deepEqual(flow[key], baseline[key]);
});
test("H2 stale identity candidates are cleared, and a fully known intake returns directly to time", () => {
  const dv = seed();
  Object.assign(dv, {
    corrected_patient_name: "Old edit",
    corrected_patient_phone: "+96590000000",
    identity_correction_evidence: "Old edit +96590000000",
  });
  apply(dv, "node_r18_identity_prepare");
  assert.equal(dv.corrected_patient_name, "");
  assert.equal(dv.corrected_patient_phone, "");
  Object.assign(dv, {
    corrected_patient_phone: "+96599887766",
    identity_correction_evidence: "+96599887766",
  });
  assert.equal(apply(dv, "node_r18_identity_apply").r18_route, "intake");
  assert.equal(apply(dv, "node_intake_before_time").intake_route, "date");
  assert.equal(dv.client_name, "Ahmed");
});
test("C1/C2 operation-kind mismatch and old approval cannot dispatch a different feature", () => {
  const { dv } = existing("cancel");
  assert.throws(() => run("node_r18_entry_node_reschedule_tool", dv));
  const original = dv.existing_approval_tuple;
  dv.existing_choice_index = "2";
  apply(dv, "node_r18_existing_select");
  dv.existing_approval = "true";
  dv.existing_approval_tuple = original;
  assert.notEqual(run("node_r18_existing_entry", dv).r18_route, "cancel");
  apply(dv, "node_r18_existing_abandon");
  assert.equal(dv.operation_kind, "");
  assert.equal(dv.existing_selected_id, "");
  assert.equal(dv.existing_attempt, "");
});
test("every required creation field is independently blocked at English and Arabic entry", () => {
  for (const entry of ["node_intake_entry_node_book", "node_intake_entry_node_book_arabic_wait"])
    for (const field of [
      "slot_id",
      "client_name",
      "client_phone",
      "service_name",
      "practitioner_id",
      "appointment_date",
      "appointment_time",
    ])
      for (const value of ["", null, undefined]) {
        const { dv } = approved();
        dv[field] = value;
        assert.throws(() => run(entry, dv), entry + " requires " + field);
      }
});
test("C3 transport timeout cannot unlock and any new-cycle/success-for-other-tuple is rejected", () => {
  const { dv, slots } = approved();
  apply(dv, "node_intake_entry_node_book");
  apply(dv, "node_downtime_prepare_node_book");
  assert.equal(run("node_r18_booking_result", dv).booking_result_verified, false);
  assert.equal(run("node_r18_new_booking_gate", dv).r18_route, "locked");
  resultMap(dv, "book_appointment", {
    success: true,
    appointment_booked: true,
    appointment_id: uid(88),
    apero_response_received: true,
    system_unavailable: false,
  });
  dv.slot_id = slots[4].slot_id;
  assert.equal(run("node_r18_booking_result", dv).booking_result_verified, false);
});
test("specific-practitioner normal booking passes selected-slot, consent and current success validation", () => {
  const dv = {
    ...seed(),
    practitioner_mode: "specific",
    practitioner_id: uid(1),
    practitioner_name: "Doctor One",
  };
  apply(dv, "node_r18_practitioner_scope");
  assert.equal(apply(dv, "node_guard_search").stage_ok, true);
  const slots = [slot(0), slot(1)];
  Object.assign(dv, {
    slots: JSON.stringify(slots),
    availability_success: "true",
    available: "true",
    apero_response_received: "true",
    apero_system_unavailable: "false",
    slot_choice_time: slots[1].time,
  });
  apply(dv, "node_r18_capture_availability");
  assert.equal(apply(dv, "node_match_slot").slot_match_status, "matched");
  apply(dv, "node_guard_slot");
  apply(dv, "node_guard_patient");
  dv.consent_confirmed = "true";
  dv.consent_tuple = dv.booking_readback;
  assert.equal(apply(dv, "node_guard_book").stage_ok, true);
  apply(dv, "node_intake_entry_node_book");
  apply(dv, "node_downtime_prepare_node_book");
  resultMap(dv, "book_appointment", {
    success: true,
    appointment_booked: true,
    appointment_id: uid(88),
    apero_response_received: true,
    system_unavailable: false,
  });
  assert.equal(run("node_r18_booking_result", dv).booking_result_verified, true);
});
test("name-first intake and missing-field order survive the remediation", () => {
  const dv = seed();
  Object.assign(dv, {
    client_name: "",
    intake_name_evidence: "",
    intake_name_cycle: "",
    resolve_success: "false",
    client_phone: "",
    patient_confirmed: "false",
    patient_evidence: "",
  });
  assert.equal(run("node_intake_name_gate", dv).intake_route, "name");
  dv.client_name = "Ahmed";
  dv.intake_name_evidence = "I am Ahmed";
  apply(dv, "node_intake_name_gate");
  assert.equal(dv.intake_route, "service");
  dv.resolve_success = "true";
  dv.practitioner_mode = "";
  assert.equal(run("node_intake_before_time", dv).intake_route, "doctor");
  dv.practitioner_mode = "any";
  assert.equal(run("node_intake_before_time", dv).intake_route, "contact");
  dv.client_phone = "+96599123456";
  dv.patient_confirmed = "true";
  dv.patient_evidence = "Ahmed +96599123456";
  assert.equal(run("node_intake_before_time", dv).intake_route, "date");
});
test("creation result IDs and all response state clear before both language variants", () => {
  for (const id of ["node_book", "node_book_arabic_wait"]) {
    const { dv } = approved();
    apply(dv, "node_intake_entry_node_book");
    Object.assign(dv, {
      booking_success: "true",
      appointment_booked: "true",
      booking_id: uid(98),
      booking_result_verified: "true",
    });
    apply(dv, "node_downtime_prepare_" + id);
    assert.equal(dv.booking_id, "");
    assert.equal(dv.booking_result_verified, "false");
    resultMap(dv, "book_appointment", {
      success: true,
      appointment_booked: true,
      apero_response_received: true,
      system_unavailable: false,
    });
    assert.equal(run("node_r18_booking_result", dv).booking_result_verified, false);
  }
});
for (const action of ["cancel", "reschedule"])
  test("C1 stale/removed " + action + " target requires selection instead of mutation", () => {
    for (const change of ["moved", "removed", "different-service", "different-practitioner"]) {
      const { dv, rows } = existing(action);
      const next = structuredClone(rows);
      if (change === "moved") next[0].start_time = "2099-05-01T10:00:00.000Z";
      if (change === "removed") next.shift();
      if (change === "different-service") next[0].service = "Consultation";
      if (change === "different-practitioner") next[0].staff_id = uid(2);
      apply(dv, "node_r18_existing_fresh_prepare");
      resultMap(dv, "verify_selected_appointment", {
        success: true,
        appointments: next,
        apero_response_received: true,
        system_unavailable: false,
      });
      assert.equal(apply(dv, "node_r18_existing_fresh_guard").r18_route, "select");
      assert.equal(dv.existing_selected_id, "");
      assert.equal(dv.existing_approval, "false");
      assert.throws(() =>
        run("node_r18_entry_node_" + (action === "cancel" ? "cancel_tool" : "reschedule_tool"), dv),
      );
    }
  });
