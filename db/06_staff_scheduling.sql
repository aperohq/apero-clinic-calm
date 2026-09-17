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
