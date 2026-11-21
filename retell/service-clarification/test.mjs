// Deterministic code/graph fixtures only. No conversations, API calls or paid tools.
import fs from "node:fs";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { build, allEdges } from "./build.mjs";
const root = new URL("./", import.meta.url),
  baseline = JSON.parse(fs.readFileSync(new URL("baseline-v21.json", root))),
  f = build(baseline),
  nodes = new Map(f.nodes.map((n) => [n.id, n]));
const logic = stripTypeScriptTypes(
  fs.readFileSync(new URL("../../supabase/functions/clinic-operations/logic.ts", root), "utf8"),
);
const { resolveService } = await import(
  "data:text/javascript;base64," + Buffer.from(logic).toString("base64")
);
const configured = fs.readFileSync(new URL("../../db/05_voice_integrations.sql", root), "utf8");
const aliases = {};
for (const m of configured.matchAll(
  /'11111111-1111-4111-8111-111111111111', '([^']+)', '([^']+)'/g,
))
  (aliases[m[1]] ??= []).push(m[2]);
const staff = [
  {
    id: "fixture",
    full_name: "Fixture",
    specialty: "Fixture",
    services: Object.keys(aliases),
    aliases: [],
  },
];
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log("PASS " + name);
};
const run = (id, dv) => new Function("dv", nodes.get(id).code)(structuredClone(dv));
const seed = {
  reset_ready: "true",
  boundary_verified: "true",
  reset_attempt: "cycle-a",
  reset_verified_attempt: "cycle-a",
  active_booking_state: '{"cycle":"cycle-a"}',
  client_name: "Fixture Patient",
  intake_name_cycle: "cycle-a",
  service_clarification_cycle: "cycle-a",
  service_clarification_attempts: "0",
  service_clarification_used: "false",
};
const resolved = {
  ...seed,
  resolve_success: "true",
  service_name: "Dental Cleaning",
  qualified_practitioners:
    '[{"id":"aaaaaaaa-1111-4111-8111-111111111111","name":"Fixture Practitioner"}]',
};
const result = (dv) => run("node_service_result_gate", dv),
  entry = (dv) => {
    const e = nodes.get("node_service").edges[0];
    const value = (s) => String(s).replace(/{{([^}]+)}}/g, (_, k) => String(dv[k] ?? ""));
    return {
      service_route: e.transition_condition.equations.every((q) =>
        q.operator === "==" ? value(q.left) === q.right : value(q.left) !== q.right,
      )
        ? "known"
        : "capture",
    };
  };
test("exact valid result immediately goes to practitioner; zero questions", () => {
  const r = result(resolved);
  assert.equal(r.service_route, "resolved");
  assert.equal(r.service_clarification_attempts, 0);
  assert.equal(r.service_clarification_used, false);
});
test("valid alias uses unchanged resolver and Arabic mapping; zero questions", () => {
  assert.deepEqual(f.tools, baseline.tools);
  const r = run("node_guard_service", { ...seed, service_query: "تنظيف اسنان" });
  assert.equal(r.service_query, "Dental Cleaning");
  assert.equal(r.stage_ok, true);
  assert.equal(result({ ...resolved, service_query: "cleaning" }).service_route, "resolved");
});
test("real resolver accepts exact names and existing configured English aliases", () => {
  for (const q of ["Dental Cleaning", "dental cleaning", "cleaning", "scaling"]) {
    assert.deepEqual(resolveService(staff, q, aliases), {
      status: "resolved",
      service: "Dental Cleaning",
    });
    assert.equal(result({ ...resolved, service_query: q }).service_route, "resolved");
  }
  assert.equal(resolveService(staff, "unsupported fixture phrase", aliases).status, "not_found");
});
test("ambiguous result consumes exactly one clarification before speaking", () => {
  const r = result(seed);
  assert.equal(r.service_route, "clarify");
  assert.equal(r.service_clarification_attempts, 1);
  assert.equal(r.service_clarification_used, true);
});
test("clarification resolves and continues to practitioner; attempts reset", () => {
  const r = result({ ...resolved, ...result(seed) });
  assert.equal(r.service_route, "resolved");
  assert.equal(r.service_clarification_attempts, 0);
  assert.equal(r.service_clarification_used, true);
});
test("still ambiguous after clarification routes to fallback", () =>
  assert.equal(result({ ...seed, ...result(seed) }).service_route, "fallback"));
test("empty input retains verified cycle and permits at most one clarification", () => {
  const g = run("node_guard_service", { ...seed, service_query: "" });
  assert.equal(g.reset_ready, true);
  assert.equal(g.service_input_missing, true);
  const first = result({ ...seed, ...g }),
    second = result({ ...seed, ...g, ...first });
  assert.equal(first.service_route, "clarify");
  assert.equal(second.service_route, "fallback");
  assert.equal(
    nodes.get("node_guard_service").edges[0].destination_node_id,
    "node_service_result_gate",
  );
});
test("already resolved service bypasses capture, questioning and resolver", () => {
  assert.equal(entry(resolved).service_route, "known");
  assert.equal(entry({ ...resolved, ...result(seed) }).service_route, "known");
  assert.equal(nodes.get("node_service").edges[0].destination_node_id, "node_doctor_preference");
});
test("explicit change clears only service-dependent fields and resets attempts", () => {
  const r = run("node_guard_service_clear_result", {
    ...resolved,
    ...result(seed),
    slot_id: "",
    client_phone: "99123456",
  });
  assert.equal(r.service_name, "");
  assert.equal(r.resolve_success, false);
  assert.equal(r.qualified_practitioners, "[]");
  assert.equal(r.service_clarification_attempts, 0);
  assert.ok(!("service_clarification_used" in r));
  assert.equal(
    result({
      ...resolved,
      ...r,
      resolve_success: true,
      service_name: "Consultation",
      qualified_practitioners: resolved.qualified_practitioners,
    }).service_route,
    "resolved",
  );
  assert.ok(!("client_name" in r));
  assert.ok(!("client_phone" in r));
});
test("new cycle does not inherit a previous cycle question budget", () => {
  const r = result({
    ...seed,
    service_clarification_cycle: "previous",
    service_clarification_used: true,
    service_clarification_attempts: 1,
  });
  assert.equal(r.service_route, "clarify");
  assert.equal(r.service_clarification_cycle, "cycle-a");
});
test("successful resolution does not allow another question in same cycle", () => {
  const r = result({ ...resolved, ...result(seed) });
  assert.equal(result({ ...seed, ...r, resolve_success: false }).service_route, "fallback");
});
test("explicit change cannot violate maximum one question per booking cycle", () => {
  const previous = { ...resolved, ...result(seed) },
    r = run("node_guard_service_clear_result", previous);
  assert.equal(result({ ...previous, ...r }).service_route, "fallback");
});
test("all possible repeated unresolved results are bounded, including serialized state", () => {
  for (const missing of [true, false])
    for (const aliases of ["[]", '["Dental Cleaning","Consultation"]']) {
      let dv = { ...seed, service_input_missing: missing, service_candidates: aliases },
        questions = 0;
      for (let i = 0; i < 30; i++) {
        const r = result(dv);
        questions += r.service_route === "clarify" ? 1 : 0;
        dv = { ...dv, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])) };
      }
      assert.equal(questions, 1);
    }
});
test("only deterministic budget gate can enter Clarify Service", () => {
  const incoming = f.nodes.flatMap((n) =>
    allEdges(n)
      .filter((e) => e.destination_node_id === "node_service_clarify")
      .map((e) => [n.id, e]),
  );
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0][0], "node_service_result_gate");
  assert.equal(incoming[0][1].transition_condition.equations[0].right, "clarify");
  assert.ok(incoming[0][1].transition_condition.equations.some((e) => e.right === "success"));
  assert.ok(
    !allEdges(nodes.get("node_service_clarify")).some(
      (e) => e.destination_node_id === "node_service_clarify",
    ),
  );
  assert.equal(
    nodes.get("node_service_clarify").edges.find((e) => e.id === "edge_service_clarified")
      .destination_node_id,
    "node_capture_service",
  );
});
test("code failures cannot reuse a stale successful clarification route", () => {
  for (const id of ["node_service_result_gate"]) {
    const n = nodes.get(id);
    assert.ok(n.execution_status_variable);
    assert.ok(
      n.edges.every((e) =>
        e.transition_condition.equations.some(
          (q) => q.left === "{{" + n.execution_status_variable + "}}" && q.right === "success",
        ),
      ),
    );
    assert.equal(n.else_edge.destination_node_id, "node_human_prepare");
  }
});
test("invalid booking boundary cannot resolve or clarify", () => {
  assert.equal(
    run("node_intake_name_gate", { ...resolved, reset_ready: false }).intake_route,
    "blocked",
  );
  assert.equal(result({ ...seed, intake_name_cycle: "old" }).service_route, "blocked");
});
test("unrelated flow configuration and all other nodes remain byte-equivalent", () => {
  const allowed = [
    "node_intake_name_gate",
    "node_intake_before_time",
    "node_resolve",
    "node_service_clarify",
    "node_service",
    "node_capture_service",
    "node_guard_service",
    "node_guard_service_clear_result",
    "node_change_booking",
  ];
  for (const n of baseline.nodes)
    if (!allowed.includes(n.id)) assert.deepEqual(nodes.get(n.id), n, n.id);
  for (const key of Object.keys(baseline))
    if (!["nodes", "default_dynamic_variables"].includes(key))
      assert.deepEqual(f[key], baseline[key], key);
  for (const [k, v] of Object.entries(baseline.default_dynamic_variables))
    assert.equal(f.default_dynamic_variables[k], v, k);
});
test("all graph references exist and all code nodes compile", () => {
  assert.equal(nodes.size, f.nodes.length);
  for (const n of f.nodes) {
    for (const e of allEdges(n))
      assert.ok(nodes.has(e.destination_node_id), n.id + " -> " + e.destination_node_id);
    if (n.type === "code") new Function("dv", n.code);
  }
});
test("first service question routes unusable replies to extraction; latest answer wins", () => {
  assert.match(
    nodes.get("node_service").edges.find((e) => e.id === "edge_service_resolve")
      .transition_condition.prompt,
    /unusable/,
  );
  assert.match(
    nodes.get("node_service_clarify").edges.find((e) => e.id === "edge_service_clarified")
      .transition_condition.prompt,
    /empty/,
  );
  assert.match(
    nodes.get("node_capture_service").variables[0].description,
    /ONLY the latest answer/,
  );
});
test("unmatched clarification replies exit deterministically and reminders cannot repeat it", () => {
  const n = nodes.get("node_service_clarify");
  assert.equal(n.else_edge.destination_node_id, "node_capture_service");
  assert.equal(n.else_edge.transition_condition.prompt, "Else");
  assert.equal(n.reminder_max_count, 0);
});
test("storage compaction preserves every name/practitioner/contact intake decision", () => {
  for (const id of ["node_intake_name_gate", "node_intake_before_time"])
    for (const name of ["", seed.client_name])
      for (const success of [true, false])
        for (const mode of ["", "any", "specific"])
          for (const contact of [true, false]) {
            const dv = {
              ...resolved,
              client_name: name,
              intake_name_evidence: name,
              resolve_success: success,
              practitioner_mode: mode,
              practitioner_id: mode === "specific" ? "aaaaaaaa-1111-4111-8111-111111111111" : "",
              client_phone: "99123456",
              patient_confirmed: contact,
              patient_evidence: name + " 99123456",
            };
            const old = new Function("dv", baseline.nodes.find((n) => n.id === id).code)(
              structuredClone(dv),
            );
            assert.deepEqual(run(id, dv), old, id);
          }
});
test("unresolved fallback uses existing human path with no service retry", () => {
  const n = nodes.get("node_service_result_gate");
  assert.equal(
    n.edges.find((e) => e.transition_condition.equations[0].right === "fallback")
      .destination_node_id,
    "node_human_prepare",
  );
  assert.deepEqual(
    nodes.get("node_human_collect"),
    baseline.nodes.find((n) => n.id === "node_human_collect"),
  );
});
test("rebuild is deterministic and idempotent", () => {
  assert.deepEqual(f, build(baseline));
  assert.deepEqual(f, build(f));
});
fs.writeFileSync(
  new URL("test-results.json", root),
  JSON.stringify(
    {
      passed,
      failed: 0,
      validation: "offline deterministic configuration/code fixtures only",
      live_calls: 0,
      try_a_call: false,
      simulated_conversations: 0,
      paid_testing: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${passed} passed, 0 failed`);
