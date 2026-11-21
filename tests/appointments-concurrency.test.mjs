import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { join, resolve } from "node:path";
import {
  appointmentWriteError,
  appointmentSlotConflictMessage,
} from "../src/lib/appointment-conflicts.ts";

// Deliberately no DATABASE_URL, Supabase credentials, TCP host or remote fallback.
// Start the documented disposable PostgreSQL cluster before running this suite.
const cluster = process.env.APERO_TEST_CONCURRENCY_CLUSTER;
if (!cluster)
  throw new Error("Run via scripts/test-concurrency.mjs to create an isolated database.");
const marker = JSON.parse(await readFile(join(cluster, ".apero-disposable.json"), "utf8"));
const database = "apero_concurrency_acceptance";
const options = {
  host: process.platform === "win32" ? "127.0.0.1" : join(cluster, "socket"),
  port: marker.port,
  database,
  username: "apero_test",
  max: 1,
  connect_timeout: 5,
  idle_timeout: 0,
  onnotice() {},
};
assert.equal(marker.database, database);
assert.ok(Number.isInteger(marker.port) && marker.port > 0 && marker.port < 65536);
const admin = postgres(options);
const connections = [postgres(options), postgres(options)];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let sequence = 5000;
const id = () => uuid(++sequence);
const tenant = {
  clinic: uuid(100),
  staff: uuid(104),
  clients: [uuid(103), uuid(113)],
  users: { owner: uuid(101), manager: uuid(121), staff: uuid(131) },
};
const other = { clinic: uuid(200), staff: uuid(204), client: uuid(203), user: uuid(201) };
const patients = [
  { id: tenant.clients[0], name: "Concurrency Patient A", phone: "+96599123456" },
  { id: tenant.clients[1], name: "Concurrency Patient B", phone: "+96599876543" },
];
const gate = 84632179;
const evidence = {
  environment: {},
  races: [],
  adjacent: [],
  cancellation: [],
  roles: [],
  isolation: [],
  cleanup: {},
};
let day = 0;
const date = () => new Date(Date.UTC(2040, 0, ++day)).toISOString().slice(0, 10);
const range = (d, minute = 540) => ({
  start: `${d}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`,
  end: `${d}T${String(Math.floor((minute + 45) / 60)).padStart(2, "0")}:${String((minute + 45) % 60).padStart(2, "0")}:00Z`,
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(read, accept, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const result = await read();
    if (accept(result)) return result;
    await pause();
  }
  throw Error(`Timed out: ${label}`);
}
async function begin(sql, channel, role = "owner") {
  await sql.unsafe("begin; set local statement_timeout='20s'; set local lock_timeout='15s'");
  await sql.unsafe(
    channel === "voice" ? "set local role service_role" : "set local role authenticated",
  );
  await sql`select set_config('request.jwt.claims', ${JSON.stringify(channel === "voice" ? { role: "service_role" } : { role: "authenticated", sub: tenant.users[role] })},true)`;
}
async function available(sql, slot, exclude = null, clinic = tenant.clinic, staff = tenant.staff) {
  const rows =
    await sql`select * from public.appointment_available_slots(${clinic}::uuid,${staff}::uuid,'Consultation',${slot.start.slice(0, 10)}::date,${exclude}::uuid)`;
  return rows.some(
    (s) =>
      s.start_time.toISOString() === new Date(slot.start).toISOString() &&
      s.end_time.toISOString() === new Date(slot.end).toISOString(),
  );
}
async function prepareVoice(slot, patient, action = "book", appointment = null) {
  const call = `concurrency-${id()}`,
    check = id(),
    checkedSlot = id(),
    operation = `concurrency-operation-${id()}`;
  await admin`insert into public.voice_call_state(call_id,clinic_id,current_check_id) values(${call},${tenant.clinic}::uuid,${check}::uuid)`;
  await admin`insert into public.voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at) values(${checkedSlot}::uuid,${check}::uuid,${call},${tenant.clinic}::uuid,${tenant.staff}::uuid,'Consultation',${slot.start}::timestamptz,${slot.end}::timestamptz,now()+interval '1 hour')`;
  return { call, check, checkedSlot, operation, slot, patient, action, appointment };
}
async function voice(sql, v) {
  const [row] =
    await sql`select public.voice_apply_appointment(${v.action},${tenant.clinic}::uuid,${v.operation},${v.call},${v.appointment}::uuid,${v.patient.name},${v.patient.phone},null,null,${tenant.staff}::uuid,'Consultation',${v.slot.start}::timestamptz,${v.slot.end}::timestamptz,${v.check}::uuid,${v.checkedSlot}::uuid) as result`;
  return row.result;
}
async function dashboard(sql, slot, patient = patients[0]) {
  const appointment = id();
  const [row] =
    await sql`insert into public.appointments(id,clinic_id,client_id,staff_id,service,start_time,end_time,status,source) values(${appointment}::uuid,${tenant.clinic}::uuid,${patient.id}::uuid,${tenant.staff}::uuid,'Consultation',${slot.start}::timestamptz,${slot.end}::timestamptz,'Booked','Front desk') returning id,client_id,staff_id`;
  return { success: true, appointment_id: row.id };
}
async function assertNoOverlaps() {
  const [row] =
    await admin`select count(*)::int as n from public.appointments a join public.appointments b on a.id<b.id and a.clinic_id=b.clinic_id and a.staff_id=b.staff_id and a.status<>'Cancelled' and b.status<>'Cancelled' and a.start_time<b.end_time and a.end_time>b.start_time`;
  assert.equal(row.n, 0, "no committed double bookings may remain");
}
async function setup() {
  const [identity] =
    await admin`select current_database() as database,current_setting('data_directory') as directory,current_setting('server_version') as version,inet_server_addr() as address`;
  assert.equal(identity.database, database);
  assert.equal(resolve(identity.directory), resolve(cluster, "data"));
  assert.equal(identity.address, process.platform === "win32" ? "127.0.0.1" : null);
  evidence.environment = identity;
  await admin.unsafe(`create role anon nologin nobypassrls; create role authenticated nologin nobypassrls; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text unique);
    grant usage on schema public,auth to anon,authenticated,service_role;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  for (const name of [
    "01_phase2_schema.sql",
    "02_link_owner_profile.sql",
    "03_voice_operations.sql",
    "04_voice_service_role_grants.sql",
    "05_voice_integrations.sql",
    "06_staff_scheduling.sql",
    "07_prelaunch_security.sql",
    "08_voice_requests_handling.sql",
    "09_client_notes_restrict_update.sql",
    "10_clinic_access_privileges.sql",
  ])
    await admin.unsafe(await readFile(new URL(`../db/${name}`, import.meta.url), "utf8"));
  await admin.unsafe(
    await readFile(
      new URL("../supabase/migrations/20261002170000_clinic_role_permissions.sql", import.meta.url),
      "utf8",
    ),
  );
  // Match the production preflight's existing exclusion, without copying any
  // production appointment data or using any production connection.
  await admin.unsafe(`create extension if not exists btree_gist;
    alter table public.appointments add constraint appointments_no_staff_overlap exclude using gist (staff_id with =,tstzrange(start_time,end_time,'[)') with &&) where(status<>'Cancelled');`);
  const migration = await readFile(
    new URL(
      "../supabase/migrations/20261002190000_shared_appointment_availability.sql",
      import.meta.url,
    ),
    "utf8",
  );
  evidence.environment.migration_sha256 = createHash("sha256").update(migration).digest("hex");
  await admin.unsafe(migration);
  await admin.unsafe(
    await readFile(
      new URL(
        "../supabase/migrations/20261120104000_voice_practitioner_reschedule.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await admin`select set_config('request.jwt.claims','{"role":"service_role"}',false)`;
  for (const t of [
    { clinic: tenant.clinic, staff: tenant.staff, client: patients[0] },
    {
      clinic: other.clinic,
      staff: other.staff,
      client: { id: other.client, name: "Other Clinic Patient", phone: "+96590000000" },
    },
  ]) {
    await admin`insert into public.clinics(id,name,timezone) values(${t.clinic}::uuid,'Isolated concurrency clinic','UTC')`;
    await admin`insert into public.staff(id,clinic_id,full_name,specialty,services) values(${t.staff}::uuid,${t.clinic}::uuid,'Isolated practitioner','General',array['Consultation'])`;
    await admin`insert into public.clients(id,clinic_id,full_name,phone) values(${t.client.id}::uuid,${t.clinic}::uuid,${t.client.name},${t.client.phone})`;
    await admin`insert into public.staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time) select ${t.clinic}::uuid,${t.staff}::uuid,d,'09:00','17:00' from generate_series(0,6)d`;
    await admin`insert into public.voice_integrations(clinic_id,workspace_id,agent_id,secret_env_name,active) values(${t.clinic}::uuid,${`test-${t.clinic}`},${`test-${t.staff}`},${`RETELL_CONCURRENCY_${t.clinic.replaceAll("-", "")}`},true)`;
  }
  await admin`insert into public.clients(id,clinic_id,full_name,phone) values(${patients[1].id}::uuid,${tenant.clinic}::uuid,${patients[1].name},${patients[1].phone})`;
  for (const [role, user] of Object.entries(tenant.users)) {
    await admin`insert into auth.users(id,email) values(${user}::uuid,${`${role}@concurrency.test`})`;
    await admin`insert into public.profiles(auth_user_id,clinic_id,full_name,email,role) values(${user}::uuid,${tenant.clinic}::uuid,'Concurrency user',${`${role}@concurrency.test`},${role}::public.profile_role)`;
  }
  await admin`insert into auth.users(id,email) values(${other.user}::uuid,'other@concurrency.test')`;
  await admin`insert into public.profiles(auth_user_id,clinic_id,full_name,email,role) values(${other.user}::uuid,${other.clinic}::uuid,'Other clinic user','other@concurrency.test','owner')`;
  await admin.unsafe(`create function public.apero_test_concurrency_gate() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$begin
    if current_setting('apero_test.gate_enabled',true)='on' then perform pg_advisory_xact_lock_shared(${gate}); end if; return new; end$$;
    create trigger zz_apero_test_concurrency_gate before insert or update on public.appointments for each row execute function public.apero_test_concurrency_gate();`);
  const [a] = await connections[0]`select pg_backend_pid() as pid`;
  const [b] = await connections[1]`select pg_backend_pid() as pid`;
  const [c] = await admin`select pg_backend_pid() as pid`;
  assert.equal(new Set([a.pid, b.pid, c.pid]).size, 3);
  evidence.environment.backend_pids = [a.pid, b.pid];
  evidence.environment.monitor_pid = c.pid;
  evidence.environment.constraints =
    await admin`select conname,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.appointments'::regclass and contype='x' order by conname`;
  return [a.pid, b.pid];
}
async function collide(mode, label, channels, pids, role = "owner", moving = false) {
  const target = range(date());
  let original;
  if (moving) {
    const source = range(target.start.slice(0, 10), 660);
    original = { ...(await dashboard(admin, source)), ...source };
  }
  const checked = await Promise.all(
    channels.map((channel, i) => (channel === "voice" ? prepareVoice(target, patients[i]) : null)),
  );
  const results = [];
  const completed = [];
  await admin`select pg_advisory_lock(${gate})`;
  try {
    for (let i = 0; i < 2; i++) {
      await begin(connections[i], channels[i], role);
      assert.equal(
        await available(connections[i], target, moving && i === 0 ? original.appointment_id : null),
        true,
      );
      await connections[i]`select set_config('apero_test.gate_enabled','on',true)`;
    }
    // Both real server sessions pause AFTER the unchanged production checks.
    // Shared gate release lets both reach the exclusion index concurrently.
    const pending = channels.map((channel, i) =>
      (async () => {
        try {
          let value;
          if (moving && i === 0) {
            const [row] = await connections[
              i
            ]`update public.appointments set start_time=${target.start}::timestamptz,end_time=${target.end}::timestamptz where id=${original.appointment_id}::uuid returning id`;
            value = { success: true, appointment_id: row.id };
          } else
            value =
              channel === "voice"
                ? await voice(connections[i], checked[i])
                : await dashboard(connections[i], target, patients[i]);
          const result = { index: i, value };
          completed.push(result);
          return result;
        } catch (error) {
          const mapped = channel === "dashboard" ? appointmentWriteError(error) : error;
          const result = {
            index: i,
            error: { code: error.code, constraint: error.constraint_name, message: mapped.message },
          };
          completed.push(result);
          return result;
        }
      })(),
    );
    const gates = await until(
      () =>
        admin`select pid,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=any(${pids}::int[])`,
      (rows) =>
        rows.length === 2 &&
        rows.every(
          (r) =>
            r.wait_event === "advisory" && r.blockers.includes(evidence.environment.monitor_pid),
        ),
      "both writers after prechecks",
    );
    assert.equal(completed.length, 0);
    await admin`select pg_advisory_unlock(${gate})`;
    const lockSnapshots = [];
    await until(
      async () => {
        const locks =
          await admin`select pid,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=any(${pids}::int[])`;
        lockSnapshots.push(locks);
        return completed;
      },
      (r) => r.length > 0,
      "first exclusion result",
    );
    const first = completed[0];
    let winner, loser, winning, failed;
    if (first.error || first.value.success === false) {
      // PostgreSQL exclusion checks may deadlock when both index tuples are
      // installed before either check finishes. Recover the real victim, then
      // verify its peer wins and the application error contract separately.
      if (first.error)
        assert.ok(["23P01", "40P01"].includes(first.error.code), JSON.stringify(first));
      else assert.deepEqual(first.value, { success: false, error_type: "slot_conflict" });
      loser = first.index;
      winner = 1 - loser;
      failed = first;
      await connections[loser].unsafe("rollback");
      winning = await pending[winner];
      assert.ok(!winning.error && winning.value.success === true, JSON.stringify(winning));
    } else {
      assert.equal(first.value.success, true);
      winning = first;
      winner = first.index;
      loser = 1 - winner;
      const waiting = await until(
        () =>
          admin`select pid,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=${pids[loser]}`,
        (rows) =>
          rows[0]?.wait_event === "transactionid" && rows[0].blockers.includes(pids[winner]),
        "loser waiting for uncommitted exclusion owner",
      );
      lockSnapshots.push(waiting);
      assert.equal(completed.length, 1, "competing write must still be in flight");
    }
    assert.ok(
      lockSnapshots.some((rows) =>
        rows.some(
          (r) => r.wait_event === "transactionid" && r.blockers.some((pid) => pids.includes(pid)),
        ),
      ),
      "server must show a real exclusion transaction wait",
    );
    assert.equal(
      await available(admin, target, original?.appointment_id || null),
      true,
      "uncommitted winner is invisible to availability",
    );
    await connections[winner].unsafe("commit");
    failed ||= await pending[loser];
    const applicationContract = "PASS";
    if (channels[loser] === "voice") {
      assert.equal(failed.error, undefined);
      assert.deepEqual(failed.value, { success: false, error_type: "slot_conflict" });
    } else {
      assert.ok(["23P01", "40P01"].includes(failed.error?.code), JSON.stringify(failed));
      assert.equal(failed.error.message, appointmentSlotConflictMessage);
      if (failed.error.code === "23P01")
        assert.equal(
          failed.error.constraint,
          mode === "new-only" ? "appointments_shared_no_overlap" : "appointments_no_staff_overlap",
        );
    }
    await connections[loser].unsafe("rollback");
    assert.equal(
      (await connections[loser]`select 1 as usable`)[0].usable,
      1,
      "failed connection must recover cleanly",
    );
    const rows =
      await admin`select id,client_id from public.appointments where clinic_id=${tenant.clinic}::uuid and staff_id=${tenant.staff}::uuid and status<>'Cancelled' and start_time=${target.start}::timestamptz`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, winning.value.appointment_id);
    if (moving && loser === 0) {
      const [saved] =
        await admin`select start_time,end_time from public.appointments where id=${original.appointment_id}::uuid`;
      assert.equal(saved.start_time.toISOString(), new Date(original.start).toISOString());
      assert.equal(saved.end_time.toISOString(), new Date(original.end).toISOString());
    }
    if (checked[loser]) {
      assert.equal(
        (
          await admin`select count(*)::int as n from public.voice_operations where operation_key=${checked[loser].operation}`
        )[0].n,
        0,
      );
      assert.equal(
        (
          await admin`select current_check_id from public.voice_call_state where call_id=${checked[loser].call}`
        )[0].current_check_id,
        checked[loser].check,
      );
    }
    assert.equal(
      (
        await admin`select count(*)::int as n from public.clients where clinic_id=${tenant.clinic}::uuid`
      )[0].n,
      2,
      "races must reuse existing patients",
    );
    await assertNoOverlaps();
    evidence.races.push({
      mode,
      scenario: label,
      dashboard_role: role,
      winner: channels[winner],
      both_prechecks_completed: true,
      gates,
      exclusion_wait: lockSnapshots,
      database_protection: "PASS",
      application_contract: applicationContract,
      failure: failed.error || failed.value,
      active_rows: 1,
      rollback_clean: true,
    });
    console.log(
      `${applicationContract.startsWith("FAIL") ? "FAIL application / PASS database" : "PASS"} ${mode}: ${label} (${role}), winner=${channels[winner]}, failure=${failed.error?.code || failed.value.error_type}`,
    );
  } finally {
    await admin`select pg_advisory_unlock(${gate})`;
    for (const c of connections) await c.unsafe("rollback");
  }
}
async function adjacent(mode, pids) {
  const d = date(),
    slots = [range(d), range(d, 585)],
    checked = await prepareVoice(slots[1], patients[1]);
  await admin`select pg_advisory_lock(${gate})`;
  try {
    await begin(connections[0], "dashboard", "manager");
    await begin(connections[1], "voice");
    for (const c of connections) await c`select set_config('apero_test.gate_enabled','on',true)`;
    const pending = [dashboard(connections[0], slots[0]), voice(connections[1], checked)];
    await until(
      () => admin`select pid,wait_event from pg_stat_activity where pid=any(${pids}::int[])`,
      (rows) => rows.length === 2 && rows.every((r) => r.wait_event === "advisory"),
      "adjacent writers synchronized",
    );
    await admin`select pg_advisory_unlock(${gate})`;
    const result = await Promise.all(pending);
    assert.ok(result.every((r) => r.success));
    await Promise.all(connections.map((c) => c.unsafe("commit")));
    await assertNoOverlaps();
    evidence.adjacent.push({ mode, success_count: 2, result });
    console.log(`PASS ${mode}: adjacent dashboard/voice bookings`);
  } finally {
    await admin`select pg_advisory_unlock(${gate})`;
    for (const c of connections) await c.unsafe("rollback");
  }
}
async function cancellation(mode) {
  const slot = range(date());
  let appointment;
  await begin(connections[0], "dashboard", "staff");
  try {
    appointment = await dashboard(connections[0], slot);
    await connections[0].unsafe("commit");
  } finally {
    await connections[0].unsafe("rollback");
  }
  const cancel = await prepareVoice(slot, patients[0], "cancel", appointment.appointment_id);
  await begin(connections[1], "voice");
  try {
    const result = await voice(connections[1], cancel);
    assert.equal(result.success, true);
    await connections[1].unsafe("commit");
  } finally {
    await connections[1].unsafe("rollback");
  }
  assert.equal(await available(admin, slot), true);
  const checked = await prepareVoice(slot, patients[1]);
  await begin(connections[1], "voice");
  try {
    const result = await voice(connections[1], checked);
    assert.equal(result.success, true);
    await connections[1].unsafe("commit");
  } finally {
    await connections[1].unsafe("rollback");
  }
  assert.equal(await available(admin, slot), false);
  assert.equal(
    (
      await admin`select status from public.appointments where id=${appointment.appointment_id}::uuid`
    )[0].status,
    "Cancelled",
  );
  await assertNoOverlaps();
  evidence.cancellation.push({
    mode,
    preserved_history: true,
    availability_reopened: true,
    voice_rebook_success: true,
  });
  console.log(`PASS ${mode}: cancel/history/availability/rebook`);
}
async function rolesAndIsolation() {
  const foreignSlot = range(date());
  const [foreign] =
    await admin`insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values(${other.clinic}::uuid,${other.client}::uuid,${other.staff}::uuid,'Consultation',${foreignSlot.start}::timestamptz,${foreignSlot.end}::timestamptz) returning id`;
  for (const role of ["owner", "manager", "staff"]) {
    const c = connections[0],
      initial = range(date()),
      destination = range(initial.start.slice(0, 10), 675);
    await begin(c, "dashboard", role);
    try {
      assert.equal(await available(c, initial), true);
      const booked = await dashboard(c, initial);
      assert.equal(
        (await c`select id from appointments where id=${booked.appointment_id}::uuid`).length,
        1,
      );
      assert.equal(await available(c, destination, booked.appointment_id), true);
      assert.equal(
        (
          await c`update appointments set start_time=${destination.start}::timestamptz,end_time=${destination.end}::timestamptz where id=${booked.appointment_id}::uuid returning id`
        ).length,
        1,
      );
      await c`update appointments set status='Cancelled' where id=${booked.appointment_id}::uuid`;
      assert.equal(await available(c, destination), true);
      assert.equal(
        (await c`select id from appointments where clinic_id=${other.clinic}::uuid`).length,
        0,
      );
      for (const patch of [
        "notes='Denied'",
        "status='Cancelled'",
        `start_time='${range(foreignSlot.start.slice(0, 10), 660).start}'::timestamptz,end_time='${range(foreignSlot.start.slice(0, 10), 660).end}'::timestamptz`,
      ])
        assert.equal(
          (
            await c.unsafe(
              `update public.appointments set ${patch} where id='${foreign.id}' returning id`,
            )
          ).length,
          0,
        );
      for (const references of [
        { client: other.client, staff: tenant.staff },
        { client: patients[0].id, staff: other.staff },
      ]) {
        await c.unsafe("savepoint isolation_probe");
        await assert.rejects(
          c`insert into appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values(${tenant.clinic}::uuid,${references.client}::uuid,${references.staff}::uuid,'Consultation',${destination.start}::timestamptz,${destination.end}::timestamptz)`,
          /clinic|patient|practitioner|unavailable/i,
        );
        await c.unsafe("rollback to savepoint isolation_probe; release savepoint isolation_probe");
      }
      await c.unsafe("savepoint isolation_probe");
      await assert.rejects(
        c`select * from appointment_available_slots(${other.clinic}::uuid,${other.staff}::uuid,'Consultation',${foreignSlot.start.slice(0, 10)}::date,null)`,
        /clinic access denied/i,
      );
      await c.unsafe("rollback to savepoint isolation_probe; release savepoint isolation_probe");
      await c.unsafe("savepoint isolation_probe");
      await assert.rejects(
        c`insert into appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values(${tenant.clinic}::uuid,${patients[0].id}::uuid,${tenant.staff}::uuid,'Unsupported Service',${destination.start}::timestamptz,${destination.end}::timestamptz)`,
        /unavailable/i,
      );
      await c.unsafe("rollback to savepoint isolation_probe; release savepoint isolation_probe");
      await c.unsafe("savepoint isolation_probe");
      await assert.rejects(
        c`select voice_apply_appointment('cancel',${other.clinic}::uuid,'not-allowed-operation','not-allowed-call',${foreign.id}::uuid,null,null,null,null,null,null,null,null,null,null)`,
        /permission denied/i,
      );
      await c.unsafe("rollback to savepoint isolation_probe; release savepoint isolation_probe");
      await c.unsafe("commit");
      evidence.roles.push({ role, load_create_reschedule_cancel: "PASS" });
      evidence.isolation.push({
        role,
        cross_clinic_read_write_cancel_reschedule_references_rpc: "PASS",
      });
      console.log(
        `PASS ${role}: operations, relationships, shared RPC, clinic isolation, voice permissions`,
      );
    } finally {
      await c.unsafe("rollback");
    }
  }
}
try {
  const pids = await setup();
  for (const mode of ["both-constraints", "new-only"]) {
    if (mode === "new-only")
      await admin.unsafe(
        "alter table public.appointments drop constraint appointments_no_staff_overlap",
      );
    for (let repetition = 0; repetition < 10; repetition++) {
      await collide(mode, "dashboard-vs-dashboard", ["dashboard", "dashboard"], pids, "owner");
      await collide(mode, "dashboard-vs-voice", ["dashboard", "voice"], pids, "manager");
      await collide(mode, "voice-vs-voice", ["voice", "voice"], pids);
      await collide(mode, "reschedule-vs-booking", ["dashboard", "dashboard"], pids, "staff", true);
    }
    await adjacent(mode, pids);
    await cancellation(mode);
  }
  await rolesAndIsolation();
  await assertNoOverlaps();
  await admin.unsafe(
    "drop trigger zz_apero_test_concurrency_gate on public.appointments; drop function public.apero_test_concurrency_gate()",
  );
  evidence.cleanup.instrumentation_removed = true;
  const [state] =
    await admin`select count(*)::int as n from pg_stat_activity where datname=${database} and state in ('idle in transaction','idle in transaction (aborted)')`;
  assert.equal(state.n, 0);
  evidence.cleanup.idle_or_aborted_transactions = 0;
  const serverLog = await readFile(`${cluster}/server.log`, "utf8");
  evidence.deadlocks_reproduced = {
    dashboard: evidence.races.filter((r) => r.failure.code === "40P01").length,
    voice: serverLog
      .split("\n")
      .filter((line) => line.includes("Appointment slot acquisition failed (code: 40P01)")).length,
  };
  assert.ok(
    evidence.deadlocks_reproduced.dashboard > 0,
    "genuine dashboard deadlock must be reproduced",
  );
  assert.ok(
    evidence.deadlocks_reproduced.voice > 0,
    "genuine voice deadlock must be reproduced and translated",
  );
  evidence.verdict = evidence.races.some((r) => r.application_contract.startsWith("FAIL"))
    ? "STILL NEEDS CHANGES"
    : "PASS";
  if (evidence.verdict !== "PASS") process.exitCode = 1;
} catch (error) {
  evidence.verdict = "FAIL";
  evidence.error = { message: error.message, stack: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  await Promise.all([...connections, admin].map((c) => c.end({ timeout: 1 })));
  evidence.cleanup.clients_closed = true;
  await writeFile(`${cluster}/acceptance-evidence.json`, JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(`Evidence: ${cluster}/acceptance-evidence.json; verdict=${evidence.verdict}`);
}
