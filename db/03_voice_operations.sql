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
