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
  with check (clinic_id = public.current_clinic_id()
              and author_profile_id = public.current_profile_id());
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
              and profile_id = public.current_profile_id());
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

-- ----------------------------------------------------- development seed
insert into public.clinics (id, name, phone, email, timezone)
values ('11111111-1111-4111-8111-111111111111', 'Dental Zone Clinic',
        '+965 2225 4100', 'reception@dentalzone.com', 'Asia/Kuwait')
on conflict (id) do nothing;

insert into public.staff (id, clinic_id, full_name, specialty, phone, email, services) values
 ('21111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','Dr. Ahmed Qandil','General Dentistry','+965 2225 4100','ahmed.qandil@dentalzone.com','{"Dental Cleaning","Consultation","Root Canal"}'),
 ('21111111-1111-4111-8111-111111111112','11111111-1111-4111-8111-111111111111','Dr. Mohammed Shuqeir','Cosmetic Dentistry','+965 2225 4101','mohammed@dentalzone.com','{"Veneers Consultation","Teeth Whitening"}'),
 ('21111111-1111-4111-8111-111111111113','11111111-1111-4111-8111-111111111111','Dr. Fatima Hassan','Orthodontics','+965 2225 4102','fatima@dentalzone.com','{"Orthodontic Consultation","Braces Review"}'),
 ('21111111-1111-4111-8111-111111111114','11111111-1111-4111-8111-111111111111','Layla Salem','Dental Hygiene','+965 2225 4103','layla@dentalzone.com','{"Dental Cleaning","Preventive Care"}')
on conflict (id) do nothing;

insert into public.staff_availability (clinic_id, staff_id, day_of_week, start_time, end_time, is_available)
select '11111111-1111-4111-8111-111111111111', s.id, d,
       '09:00'::time, '17:00'::time, d between 1 and 4
from public.staff s cross join generate_series(0,6) as d
where s.clinic_id = '11111111-1111-4111-8111-111111111111'
on conflict (staff_id, day_of_week) do nothing;

insert into public.clients (id, clinic_id, full_name, phone, email, notes) values
 ('31111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','Sarah Al-Hamad','+965 9912 3456','sarah.hamad@example.com','Prefers morning appointments before 11 AM.'),
 ('31111111-1111-4111-8111-111111111112','11111111-1111-4111-8111-111111111111','Mohamed Mahmoud','+965 9587 4568','m.mahmoud@example.com',null),
 ('31111111-1111-4111-8111-111111111113','11111111-1111-4111-8111-111111111111','Fatima Al-Kandari','+965 9443 2190','f.alkandari@example.com',null),
 ('31111111-1111-4111-8111-111111111114','11111111-1111-4111-8111-111111111111','Tariq Mansour','+965 6658 7701','tariq.m@example.com',null),
 ('31111111-1111-4111-8111-111111111115','11111111-1111-4111-8111-111111111111','Noura Al-Sabah','+965 9771 8004','noura.s@example.com',null)
on conflict (id) do nothing;

insert into public.appointments (id, clinic_id, client_id, staff_id, service, start_time, end_time, status, source) values
 ('41111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111111','21111111-1111-4111-8111-111111111111','Dental Cleaning',(date_trunc('week', now()) + interval '7 hours 30 minutes'),(date_trunc('week', now()) + interval '8 hours 15 minutes'),'Booked','Booked by Apero'),
 ('41111111-1111-4111-8111-111111111112','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111112','21111111-1111-4111-8111-111111111114','Dental Cleaning',(date_trunc('week', now()) + interval '2 days 6 hours'),(date_trunc('week', now()) + interval '2 days 6 hours 45 minutes'),'Booked','Booked by Apero'),
 ('41111111-1111-4111-8111-111111111113','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111113','21111111-1111-4111-8111-111111111113','Orthodontic Consultation',(date_trunc('week', now()) + interval '1 day 10 hours'),(date_trunc('week', now()) + interval '1 day 11 hours'),'Booked','Front desk'),
 ('41111111-1111-4111-8111-111111111114','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111115','21111111-1111-4111-8111-111111111112','Veneers Consultation',(date_trunc('week', now()) + interval '3 days 12 hours 30 minutes'),(date_trunc('week', now()) + interval '3 days 13 hours 15 minutes'),'Booked','Booked by Apero')
on conflict (id) do nothing;

insert into public.conversations (id, clinic_id, client_id, appointment_id, title, status, outcome, caller_phone, started_at, duration_seconds, summary, transcript) values
 ('51111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111111','41111111-1111-4111-8111-111111111111','Appointment Booking Call','Booked','Appointment booked','+965 9912 3456',(now() - interval '2 hours'),135,'Sarah called to schedule a dental cleaning. Apero confirmed her details, checked real-time availability, and booked an appointment with Dr. Ahmed Qandil for Monday, September 14 at 10:30 AM.',
  '[{"speaker":"Apero Receptionist","text":"Good morning, thank you for calling Dental Zone Clinic. How can I help you today?","time":"00:01"},{"speaker":"Sarah Al-Hamad","text":"Hi, I''d like to book an appointment for a routine dental cleaning.","time":"00:07"},{"speaker":"Apero Receptionist","text":"Of course! What day and time works best for you?","time":"00:13"},{"speaker":"Sarah Al-Hamad","text":"Next Monday morning if possible, with Dr. Ahmed.","time":"00:20"},{"speaker":"Apero Receptionist","text":"Dr. Ahmed has an opening next Monday, September 14th at 10:30 AM. Would that suit your schedule?","time":"00:26"},{"speaker":"Sarah Al-Hamad","text":"Yes, that works perfectly.","time":"00:35"},{"speaker":"Apero Receptionist","text":"Wonderful. May I confirm your full name and phone number?","time":"00:38"},{"speaker":"Sarah Al-Hamad","text":"Sarah Al-Hamad, +965 9912 3456.","time":"00:43"},{"speaker":"Apero Receptionist","text":"Thank you, Sarah. You are confirmed for Monday, Sep 14 at 10:30 AM. A confirmation message has been sent.","time":"00:50"}]'::jsonb),
 ('51111111-1111-4111-8111-111111111112','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111112','41111111-1111-4111-8111-111111111112','Clinic Hours & Cleaning','Booked','Appointment booked','+965 9587 4568',(now() - interval '5 hours'),108,'Mohamed asked about clinic hours and booked a cleaning.',null),
 ('51111111-1111-4111-8111-111111111113','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111113',null,'Treatment Follow-up','Needs Review','Callback requested','+965 9443 2190',(now() - interval '1 day'),182,'Fatima requested a call back about her orthodontic treatment plan.',null),
 ('51111111-1111-4111-8111-111111111114','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111114',null,'Missed Call','Missed','No request collected','+965 6658 7701',(now() - interval '1 day 3 hours'),34,'The caller disconnected before a request was collected.',null),
 ('51111111-1111-4111-8111-111111111115','11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111115','41111111-1111-4111-8111-111111111114','Veneers Consultation','Booked','Appointment booked','+965 9771 8004',(now() - interval '2 days'),141,'Noura booked a veneers consultation with Dr. Mohammed.',null)
on conflict (id) do nothing;

insert into public.client_notes (clinic_id, client_id, note)
select '11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111111',
       'Patient prefers morning appointments before 11 AM.'
where not exists (select 1 from public.client_notes);
