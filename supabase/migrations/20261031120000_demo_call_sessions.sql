-- Additive demo-only migration. No appointment, webhook, or booking changes.
begin;
create table public.demo_call_sessions (
  request_id uuid primary key,
  clinic_id uuid not null references public.clinics(id),
  auth_user_id uuid not null references auth.users(id),
  call_id text unique,
  cancel_requested boolean not null default false,
  ended boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index demo_one_call_per_clinic on public.demo_call_sessions(clinic_id) where not ended;
alter table public.demo_call_sessions enable row level security;
revoke all on public.demo_call_sessions from public, anon, authenticated;
grant select, insert, update on public.demo_call_sessions to service_role;
create function public.demo_call_session(p_command text, p_user_id uuid, p_clinic_id uuid, p_request_id uuid default null, p_call_id text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.demo_call_sessions%rowtype;
begin
  -- Serialize reservations, cleanup and membership checks across Edge instances.
  perform pg_advisory_xact_lock(hashtextextended('apero_demo:' || p_clinic_id::text, 0));
  if not exists(select 1 from public.profiles where auth_user_id=p_user_id and clinic_id=p_clinic_id and role='owner' and revoked_at is null) then
    return jsonb_build_object('code','not_authorized');
  end if;
  if p_command='authorize' then return jsonb_build_object('ok',true); end if;
  if p_command='outstanding' then
    select * into r from public.demo_call_sessions where clinic_id=p_clinic_id and not ended;
    -- A different Owner's call can block this Owner but cannot be manipulated.
    if r.auth_user_id is distinct from p_user_id then return '{}'::jsonb; end if;
    return coalesce(to_jsonb(r),'{}'::jsonb);
  end if;
  select * into r from public.demo_call_sessions where request_id=p_request_id for update;
  if found and (r.auth_user_id<>p_user_id or r.clinic_id<>p_clinic_id) then return jsonb_build_object('code','not_authorized'); end if;
  if p_command='reserve' then
    if r.request_id is not null or exists(select 1 from public.demo_call_sessions where clinic_id=p_clinic_id and not ended) then return jsonb_build_object('code','session_exists'); end if;
    if (select count(*) from public.demo_call_sessions where clinic_id=p_clinic_id and created_at>now()-interval '1 hour')>=6 then return jsonb_build_object('code','rate_limited'); end if;
    insert into public.demo_call_sessions(request_id,clinic_id,auth_user_id) values(p_request_id,p_clinic_id,p_user_id);
    return jsonb_build_object('ok',true);
  elsif p_command='cancel' then
    if r.request_id is null then
      if (select count(*) from public.demo_call_sessions where clinic_id=p_clinic_id and created_at>now()-interval '1 hour')>=12 then return jsonb_build_object('code','rate_limited'); end if;
      -- Cancellation can beat reservation (navigation while SDK import/create is pending).
      insert into public.demo_call_sessions(request_id,clinic_id,auth_user_id,cancel_requested,ended) values(p_request_id,p_clinic_id,p_user_id,true,true) returning * into r;
    else
      update public.demo_call_sessions set cancel_requested=true where request_id=p_request_id returning * into r;
    end if;
  elsif p_command='attach' and r.request_id is not null and not r.ended and r.call_id is null and p_call_id is not null then
    update public.demo_call_sessions set call_id=p_call_id where request_id=p_request_id returning * into r;
  elsif p_command='finish' and r.request_id is not null and (r.call_id is null or r.call_id=p_call_id) then
    update public.demo_call_sessions set ended=true where request_id=p_request_id returning * into r;
  else return jsonb_build_object('code','invalid_session');
  end if;
  return to_jsonb(r);
end $$;
revoke all on function public.demo_call_session(text,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.demo_call_session(text,uuid,uuid,uuid,text) to service_role;
commit;
