-- Local proposal only. No rows are rewritten and existing RLS is retained.
-- Dashboard had no database schedule guard or shared availability API.
begin;

-- Run db/audits/appointment_readiness.sql first for the full record-level report.
-- Keep this check and final constraint installation in one snapshot protected
-- from intervening writes. This lock requires an operator-planned window.
lock table public.appointments in access exclusive mode;
do $$
declare v_records jsonb;
begin
  select jsonb_agg(jsonb_build_object('appointment_id',id,'clinic_id',clinic_id,'status',status))
    into v_records from public.appointments
    where lower(btrim(status)) in ('cancelled','canceled') and status <> 'Cancelled';
  if v_records is not null then
    raise exception 'Appointment preflight: noncanonical cancellation statuses require review'
      using errcode='22023', detail=v_records::text,
            hint='Review the read-only appointment readiness report; no status is changed automatically.';
  end if;
  select jsonb_agg(jsonb_build_object('appointment_id',id,'clinic_id',clinic_id,'start_time',start_time,'end_time',end_time))
    into v_records from public.appointments
    where status <> 'Cancelled' and
      (start_time is null or end_time is null or not isfinite(start_time) or not isfinite(end_time) or end_time < start_time);
  if v_records is not null then
    raise exception 'Appointment preflight: non-cancelled reversed or non-finite intervals prevent exclusion installation'
      using errcode='22023', detail=v_records::text,
            hint='Review these records separately. History is never deleted or repaired by this migration.';
  end if;
  select jsonb_agg(jsonb_build_object('clinic_id',a.clinic_id,'practitioner_id',a.staff_id,
                                    'appointment_a',a.id,'appointment_b',b.id))
    into v_records from public.appointments a join public.appointments b
      on a.clinic_id=b.clinic_id and a.staff_id=b.staff_id and a.id < b.id
      and a.status <> 'Cancelled' and b.status <> 'Cancelled'
      and a.end_time > a.start_time and b.end_time > b.start_time
      and a.start_time < b.end_time and a.end_time > b.start_time;
  if v_records is not null then
    raise exception 'Appointment preflight: historical overlaps prevent exclusion installation'
      using errcode='23P01', detail=v_records::text,
            hint='The read-only readiness report lists conflicting appointment pairs. No history is changed.';
  end if;
end $$;

create extension if not exists btree_gist;

-- Expose only the configured booking duration, never voice credentials/config.
create or replace function public.appointment_booking_minutes(p_clinic_id uuid)
returns integer language plpgsql stable security definer
set search_path = public, pg_temp as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role'
     and p_clinic_id is distinct from public.current_clinic_id() then
    raise exception 'Clinic access denied' using errcode = '42501';
  end if;
  return coalesce((select slot_minutes from public.voice_integrations
                   where clinic_id=p_clinic_id and active),45);
end $$;
revoke all on function public.appointment_booking_minutes(uuid) from public, anon;
grant execute on function public.appointment_booking_minutes(uuid) to authenticated, service_role;

-- One predicate used by slot discovery and writes from both booking channels.
create or replace function public.appointment_slot_open(
  p_clinic_id uuid, p_staff_id uuid, p_service text,
  p_start timestamptz, p_end timestamptz, p_exclude_id uuid default null
) returns boolean language sql stable security invoker
set search_path = public, pg_temp as $$
  select coalesce(p_start > now() and p_end > p_start
    and extract(second from p_start) = 0
    and exists (
      select 1 from public.staff s join public.clinics c on c.id=s.clinic_id
      join public.staff_availability a on a.clinic_id=s.clinic_id and a.staff_id=s.id
      where s.clinic_id=p_clinic_id and s.id=p_staff_id and s.active
        and p_service=any(s.services) and a.is_available
        and (p_start at time zone c.timezone)::date=(p_end at time zone c.timezone)::date
        and a.day_of_week=extract(dow from p_start at time zone c.timezone)::int
        and a.start_time <= (p_start at time zone c.timezone)::time
        and a.end_time >= (p_end at time zone c.timezone)::time
    ) and not exists (
      select 1 from public.staff_time_off t where t.clinic_id=p_clinic_id and t.staff_id=p_staff_id
        and t.start_time < p_end and t.end_time > p_start
    ) and not exists (
      select 1 from public.appointments a where a.clinic_id=p_clinic_id and a.staff_id=p_staff_id
        and a.status <> 'Cancelled' and a.id is distinct from p_exclude_id
        and a.start_time < p_end and a.end_time > p_start
    ), false)
$$;
revoke all on function public.appointment_slot_open(uuid,uuid,text,timestamptz,timestamptz,uuid) from public, anon;
grant execute on function public.appointment_slot_open(uuid,uuid,text,timestamptz,timestamptz,uuid) to authenticated, service_role;

create or replace function public.appointment_available_slots(
  p_clinic_id uuid, p_staff_id uuid, p_service text, p_date date,
  p_exclude_id uuid default null
) returns table(start_time timestamptz,end_time timestamptz,duration_minutes integer)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_zone text; v_minutes integer; v_seconds numeric; v_existing public.appointments%rowtype;
  v_shift record; v_local timestamp; v_start timestamptz; v_end timestamptz;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role'
     and p_clinic_id is distinct from public.current_clinic_id() then
    raise exception 'Clinic access denied' using errcode='42501';
  end if;
  select timezone into v_zone from public.clinics where id=p_clinic_id;
  if v_zone is null then raise exception 'Clinic timezone unavailable'; end if;
  v_minutes := public.appointment_booking_minutes(p_clinic_id);
  if p_exclude_id is not null then
    select * into v_existing from public.appointments where id=p_exclude_id and clinic_id=p_clinic_id
      and status='Booked' and staff_id=p_staff_id and service=p_service;
    if not found then raise exception 'Appointment unavailable'; end if;
    if not isfinite(v_existing.start_time) or not isfinite(v_existing.end_time)
       or v_existing.end_time <= v_existing.start_time then
      raise exception 'Legacy appointment has an invalid interval; cancel or annotate it without changing its booking fields'
        using errcode='22023';
    end if;
    v_seconds := extract(epoch from v_existing.end_time-v_existing.start_time);
    -- Public slot/RPC contracts use integer minutes. Never offer a truncated
    -- legacy interval which the exact-duration write guard would then reject.
    if mod(v_seconds,60) <> 0 or v_seconds not between 60 and 86400 then
      raise exception 'Legacy appointment duration is not supported by whole-minute slots; no reschedule slots were offered'
        using errcode='22023';
    end if;
    v_minutes := (v_seconds / 60)::integer;
  end if;
  if v_minutes not between 1 and 1440 then raise exception 'Invalid booking duration'; end if;
  for v_shift in select a.start_time,a.end_time from public.staff_availability a
    where a.clinic_id=p_clinic_id and a.staff_id=p_staff_id and a.is_available
      and a.day_of_week=extract(dow from p_date)::int
  loop
    -- Preserve the existing voice slot cadence: first half-hour boundary,
    -- then configured appointment duration. Generate clinic wall times.
    v_local := date_trunc('hour',p_date + v_shift.start_time)
      + ceil(extract(minute from v_shift.start_time)/30.0)*interval '30 minutes';
    while v_local + make_interval(mins=>v_minutes) <= p_date + v_shift.end_time loop
      v_start := v_local at time zone v_zone;
      v_end := v_start + make_interval(mins=>v_minutes);
      -- Skip nonexistent DST wall times rather than silently shifting them.
      if v_start at time zone v_zone = v_local and
         public.appointment_slot_open(p_clinic_id,p_staff_id,p_service,v_start,v_end,p_exclude_id) then
        start_time:=v_start; end_time:=v_end; duration_minutes:=v_minutes; return next;
      end if;
      v_local := v_local + make_interval(mins=>v_minutes);
    end loop;
  end loop;
end $$;
revoke all on function public.appointment_available_slots(uuid,uuid,text,date,uuid) from public, anon;
grant execute on function public.appointment_available_slots(uuid,uuid,text,date,uuid) to authenticated, service_role;

-- Invoker preserves RLS. Foreign-reference guards already protect linkage.
-- Cancelling or annotating a historic appointment must not require new availability.
create or replace function public.guard_appointment_booking()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_booking_unchanged boolean;
begin
  if tg_op='UPDATE' then
    if new.id is distinct from old.id then raise exception 'Appointment identity cannot change'; end if;
    if new.clinic_id is distinct from old.clinic_id then
      raise exception 'Appointment clinic cannot change' using errcode='42501';
    end if;
    -- RI SET NULL executes a nested UPDATE after the referenced row is gone.
    -- Require that context, actual row absence, and no other changed fields.
    -- Browser roles have no TRIGGER privileges and cannot fake a deletion by
    -- just setting staff_id/client_id to NULL while the referenced row exists.
    if pg_trigger_depth() > 1 then
      if old.staff_id is not null and new.staff_id is null
         and (to_jsonb(new)-'staff_id'-'updated_at') = (to_jsonb(old)-'staff_id'-'updated_at')
         and not exists(select 1 from public.staff where id=old.staff_id and clinic_id=old.clinic_id) then
        return new;
      end if;
      -- Retain the existing client ON DELETE SET NULL contract for the same reason.
      if old.client_id is not null and new.client_id is null
         and (to_jsonb(new)-'client_id'-'updated_at') = (to_jsonb(old)-'client_id'-'updated_at')
         and not exists(select 1 from public.clients where id=old.client_id and clinic_id=old.clinic_id) then
        return new;
      end if;
    end if;
    v_booking_unchanged := row(new.client_id,new.staff_id,new.service,new.start_time,new.end_time)
      is not distinct from row(old.client_id,old.staff_id,old.service,old.start_time,old.end_time);
    if new.status='Cancelled' then
      if not v_booking_unchanged then raise exception 'Cancellation must preserve the appointment'; end if;
      return new;
    end if;
    if v_booking_unchanged and new.status is not distinct from old.status then return new; end if;
    -- Invalid legacy intervals remain immutable; cancellation and metadata
    -- updates above are safe, but a reschedule must not silently repair history.
    if old.start_time is null or old.end_time is null or not isfinite(old.start_time)
       or not isfinite(old.end_time) or old.end_time <= old.start_time then
      raise exception 'Invalid legacy appointment booking fields cannot change' using errcode='22023';
    end if;
    if old.status <> 'Booked' or new.status <> 'Booked' then
      raise exception 'Only booked appointments can be rescheduled';
    end if;
    if new.client_id is distinct from old.client_id or new.staff_id is distinct from old.staff_id
       or new.service is distinct from old.service or
       new.end_time-new.start_time <> old.end_time-old.start_time then
      raise exception 'Rescheduling must preserve patient, practitioner, service and duration';
    end if;
  else
    if new.status <> 'Booked' then raise exception 'New appointments must be booked'; end if;
  end if;
  if new.start_time is null or new.end_time is null or not isfinite(new.start_time)
     or not isfinite(new.end_time) or new.end_time <= new.start_time then
    raise exception 'Appointment requires a finite positive interval' using errcode='22023';
  end if;
  if tg_op='INSERT' and new.end_time-new.start_time <> make_interval(mins=>public.appointment_booking_minutes(new.clinic_id)) then
    raise exception 'Use the configured booking duration';
  end if;
  if new.client_id is null or not exists(select 1 from public.clients where id=new.client_id and clinic_id=new.clinic_id) then
    raise exception 'Choose an existing clinic client' using errcode='42501';
  end if;
  if not public.appointment_slot_open(new.clinic_id,new.staff_id,new.service,new.start_time,new.end_time,
                                     case when tg_op='UPDATE' then old.id else null end) then
    raise exception 'That time is unavailable. Refresh available slots.' using errcode='23P01';
  end if;
  return new;
end $$;
revoke all on function public.guard_appointment_booking() from public, anon, authenticated;
drop trigger if exists guard_appointment_booking on public.appointments;
create trigger guard_appointment_booking before insert or update on public.appointments
for each row execute function public.guard_appointment_booking();

-- Validate the actual exclusion/index definition, not just a matching name.
-- A temporary reference lets PostgreSQL canonicalize expression/operator syntax
-- identically on this server; it is empty, has no grants, and drops at commit.
do $$
declare v_actual pg_constraint%rowtype; v_expected pg_constraint%rowtype;
        v_index record;
begin
  create temporary table apero_appointment_exclusion_reference (
    clinic_id uuid, staff_id uuid, start_time timestamptz, end_time timestamptz, status text,
    constraint apero_expected_no_overlap exclude using gist
      (clinic_id with =, staff_id with =, tstzrange(start_time,end_time,'[)') with &&)
      where (status <> 'Cancelled')
  ) on commit drop;
  revoke all on pg_temp.apero_appointment_exclusion_reference from public, anon, authenticated, service_role;
  select * into v_expected from pg_constraint
    where conrelid='pg_temp.apero_appointment_exclusion_reference'::regclass and conname='apero_expected_no_overlap';
  select * into v_actual from pg_constraint
    where conrelid='public.appointments'::regclass and conname='appointments_shared_no_overlap';
  if found then
    select i.*, am.amname into v_index from pg_index i
      join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam
      where i.indexrelid=v_actual.conindid;
    if v_actual.contype <> 'x' or not v_actual.convalidated or v_actual.condeferrable
       or pg_get_constraintdef(v_actual.oid) is distinct from pg_get_constraintdef(v_expected.oid)
       or v_actual.conexclop is distinct from v_expected.conexclop
       or v_index.indrelid is distinct from 'public.appointments'::regclass
       or v_index.amname is distinct from 'gist' or v_index.indisexclusion is distinct from true
       or v_index.indisvalid is distinct from true or v_index.indisready is distinct from true
       or v_index.indnkeyatts is distinct from 3 then
      raise exception 'Existing appointments_shared_no_overlap has an incompatible definition'
        using errcode='22023', detail=pg_get_constraintdef(v_actual.oid),
              hint='Review the named constraint/index. Nothing is dropped or replaced automatically.';
    end if;
  else
    alter table public.appointments add constraint appointments_shared_no_overlap
      exclude using gist (clinic_id with =, staff_id with =,
                          tstzrange(start_time,end_time,'[)') with &&)
      where (status <> 'Cancelled');
  end if;
end $$;
-- Preserve the existing voice RPC signature, integration/phone validation and
-- grants. Normalize only a deadlock during its protected appointment INSERT or
-- reschedule UPDATE; unrelated lock/client/journal failures are not reclassified.
-- No automatic retry: return the existing slot_conflict result after rollback.
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
  v_appointment_write boolean := false;
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
      v_appointment_write := true;
      insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time,status,source)
        values(p_clinic_id,v_client_id,p_staff_id,p_service,p_start,p_end,'Booked','Booked by Apero')
        returning id into p_appointment_id;
    else
      v_appointment_write := true;
      update public.appointments set staff_id = p_staff_id, service = p_service,
        start_time = p_start, end_time = p_end, updated_at = now()
        where id = p_appointment_id;
    end if;
  exception when exclusion_violation then
    raise log 'Appointment slot acquisition failed (code: %)', sqlstate;
    return jsonb_build_object('success',false,'error_type','slot_conflict');
  when deadlock_detected then
    -- PL/pgSQL has rolled back this block before entering the handler, including
    -- any newly-created client and the failed appointment write. Variables
    -- retain their values, so earlier client/lock deadlocks remain DB errors.
    if not v_appointment_write then raise; end if;
    raise log 'Appointment slot acquisition failed (code: %)', sqlstate;
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

notify pgrst, 'reload schema';
commit;
