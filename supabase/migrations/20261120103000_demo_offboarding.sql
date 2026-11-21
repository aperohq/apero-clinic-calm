begin;
-- Completed demo rows are operational history, not patient clinical records.
-- Keep history on user deletion, and remove it only in approved clinic cleanup.
alter table public.demo_call_sessions alter column auth_user_id drop not null;
alter table public.demo_call_sessions drop constraint demo_call_sessions_auth_user_id_fkey;
alter table public.demo_call_sessions add constraint demo_call_sessions_auth_user_id_fkey
  foreign key(auth_user_id) references auth.users(id) on delete set null;

create function public.guard_demo_user_deletion() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.auth_user_id is null and old.auth_user_id is not null and not old.ended then
    raise exception 'Finish active demo calls before deleting their user' using errcode='23503';
  end if;
  return new;
end $$;
revoke all on function public.guard_demo_user_deletion() from public,anon,authenticated,service_role;
create trigger guard_demo_user_deletion before update of auth_user_id on public.demo_call_sessions
  for each row execute function public.guard_demo_user_deletion();

create or replace function public.retention_offboard_batch(p_clinic uuid,p_dry_run boolean default true,p_batch integer default 100) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.clinic_offboarding;cv record;p record;t text;n integer;pending integer;begin
 if p_batch not between 1 and 500 then raise exception 'Invalid batch';end if;
 perform pg_advisory_xact_lock(hashtextextended('retention:'||p_clinic::text,0));
 select * into o from public.clinic_offboarding where clinic_id=p_clinic for update;
 if not found or o.state='complete' then return jsonb_build_object('state','no_work');end if;
 if o.grace_until>now() or not o.telephony_stopped_verified or not o.provider_inventory_verified then raise exception 'Offboarding readiness required';end if;
 if exists(select 1 from public.clinic_retention where clinic_id=p_clinic and legal_hold) then raise exception 'Legal hold';end if;
 if (exists(select 1 from public.appointments where clinic_id=p_clinic and end_time>=now()) or exists(select 1 from public.voice_requests where clinic_id=p_clinic and status<>'Closed'))
 and not o.active_work_handover_verified then raise exception 'Resolve active work before offboarding';end if;
 if exists(select 1 from public.demo_call_sessions where clinic_id=p_clinic and not ended) then raise exception 'Finish active demo calls before offboarding';end if;
 if p_dry_run then select count(*) into n from public.conversations where clinic_id=p_clinic;return jsonb_build_object('mode','dry_run','calls',n);end if;
 if not exists(select 1 from public.retention_control where singleton and mode='enabled' and approved_at is not null) then raise exception 'Retention approval required';end if;
 update public.clinic_offboarding set state='purging' where clinic_id=p_clinic;
 perform public.retention_record(p_clinic,'clinics',p_clinic::text,'offboard');
 if not exists(select 1 from public.retention_deletion_ledger where clinic_id=p_clinic and resource_table='clinics' and action='offboard' and durable_at is not null) then return jsonb_build_object('state','awaiting_durable_ledger');end if;
 for cv in select * from public.conversations c where clinic_id=p_clinic and retell_call_id is not null and not exists(
 select 1 from public.retention_provider_jobs j where j.clinic_id=p_clinic and j.provider='retell' and j.target_key=c.retell_call_id) order by id limit p_batch loop
 perform public.retention_queue_call(p_clinic,cv.retell_call_id,cv.retell_agent_id);end loop;
 for p in select * from public.profiles where clinic_id=p_clinic order by id limit p_batch loop
 perform public.retention_record(p_clinic,'auth.users',p.auth_user_id::text,'delete');
 insert into public.retention_provider_jobs(clinic_id,provider,target_key) values(p_clinic,'supabase_auth',p.auth_user_id::text) on conflict do nothing;end loop;
 select count(*) into pending from public.retention_provider_jobs where clinic_id=p_clinic and state<>'succeeded';
 if pending>0 or exists(select 1 from public.profiles where clinic_id=p_clinic)
 or exists(select 1 from public.conversations c where c.clinic_id=p_clinic and c.retell_call_id is not null and not exists(
 select 1 from public.retention_provider_jobs j where j.clinic_id=p_clinic and j.target_key=c.retell_call_id and j.provider='retell' and j.state='succeeded')) then
 return jsonb_build_object('state','waiting_provider','pending',pending);end if;
 -- One FK-ordered table per invocation; large child batches cannot block parent cleanup.
 foreach t in array array['demo_call_sessions','client_notes','conversations','appointments','voice_requests','voice_operations','voice_checked_slots','voice_call_state',
 'notifications','staff_time_off','staff_availability','clients','staff','clinic_service_aliases','clinic_invitation_claims'] loop
 execute format('delete from public.%I where ctid in (select ctid from public.%I where clinic_id=$1 limit $2)',t,t) using p_clinic,p_batch;
 get diagnostics n=row_count;
 if n>0 then
 insert into public.retention_runs(clinic_id,category,mode,processed,state) values(p_clinic,'offboarding','enabled',n,'success');
 return jsonb_build_object('state','purging','processed',n);end if;end loop;
 if not o.secrets_revoked_verified then return jsonb_build_object('state','awaiting_secret_revocation');end if;
 delete from public.voice_integrations where clinic_id=p_clinic;
 delete from public.clinic_invitation_budgets where scope_id=p_clinic;
 delete from public.clinic_retention where clinic_id=p_clinic;
 delete from public.clinics where id=p_clinic;
 update public.clinic_offboarding set state='complete',completed_at=now() where clinic_id=p_clinic;
 return jsonb_build_object('state','complete');
end $$;
revoke all on function public.retention_offboard_batch(uuid,boolean,integer) from public,anon,authenticated,service_role;

create or replace function public.demo_call_session(p_command text, p_user_id uuid, p_clinic_id uuid, p_request_id uuid default null, p_call_id text default null)
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
  if found and (r.auth_user_id is distinct from p_user_id or r.clinic_id<>p_clinic_id) then return jsonb_build_object('code','not_authorized'); end if;
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
