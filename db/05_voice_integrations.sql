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
-- Existing live agent remains active after deploying this migration and functions.
insert into public.voice_integrations
  (clinic_id, workspace_id, agent_id, conversation_flow_id, knowledge_base_id, secret_env_name, active)
values ('11111111-1111-4111-8111-111111111111', 'org_Ybi3pl9fq16wgTf6',
  'agent_b84b2766efeb85afc809147d7a', 'conversation_flow_43f53e5e8531',
  'knowledge_base_5e52df7d832025dc', 'RETELL_API_KEY', true)
on conflict (clinic_id) do nothing;
-- Fail if an existing row conflicts with the verified Dental Zone integration.
do $$ begin
  if not exists (select 1 from public.voice_integrations
    where clinic_id = '11111111-1111-4111-8111-111111111111'
      and workspace_id = 'org_Ybi3pl9fq16wgTf6'
      and agent_id = 'agent_b84b2766efeb85afc809147d7a'
      and conversation_flow_id = 'conversation_flow_43f53e5e8531'
      and knowledge_base_id = 'knowledge_base_5e52df7d832025dc'
      and secret_env_name = 'RETELL_API_KEY' and active) then
    raise exception 'Dental Zone voice integration seed does not match expected configuration';
  end if;
end $$;
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
insert into public.clinic_service_aliases (clinic_id, service, alias) values
  ('11111111-1111-4111-8111-111111111111', 'Dental Cleaning', 'cleaning'),
  ('11111111-1111-4111-8111-111111111111', 'Dental Cleaning', 'scaling'),
  ('11111111-1111-4111-8111-111111111111', 'Dental Cleaning', 'تنظيف'),
  ('11111111-1111-4111-8111-111111111111', 'Dental Cleaning', 'تنظيف اسنان'),
  ('11111111-1111-4111-8111-111111111111', 'Dental Cleaning', 'تنظيف الأسنان'),
  ('11111111-1111-4111-8111-111111111111', 'Consultation', 'general consultation'),
  ('11111111-1111-4111-8111-111111111111', 'Consultation', 'dental consultation'),
  ('11111111-1111-4111-8111-111111111111', 'Consultation', 'استشارة عامة'),
  ('11111111-1111-4111-8111-111111111111', 'Consultation', 'كشف اسنان'),
  ('11111111-1111-4111-8111-111111111111', 'Root Canal', 'root canal treatment'),
  ('11111111-1111-4111-8111-111111111111', 'Root Canal', 'nerve treatment'),
  ('11111111-1111-4111-8111-111111111111', 'Root Canal', 'علاج عصب'),
  ('11111111-1111-4111-8111-111111111111', 'Root Canal', 'سحب عصب'),
  ('11111111-1111-4111-8111-111111111111', 'Veneers Consultation', 'veneers'),
  ('11111111-1111-4111-8111-111111111111', 'Veneers Consultation', 'veneer consultation'),
  ('11111111-1111-4111-8111-111111111111', 'Veneers Consultation', 'فينير'),
  ('11111111-1111-4111-8111-111111111111', 'Veneers Consultation', 'قشور'),
  ('11111111-1111-4111-8111-111111111111', 'Teeth Whitening', 'whitening'),
  ('11111111-1111-4111-8111-111111111111', 'Teeth Whitening', 'bleaching'),
  ('11111111-1111-4111-8111-111111111111', 'Teeth Whitening', 'تبييض'),
  ('11111111-1111-4111-8111-111111111111', 'Teeth Whitening', 'تبييض الاسنان'),
  ('11111111-1111-4111-8111-111111111111', 'Orthodontic Consultation', 'orthodontics consultation'),
  ('11111111-1111-4111-8111-111111111111', 'Orthodontic Consultation', 'braces consultation'),
  ('11111111-1111-4111-8111-111111111111', 'Orthodontic Consultation', 'استشارة تقويم'),
  ('11111111-1111-4111-8111-111111111111', 'Braces Review', 'braces follow up'),
  ('11111111-1111-4111-8111-111111111111', 'Braces Review', 'braces check'),
  ('11111111-1111-4111-8111-111111111111', 'Braces Review', 'مراجعة تقويم'),
  ('11111111-1111-4111-8111-111111111111', 'Preventive Care', 'prevention'),
  ('11111111-1111-4111-8111-111111111111', 'Preventive Care', 'preventive visit'),
  ('11111111-1111-4111-8111-111111111111', 'Preventive Care', 'رعاية وقائية')
on conflict do nothing;

-- Preserve the existing Dental Zone pronunciation variants in tenant-owned staff data.
alter table public.staff add column if not exists aliases text[] not null default '{}';
update public.staff set aliases = array(
  select distinct item from unnest(coalesce(aliases, '{}'::text[]) || array[
    'Ahmed Kandil', 'Ahmed Qandeel', 'Dr Qandil', 'د احمد قنديل', 'احمد قنديل', 'أحمد كنديل'
  ]) as item
) where id = '21111111-1111-4111-8111-111111111111' and clinic_id = '11111111-1111-4111-8111-111111111111';
update public.staff set aliases = array(
  select distinct item from unnest(coalesce(aliases, '{}'::text[]) || array[
    'Mohammad Shuqeir', 'Mohammed Shukair', 'Muhammad Shuqair', 'دكتور محمد شقير', 'محمد شقير'
  ]) as item
) where id = '21111111-1111-4111-8111-111111111112' and clinic_id = '11111111-1111-4111-8111-111111111111';
update public.staff set aliases = array(
  select distinct item from unnest(coalesce(aliases, '{}'::text[]) || array[
    'Fatima Hasan', 'Fatma Hassan', 'فاطمة حسن', 'فاطمه حسن', 'دكتورة فاطمة حسن'
  ]) as item
) where id = '21111111-1111-4111-8111-111111111113' and clinic_id = '11111111-1111-4111-8111-111111111111';
update public.staff set aliases = array(
  select distinct item from unnest(coalesce(aliases, '{}'::text[]) || array[
    'Laila Salem', 'Leila Salem', 'ليلى سالم', 'ليلا سالم'
  ]) as item
) where id = '21111111-1111-4111-8111-111111111114' and clinic_id = '11111111-1111-4111-8111-111111111111';
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
