import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import { disposablePostgres } from "../scripts/helpers/disposable-postgres.mjs";
const cluster = await disposablePostgres({ cron: true, database: "apero_integration_races" });
const sql = postgres({ ...cluster, max: 8, onnotice() {} });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clinic = id(100),
  user = id(101),
  staff = id(104),
  client = id(103),
  connection = id(800);
const shim = `create role anon nologin nobypassrls;create role authenticated nologin nobypassrls;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,invited_at timestamptz,email_confirmed_at timestamptz);
grant usage on schema public,auth to anon,authenticated,service_role;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;`;
let success = false;
async function service(fn) {
  return sql.begin(async (tx) => {
    await tx.unsafe("set local role service_role");
    await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
    return fn(tx);
  });
}
async function owner(fn) {
  return sql.begin(async (tx) => {
    await tx.unsafe("set local role authenticated");
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ role: "authenticated", sub: user })},true)`;
    return fn(tx);
  });
}
try {
  const setup = await sql.reserve();
  await setup.unsafe(shim);
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await setup.unsafe(await readFile("supabase/migrations/" + file, "utf8"));
  setup.release();
  await sql`insert into auth.users(id,email) values(${user},'synthetic@example.test')`;
  await sql`insert into clinics(id,name,timezone) values(${clinic},'Synthetic Integration Clinic','UTC')`;
  await sql`insert into profiles(auth_user_id,clinic_id,full_name,email,role) values(${user},${clinic},'Synthetic Owner','synthetic@example.test','owner')`;
  await sql`insert into clients(id,clinic_id,full_name,phone) values(${client},${clinic},'Synthetic Patient','12345678')`;
  await sql`insert into staff(id,clinic_id,full_name,specialty,services) values(${staff},${clinic},'Synthetic Practitioner','Dentistry',array['Consultation'])`;
  await sql`insert into staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time) select ${clinic},${staff},d,'00:00','23:59' from generate_series(0,6) d`;
  const authorizations = await Promise.all(
    Array.from({ length: 4 }, () =>
      service(
        (tx) =>
          tx`select integration_prepare_connection(${clinic},${user},'owner@synthetic.test') id`,
      ),
    ),
  );
  assert.equal(new Set(authorizations.map((x) => x[0].id)).size, 1);
  assert.equal(
    (
      await sql`select count(*)::int n from calendar_connections where google_account_id='owner@synthetic.test'`
    )[0].n,
    1,
  );
  console.log("PASS native concurrent OAuth preparation: one reusable active connection");
  const key = (
    await owner(
      (tx) => tx`select integration_create_key('Synthetic',array['appointments:write']) v`,
    )
  )[0].v.id;
  await service(
    (tx) =>
      tx`select integration_save_connection(${connection},${clinic},${user},'synthetic-ciphertext')`,
  );
  await owner(
    (tx) => tx`select integration_select_calendar(${connection},'synthetic@example.test',${staff})`,
  );
  await Promise.all(
    Array.from({ length: 4 }, () =>
      owner(
        (tx) =>
          tx`select integration_select_calendar(${connection},'synthetic@example.test',${staff})`,
      ),
    ),
  );
  assert.equal(
    Number(
      (
        await sql`select generation from integration_jobs where connection_id=${connection} and kind='pull'`
      )[0].generation,
    ),
    1,
  );
  console.log("PASS native concurrent calendar selection: one unchanged initial sync job");
  const claim = (await service((tx) => tx`select integration_claim() v`))[0].v;
  await service(
    (tx) =>
      tx`select integration_replace_busy(${connection},${claim.lease},now()-interval '1 day',now()+interval '90 days','[]')`,
  );
  await service(
    (tx) => tx`select integration_finish(${claim.job.id},${claim.lease},${claim.job.generation})`,
  );
  const times = (
    await sql`select (current_date+7+time '10:00') at time zone 'UTC' start,(current_date+7+time '10:45') at time zone 'UTC' finish`
  )[0];
  const body = {
    action: "book",
    client_id: client,
    staff_id: staff,
    service: "Consultation",
    start_time: times.start.toISOString(),
    end_time: times.finish.toISOString(),
  };
  const mutate = (request, input = body) =>
    service((tx) => tx`select integration_mutate(${key},${request},${sql.json(input)}) v`);
  const duplicate = await Promise.all([mutate("same-idempotency"), mutate("same-idempotency")]);
  assert.deepEqual(duplicate[0][0].v, duplicate[1][0].v);
  assert.equal((await sql`select count(*)::int n from appointments`)[0].n, 1);
  console.log("PASS native API same-idempotency race: one appointment and one result");
  const next = {
    ...body,
    start_time: new Date(times.start.getTime() + 3600000).toISOString(),
    end_time: new Date(times.finish.getTime() + 3600000).toISOString(),
  };
  const competing = await Promise.allSettled([
    mutate("competing-request-a", next),
    mutate("competing-request-b", next),
  ]);
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(
    ["23P01", "40P01"].includes(competing.find((r) => r.status === "rejected").reason.code),
  );
  assert.equal((await sql`select count(*)::int n from appointments`)[0].n, 2);
  console.log("PASS native API competing request race: one winner");
  // Snapshot wins the row lock; a waiting booking must read the newly committed busy state.
  const conflictStart = new Date(times.start.getTime() + 7200000),
    conflictEnd = new Date(times.finish.getTime() + 7200000);
  const lease = id(850);
  await sql`update calendar_connections set lease_id=${lease},lease_until=now()+interval '3 minutes' where id=${connection}`;
  let release, locked;
  const gate = new Promise((r) => {
      release = r;
    }),
    ready = new Promise((r) => {
      locked = r;
    });
  const snapshot = service(async (tx) => {
    await tx`select integration_replace_busy(${connection},${lease},now()-interval '1 day',now()+interval '90 days',${sql.json([{ id: "external-race", start: conflictStart.toISOString(), end: conflictEnd.toISOString() }])})`;
    locked();
    await gate;
  });
  await ready;
  let completed = false;
  const waiting = mutate("snapshot-booking-race", {
    ...body,
    start_time: conflictStart.toISOString(),
    end_time: conflictEnd.toISOString(),
  }).then(
    () => {
      completed = true;
      return null;
    },
    (error) => {
      completed = true;
      return error;
    },
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(completed, false);
  release();
  await snapshot;
  const rejected = await waiting;
  assert.equal(rejected.code, "23P01");
  console.log("PASS native snapshot-vs-booking lock race: booking rejects new external busy");
  // Booking wins; importer waits and reports conflict with the newly committed appointment.
  const newStart = new Date(times.start.getTime() + 10800000),
    newEnd = new Date(times.finish.getTime() + 10800000);
  let releaseBooking, bookingLocked;
  const bookingGate = new Promise((r) => {
      releaseBooking = r;
    }),
    bookingReady = new Promise((r) => {
      bookingLocked = r;
    });
  const booking = service(async (tx) => {
    await tx`select integration_mutate(${key},'booking-before-import',${sql.json({ ...body, start_time: newStart.toISOString(), end_time: newEnd.toISOString() })})`;
    bookingLocked();
    await bookingGate;
  });
  await bookingReady;
  let imported = false;
  const importing = service(async (tx) => {
    await tx`select integration_replace_busy(${connection},${lease},now()-interval '1 day',now()+interval '90 days',${sql.json([{ id: "external-after-booking", start: newStart.toISOString(), end: newEnd.toISOString() }])})`;
    imported = true;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(imported, false);
  releaseBooking();
  await booking;
  await importing;
  const health = (
    await sql`select status,conflict_detected,last_error from calendar_connections where id=${connection}`
  )[0];
  assert.equal(health.status, "attention");
  assert.equal(health.conflict_detected, true);
  assert.equal(health.last_error, "external_calendar_conflict");
  console.log("PASS native booking-vs-snapshot lock race: imported conflict requires attention");
  success = true;
} finally {
  await sql.end({ timeout: 2 });
  await cluster.close(success);
}
