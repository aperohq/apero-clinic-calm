-- Reuse clinic fallback_phone and opening_hours. No destination is populated.
begin;
alter table public.clinics add column if not exists live_transfer_enabled boolean not null default false;
revoke all (live_transfer_enabled) on public.clinics from public, anon;
grant select, update (live_transfer_enabled) on public.clinics to authenticated, service_role;
create or replace function public.update_clinic_settings(p_patch jsonb, p_expected jsonb)
returns setof public.clinics language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '3s'
as $$
declare
  actor public.profiles%rowtype; clinic public.clinics%rowtype; merged public.clinics%rowtype;
  field text;
  allowed text[] := array['name','localized_name','clinic_type','email','website','phone',
    'fallback_phone','address','city','country','directions','parking_information',
    'timezone','receptionist_name','receptionist_localized_name','opening_hours','live_transfer_enabled'];
begin
  select * into actor from public.profiles
    where auth_user_id = auth.uid() and revoked_at is null for share;
  if actor.id is null or actor.role <> 'owner' then
    raise exception 'Not authorized to change clinic settings' using errcode='42501';
  end if;
  if p_patch is null or p_expected is null or jsonb_typeof(p_patch) <> 'object'
    or jsonb_typeof(p_expected) <> 'object' or p_patch = '{}'::jsonb
    or octet_length(p_patch::text) > 65536 or octet_length(p_expected::text) > 65536 then
    raise exception 'Invalid clinic settings' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_patch) k where not k = any(allowed))
    or (select array_agg(k order by k) from jsonb_object_keys(p_patch) k)
       is distinct from (select array_agg(k order by k) from jsonb_object_keys(p_expected) k) then
    raise exception 'Invalid clinic settings' using errcode='22023';
  end if;
  select * into clinic from public.clinics where id = actor.clinic_id for update;
  if clinic.id is null then
    raise exception 'Not authorized to change clinic settings' using errcode='42501';
  end if;
  for field in select jsonb_object_keys(p_patch) loop
    if to_jsonb(clinic)->field is distinct from p_expected->field then
      raise exception 'Clinic settings changed. Reload before saving' using errcode='40001';
    end if;
    if (field = 'live_transfer_enabled' and jsonb_typeof(p_patch->field) <> 'boolean')
      or (field not in ('opening_hours','live_transfer_enabled') and jsonb_typeof(p_patch->field) not in ('null','string')) then
      raise exception 'Invalid clinic settings' using errcode='22023';
    end if;
  end loop;
  select * into merged from jsonb_populate_record(clinic, p_patch);
  update public.clinics set name=merged.name, localized_name=merged.localized_name,
    clinic_type=merged.clinic_type, email=merged.email, website=merged.website, phone=merged.phone,
    fallback_phone=merged.fallback_phone, address=merged.address, city=merged.city, country=merged.country,
    directions=merged.directions, parking_information=merged.parking_information, timezone=merged.timezone,
    receptionist_name=merged.receptionist_name, receptionist_localized_name=merged.receptionist_localized_name,
    opening_hours=merged.opening_hours, live_transfer_enabled=merged.live_transfer_enabled where id=clinic.id returning * into clinic;
  return next clinic;
end $$;

alter table public.voice_call_state
  add column if not exists transfer_attempt_reserved boolean not null default false,
  add column if not exists transfer_category text,
  add column if not exists transfer_result text,
  add column if not exists transfer_fallback_saved boolean not null default false;
alter table public.voice_call_state add constraint voice_transfer_category_check check
  (transfer_category is null or transfer_category in ('explicit_human_request','unsafe_to_complete','clinic_judgment','repeated_failure','appointment_dispute','unsupported_operation'));
alter table public.voice_call_state add constraint voice_transfer_result_check check
  (transfer_result is null or transfer_result in ('ready','started','success','no_destination','after_hours','no_answer','busy','timeout','provider_error'));

-- Atomic one-attempt claim, with a fresh check of trusted clinic configuration.
create or replace function public.voice_claim_transfer(p_clinic_id uuid,p_call_id text,p_category text,p_destination text)
returns boolean language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare c public.clinics%rowtype; local_now timestamp; claimed text;
begin
 select * into c from public.clinics where id=p_clinic_id for share;
 if c.id is null or not c.live_transfer_enabled or p_destination !~ '^\+[1-9][0-9]{7,14}$'
   or regexp_replace(c.fallback_phone,'[ ().-]','','g') is distinct from p_destination
   or c.opening_hours is null or not exists(select 1 from pg_timezone_names where name=c.timezone) then return false; end if;
 local_now := clock_timestamp() at time zone c.timezone;
 if not exists(select 1 from jsonb_array_elements(c.opening_hours->'days') d,
   lateral jsonb_array_elements(d->'periods') p where (d->>'day')::int=extract(dow from local_now)::int
   and p->>'start' <= to_char(local_now,'HH24:MI') and to_char(local_now,'HH24:MI') < p->>'end') then return false; end if;
 insert into public.voice_call_state(call_id,clinic_id,transfer_attempt_reserved,transfer_category,transfer_result)
   values(p_call_id,p_clinic_id,true,p_category,'ready')
 on conflict(call_id) do update set transfer_attempt_reserved=true,transfer_category=excluded.transfer_category,
   transfer_result='ready',updated_at=now()
 where voice_call_state.clinic_id=p_clinic_id and not voice_call_state.transfer_attempt_reserved
 returning call_id into claimed;
 return claimed is not null;
end $$;

-- Safe status only; success is terminal and caller arguments cannot invoke this RPC.
create or replace function public.voice_record_transfer(p_clinic_id uuid,p_call_id text,p_result text,p_attempted boolean,p_fallback_saved boolean default false)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
declare s public.voice_call_state%rowtype;
begin
 if p_result is null or p_result not in ('started','success','no_destination','after_hours','no_answer','busy','timeout','provider_error') then
  raise exception 'Invalid transfer status' using errcode='22023'; end if;
 if not p_attempted then
  insert into public.voice_call_state(call_id,clinic_id) values(p_call_id,p_clinic_id) on conflict(call_id) do nothing;
 end if;
 select * into s from public.voice_call_state where call_id=p_call_id for update;
 if s.call_id is null then return jsonb_build_object('accepted',false); end if;
 if s.clinic_id <> p_clinic_id then raise exception 'Call ownership mismatch' using errcode='42501'; end if;
 if (p_attempted and not s.transfer_attempt_reserved) or (s.transfer_result='success' and p_result<>'success')
   or (p_result='started' and s.transfer_result not in ('ready','started')) then
  return jsonb_build_object('accepted',false,'result',s.transfer_result); end if;
 update public.voice_call_state set transfer_result=p_result,
  transfer_fallback_saved=transfer_fallback_saved or p_fallback_saved,updated_at=now() where call_id=p_call_id;
 return jsonb_build_object('accepted',true,'result',p_result,'category',s.transfer_category,
  'fallback_saved',s.transfer_fallback_saved or p_fallback_saved);
end $$;
revoke all on function public.voice_claim_transfer(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.voice_record_transfer(uuid,text,text,boolean,boolean) from public,anon,authenticated;
grant execute on function public.voice_claim_transfer(uuid,text,text,text) to service_role;
grant execute on function public.voice_record_transfer(uuid,text,text,boolean,boolean) to service_role;
notify pgrst,'reload schema';
commit;
