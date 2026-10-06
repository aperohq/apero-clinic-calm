begin;
-- Called only after verified ciphertext upload/read-back outside the live DB.
-- Acknowledges UUID intents, never patient content; service key cannot forge ACK.
create function public.retention_ack_ledger(p_ids uuid[]) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer;begin
 if coalesce(array_length(p_ids,1),0) not between 1 and 10000 then raise exception 'Invalid acknowledgement';end if;
 update public.retention_deletion_ledger set durable_at=coalesce(durable_at,now()) where id=any(p_ids);
 get diagnostics n=row_count;return n;end $$;
revoke all on function public.retention_ack_ledger(uuid[]) from public,anon,authenticated,service_role;
create function public.retention_verify_provider(p_clinic uuid,p_job uuid,p_lease uuid,p_fingerprint text) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Invalid verification receipt';end if;
 update public.retention_provider_jobs set verified_key_fingerprint=p_fingerprint,ownership_verified_at=now()
 where id=p_job and clinic_id=p_clinic and state='leased' and lease_token=p_lease and lease_until>now();return found;end $$;
revoke all on function public.retention_verify_provider(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.retention_verify_provider(uuid,uuid,uuid,text) to service_role;

create function public.retention_offboard_batch(p_clinic uuid,p_dry_run boolean default true,p_batch integer default 100) returns jsonb
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
 foreach t in array array['client_notes','conversations','appointments','voice_requests','voice_operations','voice_checked_slots','voice_call_state',
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

-- Restore only: import CURRENT ledger/outbox from separate custody into quarantine first.
create function public.retention_replay_ledger(p_clinic uuid) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r record;n integer:=0;begin
 for r in select * from public.retention_deletion_ledger where clinic_id=p_clinic order by occurred_at,id loop
 if r.resource_table='clinics' and r.action='offboard' then
 update public.voice_integrations set active=false where clinic_id=p_clinic;
 update public.profiles set revoked_at=coalesce(revoked_at,now()) where clinic_id=p_clinic;
 elsif r.resource_table='retell_call' then
 update public.conversations set transcript=null,summary=null,caller_phone=null,recording_url=null,title='Call content removed' where clinic_id=p_clinic and retell_call_id=r.resource_key;
 elsif r.resource_table='auth.users' then
 update public.profiles set revoked_at=coalesce(revoked_at,now()) where clinic_id=p_clinic and auth_user_id::text=r.resource_key;
 insert into public.retention_provider_jobs(clinic_id,provider,target_key) values(p_clinic,'supabase_auth',r.resource_key)
 on conflict(clinic_id,provider,target_key) do update set state='pending',completed_at=null,lease_until=null,lease_token=null;
 elsif r.action='clear_content' and r.resource_table='conversations' then
 update public.conversations set transcript=null,summary=null,caller_phone=null,recording_url=null,title='Call content removed' where clinic_id=p_clinic and id::text=r.resource_key;
 elsif r.action='clear_content' and r.resource_table='staff' then
 update public.staff set phone=null,email=null where clinic_id=p_clinic and id::text=r.resource_key;
 elsif r.action='clear_content' and r.resource_table='appointments' then
 update public.appointments set notes=null where clinic_id=p_clinic and id::text=r.resource_key;
 elsif r.action='anonymize' and r.resource_table='clients' then
 if public.retention_client_protected(p_clinic,r.resource_key::uuid) then raise exception 'Restore has conflicting active work; quarantine review required';end if;
 update public.clients set full_name='Removed patient',phone='',email=null,notes=null,anonymized_at=coalesce(anonymized_at,now()) where clinic_id=p_clinic and id::text=r.resource_key;
 delete from public.client_notes where clinic_id=p_clinic and client_id::text=r.resource_key;
 elsif r.action='delete' and r.resource_table in ('appointments','client_notes','conversations','voice_requests','notifications','clients','voice_operations','voice_checked_slots','voice_call_state','staff','staff_time_off') then
 if r.resource_table='appointments' and exists(select 1 from public.appointments where clinic_id=p_clinic and id::text=r.resource_key and end_time>=now()) then raise exception 'Restore has future appointment conflict';end if;
 if r.resource_table='voice_requests' and exists(select 1 from public.voice_requests where clinic_id=p_clinic and id::text=r.resource_key and status<>'Closed') then raise exception 'Restore has unresolved request conflict';end if;
 execute format('delete from public.%I where clinic_id=$1 and %I::text=$2',r.resource_table,
 case r.resource_table when 'voice_operations' then 'operation_key' when 'voice_call_state' then 'call_id' else 'id' end) using p_clinic,r.resource_key;
 else raise exception 'Unknown replay scope';end if;n:=n+1;end loop;return n;end $$;
revoke all on function public.retention_replay_ledger(uuid) from public,anon,authenticated,service_role;
commit;
