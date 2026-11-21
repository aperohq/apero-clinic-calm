// Offline deterministic code/transition fixtures. No conversational model or API.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { build, allEdges } from "./build.mjs";
const before = JSON.parse(
    fs.readFileSync(new URL("../remediation-v19/candidate.json", import.meta.url)),
  ),
  flow = build(before),
  nodes = new Map(flow.nodes.map((n) => [n.id, n]));
const stored = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));
function apply(dv, id) {
  const n = nodes.get(id);
  try {
    const out = vm.runInNewContext(
      `(function(){${n.code}})()`,
      { dv, JSON, Date, Math },
      { timeout: 1000 },
    );
    for (const [k, path] of Object.entries(n.response_variables || {}))
      if (Object.hasOwn(out, path) && out[path] !== null) dv[k] = stored(out[path]);
    if (n.execution_status_variable) dv[n.execution_status_variable] = "success";
    return out;
  } catch (e) {
    if (n.execution_status_variable) dv[n.execution_status_variable] = "failure";
    throw e;
  }
}
function next(id, dv) {
  const n = nodes.get(id),
    value = (s) => String(s ?? "").replace(/{{([^}]+)}}/g, (_, k) => String(dv[k] ?? ""));
  return (
    (n.edges || []).find((e) => {
      const c = e.transition_condition;
      if (c.type === "prompt") return c.prompt === "Always";
      const matches = c.equations.map((q) =>
        q.operator === "=="
          ? value(q.left) === value(q.right)
          : q.operator === "!="
            ? value(q.left) !== value(q.right)
            : false,
      );
      return c.operator === "||" ? matches.some(Boolean) : matches.every(Boolean);
    })?.destination_node_id || n.else_edge?.destination_node_id
  );
}
function initialize(input = {}) {
  const dv = { fresh_request_language: "English", ...input };
  apply(dv, "node_reset_prepare");
  assert.equal(next("node_reset_prepare", dv), "node_fresh_request");
  assert.equal(next("node_fresh_request", dv), "node_reset_language_gate");
  apply(dv, "node_reset_language_gate");
  assert.equal(next("node_reset_language_gate", dv), "node_reset_verify");
  apply(dv, "node_reset_verify");
  assert.equal(dv.reset_ready, "true", dv.reset_error);
  assert.equal(next("node_reset_verify", dv), "node_intake_name_capture");
  apply(dv, "node_intake_name_gate_clear");
  apply(dv, "node_intake_name_gate");
  assert.equal(next("node_intake_name_gate", dv), "node_intake_name");
  return dv;
}
for (const state of [
  {},
  Object.fromEntries(
    Object.keys(before.default_dynamic_variables)
      .filter((k) => !k.startsWith("clinic_"))
      .map((k) => [k, null]),
  ),
])
  test("1 fresh absent/null booking state reaches Name without deletion or caller metadata", () => {
    const dv = initialize({ ...state, fresh_request_language: "English" });
    assert.equal(dv.slot_id, "");
    assert.equal(dv.slots, "[]");
    assert.equal(dv.consent_confirmed, "false");
  });
test("2 completed booking cleans active state and preserves completed history and context", () => {
  const dv = initialize({
    booking_success: "true",
    booking_id: "completed-offline",
    appointment_booked: "true",
    slot_id: "old",
    slots: '["old"]',
    current_availability_check: "old-check",
    current_availability_snapshot: '["old"]',
    consent_confirmed: "true",
    consent_tuple: "old",
    booking_attempt_tuple: "old",
    booking_result_verified: "true",
    call_id: "trusted-offline",
    caller_phone: "trusted-context",
    caller_name: "Caller",
    clinic_id: "clinic-offline",
  });
  assert.equal(
    JSON.parse(dv.historical_completed_appointments)[0].appointment_id,
    "completed-offline",
  );
  for (const k of [
    "slot_id",
    "current_availability_check",
    "booking_id",
    "booking_attempt_tuple",
    "consent_tuple",
  ])
    assert.equal(dv[k], "");
  assert.equal(dv.call_id, "trusted-offline");
  assert.equal(dv.caller_phone, "trusted-context");
  assert.equal(dv.clinic_id, "clinic-offline");
  assert.equal(dv.fresh_request_language, "English");
});
test("3 prior safely failed state resets; empty/null history accepted", () => {
  for (const history of [undefined, null, "", "null", "[]"]) {
    const dv = initialize({
      booking_reconciliation_required: "false",
      booking_error_type: "safe_failure",
      booking_success: "false",
      historical_completed_appointments: history,
      booking_follow_up_id: "old",
      booking_retry_allowed: "true",
    });
    assert.equal(dv.booking_error_type, "");
    assert.equal(dv.booking_retry_allowed, "false");
    assert.equal(dv.booking_follow_up_id, "");
  }
});
test("4 unresolved/no-retry safety lock survives initialization and cannot reach Name/create", () => {
  for (const lock of [true, "true"]) {
    const dv = {
      booking_reconciliation_required: lock,
      booking_attempt_tuple: "must-reconcile",
      slot_id: "unresolved",
    };
    apply(dv, "node_reset_prepare");
    assert.equal(next("node_reset_prepare", dv), "node_book_failed");
    assert.equal(dv.booking_reconciliation_required, lock);
    assert.equal(dv.booking_attempt_tuple, "must-reconcile");
    assert.equal(dv.reset_ready, "false");
    assert.equal(dv.boundary_verified, "false");
    apply(dv, "node_r18_new_booking_gate");
    assert.equal(dv.r18_route, "locked");
  }
});
test("5 prior cancellation/reschedule targets, results and approvals cannot survive new booking", () => {
  const dv = initialize({
    action: "cancel",
    operation_kind: "reschedule",
    existing_selected_id: "old-target",
    existing_approval: "true",
    existing_attempt: "old-operation",
    existing_fresh_attempt: "old-fresh",
    cancel_success: "true",
    cancelled_id: "old-cancel",
    reschedule_success: "true",
    rescheduled_id: "old-reschedule",
    existing_target_snapshot: '{"id":"old"}',
    existing_target_fresh: "true",
  });
  for (const k of [
    "action",
    "existing_selected_id",
    "existing_attempt",
    "existing_fresh_attempt",
    "cancelled_id",
    "rescheduled_id",
  ])
    assert.equal(dv[k], "");
  for (const k of [
    "existing_approval",
    "cancel_success",
    "reschedule_success",
    "existing_target_fresh",
  ])
    assert.equal(dv[k], "false");
  assert.equal(dv.operation_kind, "book");
});
test("6 missing Try a Call metadata does not require fictional identity or external reset", () => {
  const dv = initialize();
  assert.equal(dv.call_id, undefined);
  assert.equal(dv.caller_phone, undefined);
  assert.equal(dv.availability_invalidated, "false");
  assert.equal(dv.boundary_verified, "true");
});
test("7 corrupt nonempty history or failed code execution remains exceptional reset failure", () => {
  const dv = { historical_completed_appointments: "malformed", fresh_request_language: "English" };
  apply(dv, "node_reset_prepare");
  assert.equal(next("node_reset_prepare", dv), "node_reset_failed");
  assert.equal(dv.reset_error, "invalid_completed_history");
  assert.equal(
    next("node_reset_prepare", {
      reset_prepared: "true",
      reset_ready: "false",
      fresh_reset_execution: "failure",
    }),
    "node_reset_failed",
  );
  assert.equal(
    next("node_reset_verify", {
      reset_ready: "true",
      reset_attempt: "old",
      reset_verified_attempt: "old",
      fresh_verify_execution: "failure",
    }),
    "node_reset_failed",
  );
});
test("local verification detects stale slots/consent and does not accept a stale cycle", () => {
  for (const [key, value] of [
    ["slot_id", "old-slot"],
    ["current_availability_check", "old-check"],
    ["consent_confirmed", "true"],
    ["existing_selected_id", "old-target"],
  ]) {
    const dv = { fresh_request_language: "English" };
    apply(dv, "node_reset_prepare");
    dv[key] = value;
    apply(dv, "node_reset_verify");
    assert.equal(dv.reset_ready, "false", key);
    assert.equal(next("node_reset_verify", dv), "node_reset_failed");
  }
  const dv = { fresh_request_language: "English" };
  apply(dv, "node_reset_prepare");
  dv.fresh_reset_cycle = "old";
  apply(dv, "node_reset_verify");
  assert.equal(dv.reset_error, "local_initialization_not_confirmed");
});
test("generic retry and missing enrichment cannot fail initialization; explicit current known details retained", () => {
  const dv = initialize();
  assert.equal(dv.fresh_request_present, "false");
  const nextState = { fresh_request_language: "Arabic" };
  apply(nextState, "node_reset_prepare");
  nextState.fresh_request_summary = "CURRENT explicit patient/service/date";
  nextState.fresh_request_present = "true";
  apply(nextState, "node_reset_verify");
  assert.equal(nextState.reset_ready, "true");
  assert.equal(nextState.fresh_request_summary, "CURRENT explicit patient/service/date");
  assert.equal(nextState.fresh_request_language, "Arabic");
});
function intake() {
  const dv = initialize();
  Object.assign(dv, {
    client_name: "Ahmed",
    intake_name_cycle: dv.reset_attempt,
    intake_name_evidence: "Ahmed",
    client_phone: "+96599123456",
    patient_confirmed: "true",
    patient_evidence: "Ahmed +96599123456",
    resolve_success: "true",
    service_name: "Dental Cleaning",
    qualified_practitioners: '[{"id":"offline-doctor"}]',
    practitioner_mode: "any",
    practitioner_scope: "any",
    practitioner_id: "",
    practitioner_name: "",
    search_mode: "exact",
    requested_date: "",
  });
  return dv;
}
test("observed date_missing reproducer returns to Date/Time, preserves initialized cycle and blocks availability", () => {
  const dv = intake(),
    cycle = dv.reset_attempt;
  apply(dv, "node_guard_search_clear_result");
  apply(dv, "node_guard_search");
  assert.equal(next("node_guard_search", dv), "node_date_time");
  assert.equal(dv.stage_ok, "false");
  assert.equal(dv.reset_ready, "true");
  assert.equal(dv.reset_attempt, cycle);
  dv.requested_date = "2099-01-02";
  apply(dv, "node_guard_search_clear_result");
  apply(dv, "node_guard_search");
  assert.equal(dv.stage_ok, "true");
  assert.equal(next("node_guard_search", dv), "node_check_wait_language_gate");
});
test("missing search mode clarifies; missing intake returns existing intake route; broken cycle fails closed", () => {
  for (const edit of [
    { search_mode: "" },
    { client_name: "" },
    { reset_verified_attempt: "stale" },
  ]) {
    const dv = intake();
    Object.assign(dv, edit);
    apply(dv, "node_guard_search_clear_result");
    apply(dv, "node_guard_search");
    assert.equal(
      next("node_guard_search", dv),
      edit.search_mode === ""
        ? "node_date_time"
        : edit.client_name === ""
          ? "node_intake_name_gate_clear"
          : "node_reset_failed",
    );
  }
});
test("failed availability-input code cannot reuse old missing-date routing result", () => {
  const dv = intake();
  dv.reset_error = "date_or_search_missing";
  apply(dv, "node_guard_search_clear_result");
  assert.equal(next("node_guard_search", dv), "node_reset_failed");
});
test("only seven reset/direct-recovery nodes change; every tool, global prompt, other node and setting identical", () => {
  const changed = before.nodes
    .filter((n) => JSON.stringify(n) !== JSON.stringify(nodes.get(n.id)))
    .map((n) => n.id)
    .sort();
  assert.deepEqual(
    changed,
    [
      "node_reset_prepare",
      "node_fresh_request",
      "node_reset_verify",
      "node_reset_language_gate",
      "node_reset_language_capture",
      "node_guard_search",
      "node_guard_search_clear_result",
    ].sort(),
  );
  for (const key of Object.keys(before).filter((k) => k !== "nodes"))
    assert.deepEqual(flow[key], before[key]);
  assert.deepEqual(build(flow), flow);
  for (const n of flow.nodes) {
    if (n.code) {
      new vm.Script(`(function(){${n.code}})()`);
      assert.ok(n.code.length <= 20000, n.id);
    }
    for (const e of allEdges(n)) assert.ok(nodes.has(e.destination_node_id));
  }
});
