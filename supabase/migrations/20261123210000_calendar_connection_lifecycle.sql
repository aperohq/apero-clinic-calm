begin;
alter table public.calendar_connections
 add column google_account_id text check(length(google_account_id) between 1 and 1024),
 add column calendar_name text check(length(calendar_name)<=1024),
 add column calendar_is_primary boolean,
 add column watch_error text,
 add column watch_retry_at timestamptz;
create index calendar_account_lookup on public.calendar_connections(clinic_id,google_account_id) where status<>'disconnected';
alter table public.integration_oauth_states add column target_connection uuid references public.calendar_connections(id);

-- Serialize account lookup before encrypting credentials: ciphertext is bound to
-- the returned connection ID. Historical disconnected records remain untouched.
create function public.integration_prepare_connection(p_clinic uuid,p_actor uuid,p_account text,p_target uuid default null) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; target public.calendar_connections%rowtype; begin
 perform 1 from public.profiles where auth_user_id=p_actor and clinic_id=p_clinic and role='owner' and revoked_at is null for update;
 if not found then raise exception 'Not authorized' using errcode='42501'; end if;
 if p_account is null or length(p_account) not between 1 and 1024 then raise exception 'Invalid Google account' using errcode='22023'; end if;
 perform 1 from public.clinics where id=p_clinic for update;
 if p_target is not null then
  select * into target from public.calendar_connections where id=p_target and clinic_id=p_clinic for update;
  if target.id is null then raise exception 'Connection not found' using errcode='42501'; end if;
  if (target.google_account_id is not null and target.google_account_id<>p_account) or (target.google_account_id is null and target.calendar_id is not null and target.calendar_id<>p_account) then raise exception 'Google account does not match connection' using errcode='22023'; end if;
  if target.status<>'disconnected' then c:=target; end if;
 end if;
 if c.id is null then
  select * into c from public.calendar_connections where clinic_id=p_clinic and status<>'disconnected' and (google_account_id=p_account or (google_account_id is null and calendar_id=p_account)) order by (calendar_id is not null) desc,created_at desc,id limit 1 for update;
 end if;
 if c.id is null then
  if (select count(*) from public.calendar_connections where clinic_id=p_clinic and status<>'disconnected')>=20 then raise exception 'Connection limit' using errcode='22023'; end if;
  insert into public.calendar_connections(clinic_id,google_account_id) values(p_clinic,p_account) returning * into c;
 else
  if c.lease_until>now() then raise exception 'Connection synchronization is running' using errcode='40001'; end if;
  update public.calendar_connections set google_account_id=p_account where id=c.id;
 end if;
 return c.id;
end $$;
revoke all on function public.integration_prepare_connection(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.integration_prepare_connection(uuid,uuid,text,uuid) to service_role;

create or replace function public.integration_save_connection(p_id uuid,p_clinic uuid,p_actor uuid,p_credentials text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; begin
 perform 1 from public.profiles where auth_user_id=p_actor and clinic_id=p_clinic and role='owner' and revoked_at is null for update;
 if not found then raise exception 'Not authorized' using errcode='42501'; end if;
 perform 1 from public.clinics where id=p_clinic for update;
 select * into c from public.calendar_connections where id=p_id for update;
 if c.id is null then
  if (select count(*) from public.calendar_connections where clinic_id=p_clinic and status<>'disconnected')>=20 then raise exception 'Connection limit' using errcode='22023'; end if;
  insert into public.calendar_connections(id,clinic_id,credentials) values(p_id,p_clinic,p_credentials);
 else
  if c.clinic_id<>p_clinic or c.status='disconnected' then raise exception 'Connection not found' using errcode='42501'; end if;
  if c.lease_until>now() then raise exception 'Connection synchronization is running' using errcode='40001'; end if;
  update public.calendar_connections set credentials=p_credentials,status=case when calendar_id is null then 'pending' else 'attention' end,last_error=null where id=p_id;
  if c.calendar_id is not null then perform public.integration_enqueue(p_id,'pull','calendar'); end if;
 end if;
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(p_clinic,p_actor,'calendar.authorized',p_id);
end $$;

create or replace function public.integration_select_calendar(p_id uuid,p_calendar text,p_staff uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare clinic uuid:=public.integration_owner(); c public.calendar_connections%rowtype; a record; begin
 if p_calendar is null or length(p_calendar) not between 1 and 1024 or not exists(select 1 from public.staff where id=p_staff and clinic_id=clinic and active) then raise exception 'Invalid selection' using errcode='22023'; end if;
 select * into c from public.calendar_connections where id=p_id and clinic_id=clinic and status<>'disconnected' for update;
 if c.id is null or c.credentials is null then raise exception 'Connection not found' using errcode='22023'; end if;
 -- Identical retries cannot invalidate an already fresh snapshot or duplicate jobs.
 if c.calendar_id=p_calendar and c.staff_id=p_staff then return; end if;
 if c.lease_until>now() then raise exception 'Connection synchronization is running' using errcode='40001'; end if;
 if c.calendar_id is not null and (c.last_synced_at is not null or exists(select 1 from public.calendar_event_links where connection_id=c.id)) then raise exception 'Disconnect before replacing an established calendar' using errcode='22023'; end if;
 -- Only an unstarted selection can be corrected in place; no remote events exist.
 delete from public.integration_jobs where connection_id=c.id;
 update public.calendar_connections set calendar_id=p_calendar,staff_id=p_staff,status='pending',last_synced_at=null,last_error=null,calendar_name=null,calendar_is_primary=null,busy_from=null,busy_until=null,watch_error=null,watch_retry_at=null where id=c.id;
 perform public.integration_enqueue(c.id,'pull','calendar');
 for a in select id from public.appointments where clinic_id=clinic and staff_id=p_staff and status='Booked' and end_time>now() loop perform public.integration_enqueue(c.id,'push',a.id::text); end loop;
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(clinic,auth.uid(),'calendar.selected',c.id);
end $$;

-- The global cron entry and owner-triggered initial sync use identical lease logic;
-- initial sync is scoped so it never drains another connection's calendar.
create function public.integration_claim_work(p_connection uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; j public.integration_jobs%rowtype; lease uuid:=gen_random_uuid(); begin
 insert into public.integration_jobs(connection_id,kind,object_id) select id,'pull','calendar' from public.calendar_connections where (p_connection is null or id=p_connection) and calendar_id is not null and status in ('pending','connected','attention') and credentials is not null and (last_synced_at is null or last_synced_at<now()-interval '1 minute') on conflict do nothing;
 select c1.* into c from public.calendar_connections c1 where (p_connection is null or c1.id=p_connection) and c1.status<>'disconnected' and c1.calendar_id is not null and c1.credentials is not null and (c1.lease_until is null or c1.lease_until<now()) and exists(select 1 from public.integration_jobs j1 where j1.connection_id=c1.id and j1.dead_at is null and j1.available_at<=now()) order by c1.last_synced_at nulls first,c1.id for update skip locked limit 1;
 if c.id is null then return null; end if;
 select * into j from public.integration_jobs where connection_id=c.id and dead_at is null and available_at<=now() order by case when kind='pull' then 0 else 1 end,available_at for update skip locked limit 1;
 update public.calendar_connections set lease_id=lease,lease_until=now()+interval '180 seconds' where id=c.id;
 update public.integration_jobs set lease_id=lease,lease_until=now()+interval '180 seconds',attempts=attempts+1 where id=j.id returning * into j;
 return jsonb_build_object('connection',to_jsonb(c),'job',to_jsonb(j),'lease',lease);
end $$;
revoke all on function public.integration_claim_work(uuid) from public,anon,authenticated,service_role;
create or replace function public.integration_claim() returns jsonb language sql security definer set search_path=public,pg_temp as $$ select public.integration_claim_work(null) $$;
create function public.integration_claim_connection(p_connection uuid) returns jsonb language sql security definer set search_path=public,pg_temp as $$ select public.integration_claim_work(p_connection) $$;
revoke all on function public.integration_claim_connection(uuid) from public,anon,authenticated;
grant execute on function public.integration_claim_connection(uuid) to service_role;

create or replace function public.integration_retry(p_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare clinic uuid:=public.integration_owner(); c public.calendar_connections%rowtype; begin
 select * into c from public.calendar_connections where id=p_id and clinic_id=clinic and status<>'disconnected' and calendar_id is not null and credentials is not null for update;
 if c.id is null then raise exception 'Connection not found' using errcode='22023'; end if;
 if c.lease_until>now() then return; end if;
 update public.integration_jobs set dead_at=null,attempts=0,available_at=now(),last_error=null where connection_id=p_id;
 perform public.integration_enqueue(p_id,'pull','calendar');
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(clinic,auth.uid(),'calendar.retry',p_id);
end $$;

create or replace function public.integration_dashboard() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare clinic uuid:=public.integration_owner(); begin
 return jsonb_build_object('keys',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'prefix',prefix,'scopes',scopes,'expires_at',expires_at,'revoked_at',revoked_at,'last_used_at',last_used_at)) from public.integration_keys where clinic_id=clinic),'[]'::jsonb),
 'connections',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'google_account_id',c.google_account_id,'calendar_id',c.calendar_id,'calendar_name',c.calendar_name,'calendar_is_primary',c.calendar_is_primary,'staff_id',c.staff_id,'practitioner_name',(select full_name from public.staff where id=c.staff_id and clinic_id=clinic),'status',case when c.status='connected' and (c.last_synced_at is null or c.last_synced_at<now()-interval '5 minutes') then 'attention' else c.status end,'last_synced_at',c.last_synced_at,'last_error',c.last_error,'watch_error',c.watch_error,'busy_until',c.busy_until,'sync_state',case when c.status='disconnected' then 'disconnected' when c.calendar_id is null then 'selection_required' when c.lease_until>now() then 'running' when c.last_error is not null then 'retry_required' when c.last_synced_at is null then 'queued' when c.last_synced_at<now()-interval '5 minutes' then 'stale' else 'current' end) order by c.created_at desc) from public.calendar_connections c where c.clinic_id=clinic),'[]'::jsonb),
 'failed_jobs',(select count(*) from public.integration_jobs j join public.calendar_connections c on c.id=j.connection_id where c.clinic_id=clinic and j.dead_at is not null));
end $$;
create or replace function public.integration_finish(p_job uuid,p_lease uuid,p_generation bigint,p_error text default null,p_delay integer default 0) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.integration_jobs%rowtype; completion_error text; begin
 select * into j from public.integration_jobs where id=p_job and lease_id=p_lease and lease_until>now() for update;
 if j.id is null then return; end if;
 completion_error:=case when j.generation=p_generation then p_error else null end;
 if p_error is null and j.generation=p_generation then delete from public.integration_jobs where id=j.id;
 else update public.integration_jobs set lease_id=null,lease_until=null,last_error=completion_error,
 available_at=case when generation<>p_generation then now() else now()+make_interval(secs=>greatest(0,least(3600,p_delay))) end,
 dead_at=case when attempts>=8 and generation=p_generation and p_error is not null then now() else null end where id=j.id; end if;
 update public.calendar_connections set lease_id=null,lease_until=null,
 last_error=coalesce(completion_error,case when conflict_detected then 'external_calendar_conflict' end,(select last_error from public.integration_jobs where connection_id=j.connection_id and last_error is not null limit 1)),
 status=case when completion_error is not null or conflict_detected or exists(select 1 from public.integration_jobs where connection_id=j.connection_id and last_error is not null) then 'attention' when last_synced_at>=now()-interval '5 minutes' and busy_from is not null and busy_until is not null then 'connected' when calendar_id is not null and last_synced_at is null then 'pending' else status end where id=j.connection_id and lease_id=p_lease;
end $$;
-- Only the operator/cron role can invoke scheduling, and only for the explicitly
-- approved non-primary mapping. Changing a mapping cannot redirect this job.
create function public.integration_scheduled_sync(p_connection uuid,p_calendar text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare endpoint text; worker_secret text; begin
 if not exists(select 1 from public.calendar_connections where id=p_connection and calendar_id=p_calendar and calendar_is_primary=false and status<>'disconnected' and credentials is not null) then return; end if;
 select decrypted_secret into endpoint from vault.decrypted_secrets where name='apero_integration_worker_url';
 select decrypted_secret into worker_secret from vault.decrypted_secrets where name='apero_integration_worker_secret';
 if endpoint is null or endpoint !~ '^https://[a-z]{20}\.supabase\.co/functions/v1/integration-worker$' or worker_secret is null or worker_secret !~ '^[a-f0-9]{64}$' then raise exception 'Integration worker configuration unavailable'; end if;
 perform net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||worker_secret),body:=jsonb_build_object('connection_id',p_connection),timeout_milliseconds:=55000);
end $$;
revoke all on function public.integration_scheduled_sync(uuid,text) from public,anon,authenticated,service_role;
commit;
