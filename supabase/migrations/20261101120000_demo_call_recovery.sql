-- Demo-only recovery. Apply AFTER 20261031120000_demo_call_sessions.sql.
-- Enrollment is an explicit database-administrator action; no operator is seeded.
begin;
create table public.demo_recovery_operators (
  auth_user_id uuid not null references auth.users(id),
  clinic_id uuid not null references public.clinics(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (auth_user_id, clinic_id)
);
create table public.demo_call_recovery_audit (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_user_id uuid not null references auth.users(id),
  clinic_id uuid not null references public.clinics(id),
  request_id uuid not null,
  provider_call_id text,
  provider_status text,
  outcome text not null check (outcome in (
    'requested','not_authorized','session_missing','already_ended',
    'candidate_required','candidate_conflict','provider_unavailable',
    'provider_identity_mismatch','provider_active','provider_status_unknown','recovered'
  ))
);
alter table public.demo_recovery_operators enable row level security;
alter table public.demo_call_recovery_audit enable row level security;
revoke all on public.demo_recovery_operators, public.demo_call_recovery_audit from public, anon, authenticated, service_role;
revoke all on sequence public.demo_call_recovery_audit_id_seq from public, anon, authenticated, service_role;
grant select on public.demo_recovery_operators, public.demo_call_recovery_audit to service_role;

create function public.demo_recover_session(
  p_command text, p_user_id uuid, p_clinic_id uuid, p_request_id uuid,
  p_call_id text default null, p_outcome text default null, p_provider_status text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.demo_call_sessions%rowtype;
begin
  -- Uses the same lock as creation/cleanup, including across different Owners.
  perform pg_advisory_xact_lock(hashtextextended('apero_demo:' || p_clinic_id::text, 0));
  if not exists(select 1 from public.profiles where auth_user_id=p_user_id and clinic_id=p_clinic_id and role='owner' and revoked_at is null)
     or not exists(select 1 from public.demo_recovery_operators where auth_user_id=p_user_id and clinic_id=p_clinic_id and active) then
    insert into public.demo_call_recovery_audit(actor_user_id,clinic_id,request_id,outcome)
      values(p_user_id,p_clinic_id,p_request_id,'not_authorized');
    return jsonb_build_object('code','not_authorized');
  end if;
  select * into r from public.demo_call_sessions where request_id=p_request_id and clinic_id=p_clinic_id for update;
  if not found then
    insert into public.demo_call_recovery_audit(actor_user_id,clinic_id,request_id,outcome)
      values(p_user_id,p_clinic_id,p_request_id,'session_missing');
    return jsonb_build_object('code','session_missing');
  end if;
  if p_command='begin' then
    insert into public.demo_call_recovery_audit(actor_user_id,clinic_id,request_id,provider_call_id,outcome)
      values(p_user_id,p_clinic_id,p_request_id,r.call_id,case when r.ended then 'already_ended' else 'requested' end);
    -- Prevent a still-running create handler from handing out a token after recovery began.
    if not r.ended then
      update public.demo_call_sessions set cancel_requested=true where request_id=p_request_id returning * into r;
    end if;
    return to_jsonb(r);
  elsif p_command='record' and p_outcome in (
    'candidate_required','candidate_conflict','provider_unavailable',
    'provider_identity_mismatch','provider_active','provider_status_unknown'
  ) then
    insert into public.demo_call_recovery_audit(actor_user_id,clinic_id,request_id,provider_call_id,provider_status,outcome)
      values(p_user_id,p_clinic_id,p_request_id,p_call_id,p_provider_status,p_outcome);
    return jsonb_build_object('ok',true);
  elsif p_command='finish' and p_provider_status in ('ended','error')
      and p_call_id ~ '^[a-zA-Z0-9_-]{1,128}$'
      and (r.call_id is null or r.call_id=p_call_id) then
    -- Only trusted server code calls this after a fresh matching Retell Get Call.
    -- Binding the verified ID, releasing the lock and auditing are atomic.
    update public.demo_call_sessions set call_id=p_call_id,cancel_requested=true,ended=true
      where request_id=p_request_id returning * into r;
    insert into public.demo_call_recovery_audit(actor_user_id,clinic_id,request_id,provider_call_id,provider_status,outcome)
      values(p_user_id,p_clinic_id,p_request_id,p_call_id,p_provider_status,'recovered');
    return to_jsonb(r);
  end if;
  return jsonb_build_object('code','invalid_recovery');
end $$;
revoke all on function public.demo_recover_session(text,uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.demo_recover_session(text,uuid,uuid,uuid,text,text,text) to service_role;
commit;
