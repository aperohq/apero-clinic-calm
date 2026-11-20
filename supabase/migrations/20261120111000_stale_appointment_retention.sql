begin;
-- No automatic completion claims or status rewrites. Old Booked appointments
-- qualify only after both their end and last edit exceed the configured period.
-- Existing clinic holds, dry-run, approval and durable-ledger gates still apply.
alter table public.appointments add column retention_preserve_until timestamptz;
create function public.guard_appointment_preservation() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if ((tg_op='INSERT' and new.retention_preserve_until is not null)
     or (tg_op='UPDATE' and new.retention_preserve_until is distinct from old.retention_preserve_until))
    and coalesce(auth.jwt()->>'role','')<>'service_role'
    and not (auth.uid() is null and coalesce(auth.jwt()->>'role','')=''
      and current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.appointments'::regclass)) then
  raise exception 'Preservation changes require authorized maintenance' using errcode='42501';
 end if;return new;
end $$;
revoke all on function public.guard_appointment_preservation() from public,anon,authenticated,service_role;
create trigger guard_appointment_preservation before insert or update on public.appointments
 for each row execute function public.guard_appointment_preservation();
create or replace view public.retention_candidates as
select clinic_id,'call_content'::text category,'conversations'::text resource_table,id::text resource_key,started_at as age_clock from public.conversations where started_at < now()-make_interval(days=>public.retention_days(clinic_id,'call_content_days')) and (transcript is not null or summary is not null or caller_phone is not null or recording_url is not null or title not in ('Phone Call','Call content removed'))
union all
select clinic_id,'retell_call'::text category,'conversations'::text resource_table,id::text resource_key,started_at as age_clock from public.conversations where retell_call_id is not null and retell_agent_id is not null and started_at < now()-make_interval(days=>public.retention_days(clinic_id,'retell_call_days')) and not exists(select 1 from public.retention_provider_jobs j where j.clinic_id=conversations.clinic_id and j.target_key=conversations.retell_call_id and j.provider='retell')
union all
select clinic_id,'call_metadata'::text category,'conversations'::text resource_table,id::text resource_key,started_at as age_clock from public.conversations where started_at < now()-make_interval(days=>public.retention_days(clinic_id,'call_metadata_days')) and not exists(select 1 from public.appointments a where a.clinic_id=conversations.clinic_id and a.id=conversations.appointment_id and a.end_time>=now()) and not exists(select 1 from public.voice_requests r where r.clinic_id=conversations.clinic_id and r.call_id=conversations.retell_call_id and r.status<>'Closed') and (retell_call_id is null or exists(select 1 from public.retention_provider_jobs j where j.clinic_id=conversations.clinic_id and j.provider='retell' and j.target_key=conversations.retell_call_id and j.state='succeeded'))
union all
select clinic_id,'closed_request'::text category,'voice_requests'::text resource_table,id::text resource_key,closed_at as age_clock from public.voice_requests where status='Closed' and closed_at < now()-make_interval(days=>public.retention_days(clinic_id,'closed_request_days'))
union all
select clinic_id,'appointment'::text category,'appointments'::text resource_table,id::text resource_key,end_time as age_clock from public.appointments where status in ('Completed','Cancelled','No Show','Booked')
 and end_time<now() and greatest(end_time,updated_at) < now()-make_interval(days=>public.retention_days(clinic_id,'appointment_days'))
 and (retention_preserve_until is null or retention_preserve_until<now())
 and (status<>'Booked' or not public.retention_client_protected(clinic_id,client_id))
union all
select clinic_id,'note'::text category,'client_notes'::text resource_table,id::text resource_key,created_at as age_clock from public.client_notes where created_at < now()-make_interval(days=>public.retention_days(clinic_id,'note_days')) and not public.retention_client_protected(clinic_id,client_id)
union all
select clinic_id,'client_contact'::text category,'clients'::text resource_table,id::text resource_key,updated_at as age_clock from public.clients where anonymized_at is null and public.retention_client_last_activity(clinic_id,id) < now()-make_interval(days=>public.retention_days(clinic_id,'client_inactivity_days')) and not public.retention_client_protected(clinic_id,id) and not exists(select 1 from public.conversations c where c.clinic_id=clients.clinic_id and c.client_id=clients.id and (c.transcript is not null or c.summary is not null or c.caller_phone is not null))
union all
select clinic_id,'client_shell'::text category,'clients'::text resource_table,id::text resource_key,anonymized_at as age_clock from public.clients where anonymized_at < now()-interval '30 days' and not exists(select 1 from public.appointments a where a.clinic_id=clients.clinic_id and a.client_id=clients.id) and not exists(select 1 from public.conversations c where c.clinic_id=clients.clinic_id and c.client_id=clients.id) and not public.retention_client_protected(clinic_id,id)
union all
select clinic_id,'operation'::text category,'voice_operations'::text resource_table,operation_key::text resource_key,created_at as age_clock from public.voice_operations where created_at < now()-make_interval(days=>public.retention_days(clinic_id,'operation_days'))
union all
select clinic_id,'expired_slot'::text category,'voice_checked_slots'::text resource_table,id::text resource_key,expires_at as age_clock from public.voice_checked_slots where expires_at < now()-make_interval(days=>public.retention_days(clinic_id,'expired_slot_days'))
union all
select clinic_id,'call_state'::text category,'voice_call_state'::text resource_table,call_id::text resource_key,updated_at as age_clock from public.voice_call_state where updated_at < now()-make_interval(days=>public.retention_days(clinic_id,'call_state_days')) and not exists(select 1 from public.voice_checked_slots s where s.clinic_id=voice_call_state.clinic_id and s.call_id=voice_call_state.call_id) and not exists(select 1 from public.voice_requests r where r.clinic_id=voice_call_state.clinic_id and r.call_id=voice_call_state.call_id and r.status<>'Closed')
union all
select clinic_id,'notification'::text category,'notifications'::text resource_table,id::text resource_key,created_at as age_clock from public.notifications where created_at < now()-make_interval(days=>public.retention_days(clinic_id,'notification_days'))
union all
select clinic_id,'revoked_user'::text category,'profiles'::text resource_table,id::text resource_key,revoked_at as age_clock from public.profiles where revoked_at < now()-make_interval(days=>public.retention_days(clinic_id,'revoked_user_days')) and not exists(select 1 from public.retention_provider_jobs j where j.clinic_id=profiles.clinic_id and j.provider='supabase_auth' and j.target_key=profiles.auth_user_id::text)
union all
select clinic_id,'invitation'::text category,'clinic_invitation_claims'::text resource_table,email::text resource_key,last_attempt_at as age_clock from public.clinic_invitation_claims where greatest(last_attempt_at,lease_until) < now()-make_interval(days=>public.retention_days(clinic_id,'invitation_days'))
union all
select clinic_id,'staff_contact'::text,'staff'::text,id::text,deactivated_at from public.staff where not active and deactivated_at<now()-make_interval(days=>public.retention_days(clinic_id,'staff_contact_days')) and (phone is not null or email is not null)
union all
select clinic_id,'staff_record'::text,'staff'::text,id::text,deactivated_at from public.staff where not active and deactivated_at<now()-make_interval(days=>public.retention_days(clinic_id,'staff_record_days')) and not exists(select 1 from public.appointments a where a.clinic_id=staff.clinic_id and a.staff_id=staff.id) and not exists(select 1 from public.voice_checked_slots v where v.clinic_id=staff.clinic_id and v.staff_id=staff.id) and not exists(select 1 from public.staff_time_off t where t.clinic_id=staff.clinic_id and t.staff_id=staff.id and t.end_time>=now())
union all
select clinic_id,'staff_time_off'::text,'staff_time_off'::text,id::text,end_time from public.staff_time_off where end_time<now()-make_interval(days=>public.retention_days(clinic_id,'staff_record_days'))
union all
select clinic_id,'provider_receipt'::text,'retention_provider_jobs'::text,id::text,completed_at from public.retention_provider_jobs where state='succeeded' and completed_at<now()-make_interval(days=>public.retention_days(clinic_id,'audit_days')) and not exists(select 1 from public.conversations c where c.clinic_id=retention_provider_jobs.clinic_id and c.retell_call_id=retention_provider_jobs.target_key) and not exists(select 1 from public.profiles p where p.clinic_id=retention_provider_jobs.clinic_id and p.auth_user_id::text=retention_provider_jobs.target_key);
revoke all on public.retention_candidates from public,anon,authenticated,service_role;

-- Preservation also applies to manual deletion, restore replay and offboarding.
create function public.guard_appointment_preservation_delete() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if old.retention_preserve_until>=now() then
  raise exception 'Appointment preservation hold' using errcode='23503';
 end if;return old;
end $$;
revoke all on function public.guard_appointment_preservation_delete() from public,anon,authenticated,service_role;
create trigger guard_appointment_preservation_delete before delete on public.appointments
 for each row execute function public.guard_appointment_preservation_delete();
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
 if exists(select 1 from public.appointments where clinic_id=p_clinic and retention_preserve_until>=now()) then raise exception 'Appointment preservation hold';end if;
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

commit;
