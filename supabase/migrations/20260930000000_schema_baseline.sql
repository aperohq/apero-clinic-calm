-- Fresh databases only. Existing installations must verify and mark this
-- baseline applied using migration repair; never execute it on a populated DB.
do $$ begin
 if to_regclass('public.clinics') is not null then
  raise exception 'Baseline is for an empty database. Verify schema and mark baseline applied; see stabilization runbook.';
 end if;
end $$;

-- Source: db/01_phase2_schema.sql
-- Apero Phase 2 — multi-clinic schema, RLS and development seed data.
-- Run this whole file once in the Supabase SQL editor of your own project.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- enums
do $$ begin
  create type public.profile_role as enum ('owner', 'manager', 'staff');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- tables
create table if not exists public.clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  phone text,
  email text,
  timezone text not null default 'Asia/Kuwait',
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  role public.profile_role not null default 'staff',
  created_at timestamptz not null default now()
);
create index if not exists profiles_clinic_idx on public.profiles(clinic_id);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  full_name text not null,
  phone text not null,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists clients_clinic_idx on public.clients(clinic_id);

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  full_name text not null,
  specialty text not null,
  phone text,
  email text,
  services text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists staff_clinic_idx on public.staff(clinic_id);

create table if not exists public.staff_availability (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null default '09:00',
  end_time time not null default '17:00',
  is_available boolean not null default true,
  unique (staff_id, day_of_week)
);
create index if not exists staff_availability_clinic_idx on public.staff_availability(clinic_id);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  staff_id uuid references public.staff(id) on delete set null,
  service text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  status text not null default 'Booked',
  source text not null default 'Front desk',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists appointments_clinic_idx on public.appointments(clinic_id, start_time);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  retell_call_id text,
  retell_agent_id text,
  title text not null default 'Conversation',
  status text not null default 'Needs Review',
  outcome text,
  caller_phone text,
  started_at timestamptz not null default now(),
  duration_seconds integer not null default 0,
  summary text,
  transcript jsonb,
  recording_url text,
  created_at timestamptz not null default now()
);
create unique index if not exists conversations_retell_call_id_key
  on public.conversations(retell_call_id) where retell_call_id is not null;
create index if not exists conversations_clinic_idx on public.conversations(clinic_id, started_at desc);

create table if not exists public.client_notes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  author_profile_id uuid references public.profiles(id) on delete set null,
  note text not null,
  created_at timestamptz not null default now()
);
create index if not exists client_notes_client_idx on public.client_notes(client_id, created_at);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  type text not null default 'info',
  title text not null,
  message text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_clinic_idx on public.notifications(clinic_id, created_at desc);

-- ---------------------------------------------------------------- grants
grant select, insert, update, delete on public.clinics to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.staff to authenticated;
grant select, insert, update, delete on public.staff_availability to authenticated;
grant select, insert, update, delete on public.appointments to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.client_notes to authenticated;
grant select, insert, update, delete on public.notifications to authenticated;
grant all on public.clinics, public.profiles, public.clients, public.staff,
  public.staff_availability, public.appointments, public.conversations,
  public.client_notes, public.notifications to service_role;

-- ------------------------------------------------- current clinic helpers
create or replace function public.current_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select clinic_id from public.profiles where auth_user_id = auth.uid() limit 1
$$;

create or replace function public.current_profile_role()
returns public.profile_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where auth_user_id = auth.uid() limit 1
$$;

-- ---------------------------------------------------------------- RLS
alter table public.clinics enable row level security;
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.staff enable row level security;
alter table public.staff_availability enable row level security;
alter table public.appointments enable row level security;
alter table public.conversations enable row level security;
alter table public.client_notes enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "clinic members read own clinic" on public.clinics;
create policy "clinic members read own clinic" on public.clinics
  for select to authenticated using (id = public.current_clinic_id());
drop policy if exists "clinic owners update own clinic" on public.clinics;
create policy "clinic owners update own clinic" on public.clinics
  for update to authenticated
  using (id = public.current_clinic_id() and public.current_profile_role() = 'owner')
  with check (id = public.current_clinic_id());

drop policy if exists "read clinic profiles" on public.profiles;
create policy "read clinic profiles" on public.profiles
  for select to authenticated using (clinic_id = public.current_clinic_id());
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (
    auth_user_id = auth.uid()
    and clinic_id = public.current_clinic_id()
  );

-- Prevent users from escalating themselves: role, clinic_id and auth_user_id
-- can never be changed through the client-facing API. Only the service role
-- (trusted server-side operations) may modify those columns.
create or replace function public.guard_profile_sensitive_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (new.clinic_id is distinct from old.clinic_id
          or new.role is distinct from old.role
          or new.auth_user_id is distinct from old.auth_user_id) then
    raise exception 'clinic_id, role and auth_user_id cannot be changed';
  end if;
  return new;
end $$;

drop trigger if exists guard_profile_sensitive_fields on public.profiles;
create trigger guard_profile_sensitive_fields
  before update on public.profiles
  for each row execute function public.guard_profile_sensitive_fields();

-- Clinic-owned data: tenant isolation by clinic_id PLUS role permissions,
-- enforced in the database. Drop any previous generic policy first.
do $$
declare t text;
begin
  foreach t in array array['clients','staff','staff_availability','appointments',
                           'conversations','client_notes','notifications']
  loop
    execute format('drop policy if exists "clinic isolation" on public.%I', t);
  end loop;
end $$;

create or replace function public.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.profiles where auth_user_id = auth.uid() limit 1
$$;

-- helper: same clinic shorthand used by every policy below
-- (clinic_id = public.current_clinic_id())

-- ---- clients: everyone reads; owner/manager write; staff may update only
drop policy if exists "clients select" on public.clients;
create policy "clients select" on public.clients
  for select to authenticated using (clinic_id = public.current_clinic_id());
drop policy if exists "clients insert" on public.clients;
create policy "clients insert" on public.clients
  for insert to authenticated
  with check (clinic_id = public.current_clinic_id()
              and public.current_profile_role() in ('owner','manager'));
drop policy if exists "clients update" on public.clients;
create policy "clients update" on public.clients
  for update to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());
drop policy if exists "clients delete" on public.clients;
create policy "clients delete" on public.clients
  for delete to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() in ('owner','manager'));

-- ---- staff: everyone reads; only owner/manager may write
drop policy if exists "staff select" on public.staff;
create policy "staff select" on public.staff
  for select to authenticated using (clinic_id = public.current_clinic_id());
drop policy if exists "staff write" on public.staff;
create policy "staff write" on public.staff
  for all to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() in ('owner','manager'))
  with check (clinic_id = public.current_clinic_id()
              and public.current_profile_role() in ('owner','manager'));

-- ---- staff availability: everyone reads; only owner/manager may write
drop policy if exists "staff availability select" on public.staff_availability;
create policy "staff availability select" on public.staff_availability
  for select to authenticated using (clinic_id = public.current_clinic_id());
drop policy if exists "staff availability write" on public.staff_availability;
create policy "staff availability write" on public.staff_availability
  for all to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() in ('owner','manager'))
  with check (clinic_id = public.current_clinic_id()
              and public.current_profile_role() in ('owner','manager'));

-- ---- appointments: all roles read/create/update; only owner/manager delete
drop policy if exists "appointments select" on public.appointments;
create policy "appointments select" on public.appointments
  for select to authenticated using (clinic_id = public.current_clinic_id());
drop policy if exists "appointments insert" on public.appointments;
create policy "appointments insert" on public.appointments
  for insert to authenticated
  with check (clinic_id = public.current_clinic_id());
drop policy if exists "appointments update" on public.appointments;
create policy "appointments update" on public.appointments
  for update to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());
drop policy if exists "appointments delete" on public.appointments;
create policy "appointments delete" on public.appointments
  for delete to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() in ('owner','manager'));

-- ---- conversations: all roles read; only owner may write (call records)
drop policy if exists "conversations select" on public.conversations;
create policy "conversations select" on public.conversations
  for select to authenticated using (clinic_id = public.current_clinic_id());
drop policy if exists "conversations write" on public.conversations;
create policy "conversations write" on public.conversations
  for all to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() = 'owner')
  with check (clinic_id = public.current_clinic_id()
              and public.current_profile_role() = 'owner');

-- ---- client notes: all roles read/write; only owner/manager delete
drop policy if exists "client notes select" on public.client_notes;
create policy "client notes select" on public.client_notes
  for select to authenticated using (clinic_id = public.current_clinic_id());
drop policy if exists "client notes insert" on public.client_notes;
create policy "client notes insert" on public.client_notes
  for insert to authenticated
  with check (clinic_id = public.current_clinic_id()
              and author_profile_id = public.current_profile_id());
drop policy if exists "client notes update" on public.client_notes;
create policy "client notes update" on public.client_notes
  for update to authenticated
  using (clinic_id = public.current_clinic_id())
  with check (clinic_id = public.current_clinic_id());
drop policy if exists "client notes delete" on public.client_notes;
create policy "client notes delete" on public.client_notes
  for delete to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() in ('owner','manager'));

-- ---- notifications: owners read all clinic notifications; manager/staff
-- read only their own. A notification's content (title, message, type,
-- profile_id, clinic_id) is immutable through the client API — only its
-- read status may be changed, and manager/staff may only change their own.
drop policy if exists "notifications select" on public.notifications;
create policy "notifications select" on public.notifications
  for select to authenticated
  using (clinic_id = public.current_clinic_id()
         and (public.current_profile_role() = 'owner'
              or profile_id = public.current_profile_id()));
drop policy if exists "notifications update" on public.notifications;
create policy "notifications update" on public.notifications
  for update to authenticated
  using (clinic_id = public.current_clinic_id()
         and (public.current_profile_role() = 'owner'
              or profile_id = public.current_profile_id()))
  with check (clinic_id = public.current_clinic_id()
              and (public.current_profile_role() = 'owner'
                   or profile_id = public.current_profile_id()));
drop policy if exists "notifications owner write" on public.notifications;
create policy "notifications owner write" on public.notifications
  for insert to authenticated
  with check (clinic_id = public.current_clinic_id()
              and public.current_profile_role() = 'owner');
drop policy if exists "notifications owner delete" on public.notifications;
create policy "notifications owner delete" on public.notifications
  for delete to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() = 'owner');

-- Column immutability guards. RLS policies alone cannot compare a row's old
-- and new values, so these triggers enforce which columns may never change
-- through the client-facing API. The service role (trusted server-side
-- operations) is exempt.
create or replace function public.guard_notifications_read_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (new.title is distinct from old.title
          or new.message is distinct from old.message
          or new.type is distinct from old.type
          or new.profile_id is distinct from old.profile_id
          or new.clinic_id is distinct from old.clinic_id) then
    raise exception 'only the read status of a notification can be changed';
  end if;
  return new;
end $$;

drop trigger if exists guard_notifications_read_only on public.notifications;
create trigger guard_notifications_read_only
  before update on public.notifications
  for each row execute function public.guard_notifications_read_only();

create or replace function public.guard_client_notes_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (new.author_profile_id is distinct from old.author_profile_id
          or new.clinic_id is distinct from old.clinic_id
          or new.client_id is distinct from old.client_id) then
    raise exception 'author, clinic and client of a note cannot be changed';
  end if;
  return new;
end $$;

drop trigger if exists guard_client_notes_immutable on public.client_notes;
create trigger guard_client_notes_immutable
  before update on public.client_notes
  for each row execute function public.guard_client_notes_immutable();

-- ------------------------------------------- cross-clinic reference guards
-- Foreign keys alone cannot express "must belong to the same clinic".
-- These triggers reject any row whose referenced record lives in another clinic.
create or replace function public.guard_same_clinic_refs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare ref_clinic uuid;
begin
  if to_jsonb(new) ? 'client_id' and (to_jsonb(new) ->> 'client_id') is not null then
    select clinic_id into ref_clinic from public.clients
      where id = (to_jsonb(new) ->> 'client_id')::uuid;
    if ref_clinic is distinct from new.clinic_id then
      raise exception 'client belongs to a different clinic';
    end if;
  end if;

  if to_jsonb(new) ? 'staff_id' and (to_jsonb(new) ->> 'staff_id') is not null then
    select clinic_id into ref_clinic from public.staff
      where id = (to_jsonb(new) ->> 'staff_id')::uuid;
    if ref_clinic is distinct from new.clinic_id then
      raise exception 'staff member belongs to a different clinic';
    end if;
  end if;

  if to_jsonb(new) ? 'appointment_id' and (to_jsonb(new) ->> 'appointment_id') is not null then
    select clinic_id into ref_clinic from public.appointments
      where id = (to_jsonb(new) ->> 'appointment_id')::uuid;
    if ref_clinic is distinct from new.clinic_id then
      raise exception 'appointment belongs to a different clinic';
    end if;
  end if;

  if to_jsonb(new) ? 'author_profile_id' and (to_jsonb(new) ->> 'author_profile_id') is not null then
    select clinic_id into ref_clinic from public.profiles
      where id = (to_jsonb(new) ->> 'author_profile_id')::uuid;
    if ref_clinic is distinct from new.clinic_id then
      raise exception 'author profile belongs to a different clinic';
    end if;
  end if;

  if to_jsonb(new) ? 'profile_id' and (to_jsonb(new) ->> 'profile_id') is not null then
    select clinic_id into ref_clinic from public.profiles
      where id = (to_jsonb(new) ->> 'profile_id')::uuid;
    if ref_clinic is distinct from new.clinic_id then
      raise exception 'profile belongs to a different clinic';
    end if;
  end if;

  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['staff_availability','appointments','conversations',
                           'client_notes','notifications']
  loop
    execute format('drop trigger if exists guard_clinic_refs_%1$s on public.%1$s', t);
    execute format('create trigger guard_clinic_refs_%1$s
      before insert or update on public.%1$s
      for each row execute function public.guard_same_clinic_refs()', t);
  end loop;
end $$;

-- ------------------------------------------------------------ updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['clients','staff','appointments'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format('create trigger touch_%1$s before update on public.%1$s
      for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;


-- Source: db/03_voice_operations.sql
-- Dental Zone voice operations. Run as a migration; no existing rows are removed.
begin;

-- Composite keys let checked slots enforce clinic ownership at the database level.
create unique index if not exists staff_id_clinic_id_voice_key on public.staff(id, clinic_id);

create table if not exists public.voice_operations (
  operation_key text primary key,
  clinic_id uuid not null references public.clinics(id),
  action text not null check (action in ('book','reschedule','cancel')),
  call_id text,
  caller_name text,
  caller_phone text,
  patient_name text,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists voice_operations_clinic_idx on public.voice_operations(clinic_id, created_at desc);
create index if not exists voice_operations_call_idx on public.voice_operations(clinic_id, call_id, created_at desc);
alter table public.voice_operations enable row level security;
revoke all on public.voice_operations from public, anon, authenticated;

create table if not exists public.voice_call_state (
  call_id text primary key,
  clinic_id uuid not null references public.clinics(id),
  current_check_id uuid,
  updated_at timestamptz not null default now()
);
create unique index if not exists voice_call_state_call_clinic_key on public.voice_call_state(call_id, clinic_id);
alter table public.voice_call_state enable row level security;
revoke all on public.voice_call_state from public, anon, authenticated;

-- Each returned slot is persisted before it is offered. The current check
-- pointer invalidates all slots from earlier checks for the same call.
create table if not exists public.voice_checked_slots (
  id uuid primary key,
  check_id uuid not null,
  call_id text not null,
  clinic_id uuid not null references public.clinics(id),
  staff_id uuid not null,
  service text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint voice_checked_slots_valid_time check (end_time > start_time),
  constraint voice_checked_slots_staff_clinic_fkey foreign key (staff_id, clinic_id)
    references public.staff(id, clinic_id),
  constraint voice_checked_slots_call_clinic_fkey foreign key (call_id, clinic_id)
    references public.voice_call_state(call_id, clinic_id)
);
create index if not exists voice_checked_slots_check_idx on public.voice_checked_slots(clinic_id, call_id, check_id);
create index if not exists voice_checked_slots_expiry_idx on public.voice_checked_slots(expires_at);
alter table public.voice_checked_slots enable row level security;
revoke all on public.voice_checked_slots from public, anon, authenticated;

create table if not exists public.voice_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id),
  request_key text not null unique,
  call_id text,
  kind text not null check (kind in ('message','callback','urgent')),
  caller_name text,
  patient_name text,
  phone text not null,
  reason text not null,
  status text not null default 'Open' check (status in ('Open','In Progress','Closed')),
  created_at timestamptz not null default now()
);
create index if not exists voice_requests_clinic_idx on public.voice_requests(clinic_id, created_at desc);
alter table public.voice_requests enable row level security;
revoke all on public.voice_requests from public, anon, authenticated;
grant select on public.voice_requests to authenticated;
drop policy if exists "voice requests clinic select" on public.voice_requests;
create policy "voice requests clinic select" on public.voice_requests for select to authenticated
  using (clinic_id = public.current_clinic_id() and public.current_profile_role() in ('owner','manager'));

-- Fixed service list remains public.staff.services. This function is called only by
-- the signed Retell Edge Function with a fixed server-side clinic ID.
create or replace function public.voice_apply_appointment(
  p_action text, p_clinic_id uuid, p_operation_key text, p_call_id text, p_appointment_id uuid,
  p_client_name text, p_client_phone text, p_caller_name text, p_caller_phone text,
  p_staff_id uuid, p_service text,
  p_start timestamptz, p_end timestamptz, p_check_id uuid, p_slot_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior jsonb; v_result jsonb; v_staff public.staff%rowtype;
  v_client_id uuid; v_existing public.appointments%rowtype;
  v_tz text; v_local_start timestamp; v_local_end timestamp;
begin
  if p_action is null or p_action not in ('book','reschedule','cancel') or length(coalesce(p_operation_key,'')) < 16 then
    return jsonb_build_object('success',false,'error_type','invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_operation_key, 0));
  select result into v_prior from public.voice_operations
    where operation_key = p_operation_key and clinic_id = p_clinic_id and action = p_action;
  if found then return v_prior; end if;
  if exists(select 1 from public.voice_operations where operation_key = p_operation_key) then
    return jsonb_build_object('success',false,'error_type','operation_mismatch');
  end if;
  select timezone into v_tz from public.clinics where id = p_clinic_id;
  if v_tz is null then return jsonb_build_object('success',false,'error_type','clinic_not_found'); end if;
  if p_action in ('book','reschedule') then
    perform 1 from public.voice_call_state
      where call_id = p_call_id and clinic_id = p_clinic_id and current_check_id = p_check_id
      and p_check_id is not null for update;
    if not found then return jsonb_build_object('success',false,'error_type','stale_or_invalid_slot'); end if;
    perform 1 from public.voice_checked_slots
      where id = p_slot_id and check_id = p_check_id and call_id = p_call_id
        and clinic_id = p_clinic_id and staff_id = p_staff_id and service = p_service
        and start_time = p_start and end_time = p_end and expires_at > now()
      for update;
    if not found then return jsonb_build_object('success',false,'error_type','slot_not_checked'); end if;
  end if;
  if p_action in ('reschedule','cancel') then
    select * into v_existing from public.appointments
      where id = p_appointment_id and clinic_id = p_clinic_id and status <> 'Cancelled' for update;
    if not found or v_existing.start_time <= now() then
      return jsonb_build_object('success',false,'error_type','appointment_not_found');
    end if;
    if not exists(
      select 1 from public.clients c where c.id = v_existing.client_id and c.clinic_id = p_clinic_id
        and lower(trim(c.full_name)) = lower(trim(p_client_name))
        and right(regexp_replace(c.phone,'[^0-9]','','g'),8) = right(regexp_replace(p_client_phone,'[^0-9]','','g'),8)
    ) then return jsonb_build_object('success',false,'error_type','patient_mismatch'); end if;
    if p_action = 'cancel' then
      update public.appointments set status = 'Cancelled', updated_at = now() where id = p_appointment_id;
      v_result := jsonb_build_object('success',true,'appointment_cancelled',true,'appointment_id',p_appointment_id);
      insert into public.voice_operations(operation_key,clinic_id,action,call_id,caller_name,caller_phone,patient_name,result)
        values (p_operation_key,p_clinic_id,p_action,p_call_id,p_caller_name,p_caller_phone,p_client_name,v_result);
      return v_result;
    end if;
  end if;
  if nullif(trim(coalesce(p_client_name,'')),'') is null or
     p_client_phone is null or p_client_phone !~ '^[+]965[0-9]{8}$' or p_staff_id is null or
     nullif(trim(coalesce(p_service,'')),'') is null or p_start is null or p_end is null or
     p_start <= now() or p_end <= p_start then
    return jsonb_build_object('success',false,'error_type','invalid_request');
  end if;
  select * into v_staff from public.staff where id = p_staff_id and clinic_id = p_clinic_id and active;
  if not found then return jsonb_build_object('success',false,'error_type','practitioner_not_found'); end if;
  if not p_service = any(v_staff.services) then
    return jsonb_build_object('success',false,'error_type','service_mismatch');
  end if;
  v_local_start := p_start at time zone v_tz;
  v_local_end := p_end at time zone v_tz;
  if extract(second from v_local_start) <> 0 or
     not exists(
       select 1 from public.staff_availability a where a.clinic_id = p_clinic_id
         and a.staff_id = p_staff_id and a.is_available
         and a.day_of_week = extract(dow from v_local_start)::int
         and a.start_time <= v_local_start::time and a.end_time >= v_local_end::time
     ) or exists(
       select 1 from public.staff_time_off t where t.clinic_id = p_clinic_id and t.staff_id = p_staff_id
         and t.start_time < p_end and t.end_time > p_start
     ) then return jsonb_build_object('success',false,'error_type','slot_unavailable'); end if;
  if exists(
    select 1 from public.appointments a where a.clinic_id = p_clinic_id and a.staff_id = p_staff_id
      and a.status <> 'Cancelled' and a.id is distinct from p_appointment_id
      and a.start_time < p_end and a.end_time > p_start
  ) then return jsonb_build_object('success',false,'error_type','slot_conflict'); end if;
  begin
    if p_action = 'book' then
      perform pg_advisory_xact_lock(hashtextextended(p_clinic_id::text || p_client_phone || lower(trim(p_client_name)), 0));
      select id into v_client_id from public.clients c where c.clinic_id = p_clinic_id
        and lower(trim(c.full_name)) = lower(trim(p_client_name))
        and right(regexp_replace(c.phone,'[^0-9]','','g'),8) = right(regexp_replace(p_client_phone,'[^0-9]','','g'),8)
        order by created_at limit 1;
      if v_client_id is null then
        insert into public.clients(clinic_id,full_name,phone) values(p_clinic_id,trim(p_client_name),p_client_phone)
          returning id into v_client_id;
      end if;
      insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time,status,source)
        values(p_clinic_id,v_client_id,p_staff_id,p_service,p_start,p_end,'Booked','Booked by Apero')
        returning id into p_appointment_id;
    else
      update public.appointments set staff_id = p_staff_id, service = p_service,
        start_time = p_start, end_time = p_end, updated_at = now()
        where id = p_appointment_id;
    end if;
  exception when exclusion_violation then
    return jsonb_build_object('success',false,'error_type','slot_conflict');
  end;
  v_result := jsonb_build_object('success',true,'appointment_booked',p_action='book',
    'appointment_rescheduled',p_action='reschedule','appointment_id',p_appointment_id,
    'staff_id',p_staff_id,'service_name',p_service,'start_time',p_start);
  insert into public.voice_operations(operation_key,clinic_id,action,call_id,caller_name,caller_phone,patient_name,result)
    values(p_operation_key,p_clinic_id,p_action,p_call_id,p_caller_name,p_caller_phone,p_client_name,v_result);
  update public.voice_call_state set current_check_id = null, updated_at = now()
    where call_id = p_call_id and clinic_id = p_clinic_id;
  return v_result;
end $$;
revoke all on function public.voice_apply_appointment(text,uuid,text,text,uuid,text,text,text,text,uuid,text,timestamptz,timestamptz,uuid,uuid) from public, anon, authenticated;
grant execute on function public.voice_apply_appointment(text,uuid,text,text,uuid,text,text,text,text,uuid,text,timestamptz,timestamptz,uuid,uuid) to service_role;

commit;

-- Source: db/04_voice_service_role_grants.sql
-- Follow-up to 03_voice_operations.sql: service_role needs table privileges
-- in addition to bypassing RLS. Grants are safe to run more than once.
begin;

grant select on public.voice_operations to service_role;
grant select, insert, update on public.voice_call_state to service_role;
grant insert on public.voice_checked_slots to service_role;
grant select, insert on public.voice_requests to service_role;

commit;

-- Source: db/05_voice_integrations.sql
-- Apply after 03_voice_operations.sql and 04_voice_service_role_grants.sql. Keep credentials in Supabase Edge Function
-- secrets; this server-only table stores environment variable NAMES, never keys.
begin;
create table if not exists public.voice_integrations (
  clinic_id uuid primary key references public.clinics(id),
  workspace_id text not null unique,
  agent_id text not null unique,
  conversation_flow_id text,
  knowledge_base_id text,
  secret_env_name text not null unique check (secret_env_name ~ '^RETELL_[A-Z0-9_]+$'),
  phone_number text,
  dialing_prefix text not null default '+965' check (dialing_prefix ~ '^[+][0-9]{1,4}$'),
  local_number_length integer not null default 8 check (local_number_length between 6 and 14),
  slot_minutes integer not null default 45 check (slot_minutes between 15 and 180),
  transfer_number text,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.voice_integrations enable row level security;
revoke all on public.voice_integrations from public, anon, authenticated;
grant select, insert, update, delete on public.voice_integrations to service_role;
-- Global Retell call IDs must never be reassigned to another tenant on upsert.
create or replace function public.voice_reject_clinic_change() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.clinic_id is distinct from old.clinic_id then
    raise exception 'voice clinic ownership cannot change';
  end if;
  return new;
end $$;
revoke all on function public.voice_reject_clinic_change() from public, anon, authenticated;
drop trigger if exists voice_call_state_clinic_guard on public.voice_call_state;
create trigger voice_call_state_clinic_guard before update on public.voice_call_state
for each row execute function public.voice_reject_clinic_change();
drop trigger if exists conversations_voice_clinic_guard on public.conversations;
create trigger conversations_voice_clinic_guard before update on public.conversations
for each row when (old.retell_call_id is not null)
execute function public.voice_reject_clinic_change();
-- Clinic-owned service synonyms; canonical services remain staff.services.
create table if not exists public.clinic_service_aliases (
  clinic_id uuid not null references public.clinics(id),
  service text not null,
  alias text not null,
  primary key (clinic_id, service, alias)
);
alter table public.clinic_service_aliases enable row level security;
revoke all on public.clinic_service_aliases from public, anon, authenticated;
grant select, insert, update, delete on public.clinic_service_aliases to service_role;
alter table public.staff add column if not exists aliases text[] not null default '{}';
-- Reapply appointment RPC with per-clinic phone validation.
create or replace function public.voice_apply_appointment(
  p_action text, p_clinic_id uuid, p_operation_key text, p_call_id text, p_appointment_id uuid,
  p_client_name text, p_client_phone text, p_caller_name text, p_caller_phone text,
  p_staff_id uuid, p_service text,
  p_start timestamptz, p_end timestamptz, p_check_id uuid, p_slot_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior jsonb; v_result jsonb; v_staff public.staff%rowtype;
  v_client_id uuid; v_existing public.appointments%rowtype;
  v_tz text; v_local_start timestamp; v_local_end timestamp;
  v_prefix text; v_phone_length integer;
begin
  if p_action is null or p_action not in ('book','reschedule','cancel') or length(coalesce(p_operation_key,'')) < 16 then
    return jsonb_build_object('success',false,'error_type','invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_operation_key, 0));
  select result into v_prior from public.voice_operations
    where operation_key = p_operation_key and clinic_id = p_clinic_id and action = p_action;
  if found then return v_prior; end if;
  if exists(select 1 from public.voice_operations where operation_key = p_operation_key) then
    return jsonb_build_object('success',false,'error_type','operation_mismatch');
  end if;
  select timezone into v_tz from public.clinics where id = p_clinic_id;
  select dialing_prefix, local_number_length into v_prefix, v_phone_length from public.voice_integrations where clinic_id = p_clinic_id and active;
  if v_prefix is null then return jsonb_build_object('success',false,'error_type','integration_inactive'); end if;
  if v_tz is null then return jsonb_build_object('success',false,'error_type','clinic_not_found'); end if;
  if p_action in ('book','reschedule') then
    perform 1 from public.voice_call_state
      where call_id = p_call_id and clinic_id = p_clinic_id and current_check_id = p_check_id
      and p_check_id is not null for update;
    if not found then return jsonb_build_object('success',false,'error_type','stale_or_invalid_slot'); end if;
    perform 1 from public.voice_checked_slots
      where id = p_slot_id and check_id = p_check_id and call_id = p_call_id
        and clinic_id = p_clinic_id and staff_id = p_staff_id and service = p_service
        and start_time = p_start and end_time = p_end and expires_at > now()
      for update;
    if not found then return jsonb_build_object('success',false,'error_type','slot_not_checked'); end if;
  end if;
  if p_action in ('reschedule','cancel') then
    select * into v_existing from public.appointments
      where id = p_appointment_id and clinic_id = p_clinic_id and status <> 'Cancelled' for update;
    if not found or v_existing.start_time <= now() then
      return jsonb_build_object('success',false,'error_type','appointment_not_found');
    end if;
    if not exists(
      select 1 from public.clients c where c.id = v_existing.client_id and c.clinic_id = p_clinic_id
        and lower(trim(c.full_name)) = lower(trim(p_client_name))
        and right(regexp_replace(c.phone,'[^0-9]','','g'),v_phone_length) = right(regexp_replace(p_client_phone,'[^0-9]','','g'),v_phone_length)
    ) then return jsonb_build_object('success',false,'error_type','patient_mismatch'); end if;
    if p_action = 'cancel' then
      update public.appointments set status = 'Cancelled', updated_at = now() where id = p_appointment_id;
      v_result := jsonb_build_object('success',true,'appointment_cancelled',true,'appointment_id',p_appointment_id);
      insert into public.voice_operations(operation_key,clinic_id,action,call_id,caller_name,caller_phone,patient_name,result)
        values (p_operation_key,p_clinic_id,p_action,p_call_id,p_caller_name,p_caller_phone,p_client_name,v_result);
      return v_result;
    end if;
  end if;
  if nullif(trim(coalesce(p_client_name,'')),'') is null or
     p_client_phone is null or p_client_phone !~ ('^[+]' || substring(v_prefix from 2) || '[0-9]{' || v_phone_length || '}$') or p_staff_id is null or
     nullif(trim(coalesce(p_service,'')),'') is null or p_start is null or p_end is null or
     p_start <= now() or p_end <= p_start then
    return jsonb_build_object('success',false,'error_type','invalid_request');
  end if;
  select * into v_staff from public.staff where id = p_staff_id and clinic_id = p_clinic_id and active;
  if not found then return jsonb_build_object('success',false,'error_type','practitioner_not_found'); end if;
  if not p_service = any(v_staff.services) then
    return jsonb_build_object('success',false,'error_type','service_mismatch');
  end if;
  v_local_start := p_start at time zone v_tz;
  v_local_end := p_end at time zone v_tz;
  if extract(second from v_local_start) <> 0 or
     not exists(
       select 1 from public.staff_availability a where a.clinic_id = p_clinic_id
         and a.staff_id = p_staff_id and a.is_available
         and a.day_of_week = extract(dow from v_local_start)::int
         and a.start_time <= v_local_start::time and a.end_time >= v_local_end::time
     ) or exists(
       select 1 from public.staff_time_off t where t.clinic_id = p_clinic_id and t.staff_id = p_staff_id
         and t.start_time < p_end and t.end_time > p_start
     ) then return jsonb_build_object('success',false,'error_type','slot_unavailable'); end if;
  if exists(
    select 1 from public.appointments a where a.clinic_id = p_clinic_id and a.staff_id = p_staff_id
      and a.status <> 'Cancelled' and a.id is distinct from p_appointment_id
      and a.start_time < p_end and a.end_time > p_start
  ) then return jsonb_build_object('success',false,'error_type','slot_conflict'); end if;
  begin
    if p_action = 'book' then
      perform pg_advisory_xact_lock(hashtextextended(p_clinic_id::text || p_client_phone || lower(trim(p_client_name)), 0));
      select id into v_client_id from public.clients c where c.clinic_id = p_clinic_id
        and lower(trim(c.full_name)) = lower(trim(p_client_name))
        and right(regexp_replace(c.phone,'[^0-9]','','g'),v_phone_length) = right(regexp_replace(p_client_phone,'[^0-9]','','g'),v_phone_length)
        order by created_at limit 1;
      if v_client_id is null then
        insert into public.clients(clinic_id,full_name,phone) values(p_clinic_id,trim(p_client_name),p_client_phone)
          returning id into v_client_id;
      end if;
      insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time,status,source)
        values(p_clinic_id,v_client_id,p_staff_id,p_service,p_start,p_end,'Booked','Booked by Apero')
        returning id into p_appointment_id;
    else
      update public.appointments set staff_id = p_staff_id, service = p_service,
        start_time = p_start, end_time = p_end, updated_at = now()
        where id = p_appointment_id;
    end if;
  exception when exclusion_violation then
    return jsonb_build_object('success',false,'error_type','slot_conflict');
  end;
  v_result := jsonb_build_object('success',true,'appointment_booked',p_action='book',
    'appointment_rescheduled',p_action='reschedule','appointment_id',p_appointment_id,
    'staff_id',p_staff_id,'service_name',p_service,'start_time',p_start);
  insert into public.voice_operations(operation_key,clinic_id,action,call_id,caller_name,caller_phone,patient_name,result)
    values(p_operation_key,p_clinic_id,p_action,p_call_id,p_caller_name,p_caller_phone,p_client_name,v_result);
  update public.voice_call_state set current_check_id = null, updated_at = now()
    where call_id = p_call_id and clinic_id = p_clinic_id;
  return v_result;
end $$;
revoke all on function public.voice_apply_appointment(text,uuid,text,text,uuid,text,text,text,text,uuid,text,timestamptz,timestamptz,uuid,uuid) from public, anon, authenticated;
grant execute on function public.voice_apply_appointment(text,uuid,text,text,uuid,text,text,text,text,uuid,text,timestamptz,timestamptz,uuid,uuid) to service_role;
commit;

-- Source: db/06_staff_scheduling.sql
-- Apply after 01_phase2_schema.sql. Aligns the live multi-shift schema with
-- the dashboard's one weekly interval per practitioner/day editor.
-- All DDL runs in one transaction so an error leaves the schema unchanged.
begin;

-- Fail if duplicate shifts must first be reconciled by a clinic owner.
do $$
begin
  if exists (
    select 1 from public.staff_availability
    group by staff_id, day_of_week having count(*) > 1
  ) then
    raise exception 'staff_availability has multiple shifts for a staff member and day; reconcile before applying';
  end if;
end $$;

create unique index if not exists staff_availability_staff_day_idx
  on public.staff_availability (staff_id, day_of_week);

create table if not exists public.staff_time_off (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  start_time timestamptz not null,
  end_time timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint staff_time_off_valid_time check (end_time > start_time)
);
create index if not exists staff_time_off_lookup_idx
  on public.staff_time_off (clinic_id, staff_id, start_time, end_time);

-- A staff reference must belong to the same clinic as the schedule or leave.
create unique index if not exists staff_clinic_id_id_idx on public.staff (clinic_id, id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'staff_availability_same_clinic_fkey') then
    alter table public.staff_availability add constraint staff_availability_same_clinic_fkey
      foreign key (clinic_id, staff_id) references public.staff (clinic_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_time_off_same_clinic_fkey') then
    alter table public.staff_time_off add constraint staff_time_off_same_clinic_fkey
      foreign key (clinic_id, staff_id) references public.staff (clinic_id, id) on delete cascade;
  end if;
end $$;

grant select, insert, update, delete on public.staff_time_off to authenticated;
grant select on public.staff_time_off to service_role;
alter table public.staff_time_off enable row level security;
drop policy if exists "staff time off select" on public.staff_time_off;
create policy "staff time off select" on public.staff_time_off
  for select to authenticated using (clinic_id = public.current_clinic_id());
drop policy if exists "staff time off write" on public.staff_time_off;
create policy "staff time off write" on public.staff_time_off
  for all to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() in ('owner','manager'))
  with check (clinic_id = public.current_clinic_id()
              and public.current_profile_role() in ('owner','manager'));

-- Create a practitioner and selected hours in one transaction. A failed shift
-- insert rolls back the staff row, so Add Staff cannot report partial success.
create or replace function public.create_staff_with_schedule(
  p_full_name text,
  p_specialty text,
  p_phone text,
  p_email text,
  p_services text[],
  p_schedule jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_clinic_id uuid := public.current_clinic_id();
  v_row record;
begin
  if v_clinic_id is null or public.current_profile_role() not in ('owner', 'manager') then
    raise exception 'Not authorized to add staff';
  end if;
  if nullif(trim(p_full_name), '') is null or nullif(trim(p_specialty), '') is null then
    raise exception 'Name and specialty are required';
  end if;
  if p_schedule is null or jsonb_typeof(p_schedule) <> 'array' then
    raise exception 'Schedule must be an array';
  end if;
  if (select count(*) <> count(distinct day_of_week)
      from jsonb_to_recordset(p_schedule) as r(day_of_week int)) then
    raise exception 'Each day may appear only once';
  end if;

  insert into public.staff (clinic_id, full_name, specialty, phone, email, services)
  values (v_clinic_id, trim(p_full_name), trim(p_specialty),
          nullif(trim(p_phone), ''), nullif(trim(p_email), ''), coalesce(p_services, '{}'))
  returning id into v_staff_id;

  for v_row in select * from jsonb_to_recordset(p_schedule) as r(
    day_of_week int, start_time text, end_time text, is_available boolean
  ) loop
    if v_row.day_of_week not between 0 and 6 or v_row.is_available is null then
      raise exception 'Invalid schedule day';
    end if;
    if nullif(v_row.start_time, '') is null and nullif(v_row.end_time, '') is null
       and not v_row.is_available then
      continue;
    end if;
    if nullif(v_row.start_time, '') is null or nullif(v_row.end_time, '') is null then
      raise exception 'Working hours require start and end times';
    end if;
    insert into public.staff_availability
      (clinic_id, staff_id, day_of_week, start_time, end_time, is_available)
    values (v_clinic_id, v_staff_id, v_row.day_of_week,
            v_row.start_time::time, v_row.end_time::time, v_row.is_available);
  end loop;
  return v_staff_id;
end $$;
revoke all on function public.create_staff_with_schedule(text,text,text,text,text[],jsonb) from public, anon;
grant execute on function public.create_staff_with_schedule(text,text,text,text,text[],jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

-- Source: db/07_prelaunch_security.sql
-- Pre-launch authorization hardening. Review and apply separately.
-- Conversations are written by the signed Retell webhook through service_role;
-- the dashboard only reads them. Browser roles must not forge call records.
begin;

revoke insert, update, delete on public.conversations from authenticated;
drop policy if exists "conversations write" on public.conversations;

-- The profile email mirrors the Auth account. A browser may change its display
-- name and phone, but must not make this mirror disagree with auth.users.
create or replace function public.guard_profile_sensitive_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (new.clinic_id is distinct from old.clinic_id
          or new.role is distinct from old.role
          or new.auth_user_id is distinct from old.auth_user_id
          or new.email is distinct from old.email) then
    raise exception 'profile identity fields cannot be changed';
  end if;
  return new;
end $$;

revoke all on function public.guard_profile_sensitive_fields() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;

-- Source: db/08_voice_requests_handling.sql
-- Allow clinic owners and managers to close Sara requests from the dashboard.
-- Apply manually after review. No existing request rows are changed.
begin;

grant update (status) on public.voice_requests to authenticated;

drop policy if exists "voice requests clinic update status" on public.voice_requests;
create policy "voice requests clinic update status" on public.voice_requests
  for update to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() in ('owner', 'manager'))
  with check (clinic_id = public.current_clinic_id()
              and public.current_profile_role() in ('owner', 'manager'));

notify pgrst, 'reload schema';
commit;

-- Source: db/09_client_notes_restrict_update.sql
-- The clinic dashboard can add client notes but cannot edit them. Keep existing
-- notes readable, but prevent authenticated browser clients from rewriting them.
-- Review and apply separately; this file does not alter existing rows.
begin;

revoke update on public.client_notes from authenticated;
drop policy if exists "client notes update" on public.client_notes;

notify pgrst, 'reload schema';
commit;
