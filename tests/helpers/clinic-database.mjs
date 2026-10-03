import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

export const productTables = [
  "clinics",
  "profiles",
  "clients",
  "staff",
  "staff_availability",
  "staff_time_off",
  "appointments",
  "conversations",
  "client_notes",
  "notifications",
  "voice_requests",
  "voice_operations",
  "voice_call_state",
  "voice_checked_slots",
  "voice_integrations",
  "clinic_service_aliases",
];
export const internalTables = [
  "voice_operations",
  "voice_call_state",
  "voice_checked_slots",
  "voice_integrations",
  "clinic_service_aliases",
];
export const portalTables = productTables.filter((table) => !internalTables.includes(table));
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const tenants = [100, 200].map((n) => ({
  clinic: uuid(n),
  user: uuid(n + 1),
  profile: uuid(n + 2),
  client: uuid(n + 3),
  staff: uuid(n + 4),
  appointment: uuid(n + 5),
  conversation: uuid(n + 6),
  note: uuid(n + 7),
  notification: uuid(n + 8),
  request: uuid(n + 9),
  availability: uuid(n + 10),
  timeOff: uuid(n + 11),
  slot: uuid(n + 12),
  check: uuid(n + 13),
  call: `isolation-call-${n}`,
  operation: `isolation-operation-${n}`,
}));
export async function loadSql(db, name) {
  return db.exec(await readFile(new URL(`../../db/${name}`, import.meta.url), "utf8"));
}
export async function createClinicDatabase({ appointments = false } = {}) {
  // Real PostgreSQL/WASM: no query mocks, network, production credentials, or
  // persistent database. Only Supabase Auth's claims/schema are shimmed locally.
  const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
  await db.exec(`
    create role anon nologin nobypassrls;
    create role authenticated nologin nobypassrls;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text unique);
    grant usage on schema public, auth to anon, authenticated, service_role;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
    $$;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(auth.jwt() ->> 'sub', '')::uuid
    $$;
    -- Stress legacy broad grants, including privileges outside RLS. This is
    -- intentionally stronger than a fresh schema's explicit CRUD grants.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  for (const name of [
    "01_phase2_schema.sql",
    "02_link_owner_profile.sql",
    "03_voice_operations.sql",
    "04_voice_service_role_grants.sql",
    "05_voice_integrations.sql",
    "06_staff_scheduling.sql",
    "07_prelaunch_security.sql",
    "../tests/fixtures/08_voice_requests_handling.sql",
    "09_client_notes_restrict_update.sql",
  ])
    await loadSql(db, name);
  // Compatibility suites exercise the current role policies as well as the
  // historical schema, without applying anything to a hosted database.
  await loadSql(db, "../tests/fixtures/clinic_role_permissions.sql");
  for (const tenant of tenants) await seedTenant(db, tenant);
  if (appointments) {
    await loadSql(db, "../tests/fixtures/10_clinic_access_privileges.sql");
    await loadSql(db, "../supabase/migrations/20261002190000_shared_appointment_availability.sql");
  }
  return db;
}
async function seedTenant(db, t) {
  await db.exec(`
    insert into auth.users values ('${t.user}', '${t.user}@example.test');
    insert into public.clinics (id, name, timezone) values ('${t.clinic}', 'Clinic ${t.clinic}', 'UTC');
    insert into public.profiles (id, auth_user_id, clinic_id, full_name, email, role)
      values ('${t.profile}', '${t.user}', '${t.clinic}', 'Clinic User', '${t.user}@example.test', 'owner');
    insert into public.clients (id, clinic_id, full_name, phone) values ('${t.client}', '${t.clinic}', 'Patient', '+12025550101');
    insert into public.staff (id, clinic_id, full_name, specialty, services)
      values ('${t.staff}', '${t.clinic}', 'Practitioner', 'General', array['Consultation']);
    insert into public.staff_availability (id, clinic_id, staff_id, day_of_week)
      values ('${t.availability}', '${t.clinic}', '${t.staff}', 1);
    insert into public.staff_time_off (id, clinic_id, staff_id, start_time, end_time)
      values ('${t.timeOff}', '${t.clinic}', '${t.staff}', now() + interval '20 days', now() + interval '21 days');
    insert into public.appointments (id, clinic_id, client_id, staff_id, service, start_time, end_time)
      values ('${t.appointment}', '${t.clinic}', '${t.client}', '${t.staff}', 'Consultation', now() + interval '10 days', now() + interval '10 days 45 minutes');
    insert into public.conversations (id, clinic_id, client_id, appointment_id, retell_call_id)
      values ('${t.conversation}', '${t.clinic}', '${t.client}', '${t.appointment}', '${t.call}');
    insert into public.client_notes (id, clinic_id, client_id, author_profile_id, note)
      values ('${t.note}', '${t.clinic}', '${t.client}', '${t.profile}', 'Private note');
    insert into public.notifications (id, clinic_id, profile_id, title)
      values ('${t.notification}', '${t.clinic}', '${t.profile}', 'Private notification');
    insert into public.voice_requests (id, clinic_id, request_key, call_id, kind, phone, reason)
      values ('${t.request}', '${t.clinic}', 'request-${t.clinic}', '${t.call}', 'callback', '+12025550101', 'Private request');
    insert into public.voice_operations (operation_key, clinic_id, action, call_id, result)
      values ('${t.operation}', '${t.clinic}', 'book', '${t.call}', '{}');
    insert into public.voice_call_state (call_id, clinic_id, current_check_id)
      values ('${t.call}', '${t.clinic}', '${t.check}');
    insert into public.voice_checked_slots (id, check_id, call_id, clinic_id, staff_id, service, start_time, end_time, expires_at)
      values ('${t.slot}', '${t.check}', '${t.call}', '${t.clinic}', '${t.staff}', 'Consultation', now() + interval '10 days', now() + interval '10 days 45 minutes', now() + interval '1 hour');
    insert into public.voice_integrations (clinic_id, workspace_id, agent_id, secret_env_name, active)
      values ('${t.clinic}', 'workspace-${t.clinic}', 'agent-${t.clinic}', 'RETELL_TEST_${t.clinic.replaceAll("-", "")}', true);
    insert into public.clinic_service_aliases values ('${t.clinic}', 'Consultation', 'consult');
  `);
}
export async function asUser(db, userId, run, claims = {}) {
  return asRole(db, "authenticated", { sub: userId, role: "authenticated", ...claims }, run);
}
export async function asRole(db, role, claims, run) {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return await run(db);
  } finally {
    await db.exec("rollback");
  }
}
export async function attempt(db, run) {
  await db.exec("savepoint attack");
  try {
    return await run();
  } finally {
    await db.exec("rollback to savepoint attack; release savepoint attack");
  }
}
