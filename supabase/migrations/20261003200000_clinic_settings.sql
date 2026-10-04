-- Local proposal only. Add safe clinic-facing metadata to the existing record.
-- No backfill, Auth/profile/history mutation, provider settings or new tables.
begin;

alter table public.clinics
  add column if not exists localized_name text,
  add column if not exists clinic_type text,
  add column if not exists website text,
  add column if not exists fallback_phone text,
  add column if not exists address text,
  add column if not exists city text,
  add column if not exists country text,
  add column if not exists directions text,
  add column if not exists parking_information text,
  add column if not exists receptionist_name text,
  add column if not exists receptionist_localized_name text,
  add column if not exists opening_hours jsonb;

-- Existing RLS and membership helpers remain unchanged. These are safe public
-- clinic facts, readable under the existing clinic-member SELECT policy.
revoke all (localized_name,clinic_type,website,fallback_phone,address,city,country,
  directions,parking_information,receptionist_name,receptionist_localized_name,opening_hours)
  on public.clinics from public, anon;
grant select, update (localized_name,clinic_type,website,fallback_phone,address,city,country,
  directions,parking_information,receptionist_name,receptionist_localized_name,opening_hours)
  on public.clinics to authenticated, service_role;

-- Validate changed values only so legacy optional formatting does not block
-- unrelated edits. INSERT validates all settings. No scan/rewrite of old rows.
create or replace function public.validate_clinic_settings()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  values_new jsonb := to_jsonb(new);
  values_old jsonb;
  field text; val text; limit_length int; website_host text;
  hours jsonb; day_row jsonb; period jsonb;
  days_seen int[] := '{}'; dow int; prev_end text;
begin
  if tg_op = 'UPDATE' then values_old := to_jsonb(old); end if;
  foreach field in array array['name','localized_name','clinic_type','email','website','phone',
    'fallback_phone','address','city','country','directions','parking_information',
    'timezone','receptionist_name','receptionist_localized_name','opening_hours'] loop
    if tg_op = 'UPDATE' and values_new->field is not distinct from values_old->field then continue; end if;
    if field = 'opening_hours' then
      hours := values_new->field;
      if hours = 'null'::jsonb then continue; end if;
      if jsonb_typeof(hours) <> 'object' or hours - 'days' <> '{}'::jsonb
        or jsonb_typeof(hours->'days') is distinct from 'array' then
        raise exception 'Invalid clinic settings' using errcode='22023';
      end if;
      if jsonb_array_length(hours->'days') <> 7 then
        raise exception 'Invalid clinic settings' using errcode='22023';
      end if;
      for day_row in select value from jsonb_array_elements(hours->'days') loop
        if jsonb_typeof(day_row) <> 'object' or day_row - array['day','periods'] <> '{}'::jsonb
          or jsonb_typeof(day_row->'day') is distinct from 'number'
          or coalesce(day_row->>'day','') !~ '^[0-6]$'
          or jsonb_typeof(day_row->'periods') is distinct from 'array' then
          raise exception 'Invalid clinic settings' using errcode='22023';
        end if;
        dow := (day_row->>'day')::int;
        if dow = any(days_seen) or jsonb_array_length(day_row->'periods') > 4 then
          raise exception 'Invalid clinic settings' using errcode='22023';
        end if;
        days_seen := array_append(days_seen, dow); prev_end := null;
        for period in select value from jsonb_array_elements(day_row->'periods') order by value->>'start' loop
          if jsonb_typeof(period) <> 'object' or period - array['start','end'] <> '{}'::jsonb
            or jsonb_typeof(period->'start') is distinct from 'string'
            or jsonb_typeof(period->'end') is distinct from 'string'
            or coalesce(period->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            or coalesce(period->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            or period->>'start' >= period->>'end'
            or (prev_end is not null and period->>'start' < prev_end) then
            raise exception 'Invalid clinic settings' using errcode='22023';
          end if;
          prev_end := period->>'end';
        end loop;
      end loop;
      continue;
    end if;
    val := values_new->>field;
    limit_length := case field when 'name' then 200 when 'localized_name' then 200
      when 'email' then 254 when 'website' then 2048 when 'phone' then 50 when 'fallback_phone' then 50
      when 'address' then 1000 when 'directions' then 4000 when 'parking_information' then 4000 else 100 end;
    if (field in ('name','timezone') and (val is null or btrim(val) = ''))
      or (val is not null and (length(val) > limit_length or btrim(val) = '')) then
      raise exception 'Invalid clinic settings' using errcode='22023';
    end if;
    if val is null then continue; end if;
    if field = 'timezone' and (not (val = 'UTC' or val ~ '^[A-Za-z_+-]+/[A-Za-z0-9_/+-]+$')
      or not exists(select 1 from pg_catalog.pg_timezone_names where name = val)) then
      raise exception 'Invalid clinic settings' using errcode='22023';
    end if;
    if field = 'email' and val !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'Invalid clinic settings' using errcode='22023';
    end if;
    if field in ('phone','fallback_phone') and (val !~ '^\+?[0-9 ().-]+$'
      or length(regexp_replace(val,'[^0-9]','','g')) not between 6 and 15) then
      raise exception 'Invalid clinic settings' using errcode='22023';
    end if;
    if field = 'website' and (val !~ '^https?://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
      or coalesce(substring(val from '^https?://(?:\[[^]]+\]|[^:/?#]+):([0-9]+)')::int,0) > 65535) then
      raise exception 'Invalid clinic settings' using errcode='22023';
    end if;
    if field = 'website' then
      website_host := substring(val from '^https?://\[([^]]+)\]');
      if website_host is not null then
        -- PostgreSQL's inet parser validates IPv6 rather than merely its characters.
        -- URL structure above excludes network masks, zone IDs and unbracketed IPv6.
        begin
          if family(website_host::inet) <> 6 then
            raise exception 'Invalid clinic settings' using errcode='22023';
          end if;
        exception when invalid_text_representation then
          raise exception 'Invalid clinic settings' using errcode='22023';
        end;
      end if;
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.validate_clinic_settings() from public, anon, authenticated;
drop trigger if exists validate_clinic_settings on public.clinics;
create trigger validate_clinic_settings before insert or update on public.clinics
  for each row execute function public.validate_clinic_settings();

-- Caller-scoped, invoker RPC: no clinic ID argument, no service-role client.
-- Preserve row RLS/column grants. Lock live membership before the clinic record;
-- revocation/role mutation cannot race with an already-authorized write.
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
    'timezone','receptionist_name','receptionist_localized_name','opening_hours'];
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
    if field <> 'opening_hours' and jsonb_typeof(p_patch->field) not in ('null','string') then
      raise exception 'Invalid clinic settings' using errcode='22023';
    end if;
  end loop;
  select * into merged from jsonb_populate_record(clinic, p_patch);
  update public.clinics set name=merged.name, localized_name=merged.localized_name,
    clinic_type=merged.clinic_type, email=merged.email, website=merged.website, phone=merged.phone,
    fallback_phone=merged.fallback_phone, address=merged.address, city=merged.city, country=merged.country,
    directions=merged.directions, parking_information=merged.parking_information, timezone=merged.timezone,
    receptionist_name=merged.receptionist_name, receptionist_localized_name=merged.receptionist_localized_name,
    opening_hours=merged.opening_hours where id=clinic.id returning * into clinic;
  return next clinic;
end $$;
revoke all on function public.update_clinic_settings(jsonb,jsonb) from public, anon;
grant execute on function public.update_clinic_settings(jsonb,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
