-- Pause the integration scheduler before restoring the previous Edge bundles.
-- Retain added metadata, ciphertext, history and all booking safety gates.
begin;

create or replace function public.integration_save_connection(p_id uuid,p_clinic uuid,p_actor uuid,p_credentials text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from public.profiles where auth_user_id=p_actor and clinic_id=p_clinic and role='owner' and revoked_at is null for update;
 if not found then raise exception 'Not authorized' using errcode='42501'; end if;
 perform 1 from public.clinics where id=p_clinic for update;
 if (select count(*) from public.calendar_connections where clinic_id=p_clinic and status<>'disconnected')>=20 then raise exception 'Connection limit' using errcode='22023'; end if;
 insert into public.calendar_connections(id,clinic_id,credentials) values(p_id,p_clinic,p_credentials);
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(p_clinic,p_actor,'calendar.authorized',p_id);
end $$;

create or replace function public.integration_select_calendar(p_id uuid,p_calendar text,p_staff uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid:=public.integration_owner(); a record; begin
 if p_calendar is null or length(p_calendar) not between 1 and 1024 or not exists(select 1 from public.staff where id=p_staff and clinic_id=c and active) then raise exception 'Invalid selection' using errcode='22023'; end if;
 update public.calendar_connections set calendar_id=p_calendar,staff_id=p_staff,status='attention',last_synced_at=null where id=p_id and clinic_id=c and status<>'disconnected' and calendar_id is null;
 if not found then raise exception 'Selection immutable; disconnect before replacing' using errcode='22023'; end if;
 perform public.integration_enqueue(p_id,'pull','calendar');
 for a in select id from public.appointments where clinic_id=c and staff_id=p_staff and status='Booked' and end_time>now() loop perform public.integration_enqueue(p_id,'push',a.id::text); end loop;
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(c,auth.uid(),'calendar.selected',p_id);
end $$;

create or replace function public.integration_claim() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; j public.integration_jobs%rowtype; lease uuid:=gen_random_uuid(); begin
 -- Periodic reconciliation also recovers lost notifications; no external scheduler is installed by migration.
 insert into public.integration_jobs(connection_id,kind,object_id) select id,'pull','calendar' from public.calendar_connections where calendar_id is not null and status in ('connected','attention') and credentials is not null and (last_synced_at is null or last_synced_at<now()-interval '1 minute') on conflict do nothing;
 select c1.* into c from public.calendar_connections c1 where c1.status<>'disconnected' and (c1.lease_until is null or c1.lease_until<now()) and exists(select 1 from public.integration_jobs j1 where j1.connection_id=c1.id and j1.dead_at is null and j1.available_at<=now()) order by c1.last_synced_at nulls first for update skip locked limit 1;
 if c.id is null then return null; end if;
 select * into j from public.integration_jobs where connection_id=c.id and dead_at is null and available_at<=now() order by case when kind='pull' then 0 else 1 end,available_at for update skip locked limit 1;
 update public.calendar_connections set lease_id=lease,lease_until=now()+interval '180 seconds' where id=c.id;
 update public.integration_jobs set lease_id=lease,lease_until=now()+interval '180 seconds',attempts=attempts+1 where id=j.id returning * into j;
 return jsonb_build_object('connection',to_jsonb(c),'job',to_jsonb(j),'lease',lease);
end $$;

create or replace function public.integration_retry(p_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid:=public.integration_owner(); begin
 perform 1 from public.calendar_connections where id=p_id and clinic_id=c and status<>'disconnected' and calendar_id is not null for update;
 if not found then raise exception 'Connection not found' using errcode='22023'; end if;
 update public.integration_jobs set dead_at=null,attempts=0,available_at=now(),last_error=null where connection_id=p_id;
 perform public.integration_enqueue(p_id,'pull','calendar');
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(c,auth.uid(),'calendar.retry',p_id);
end $$;

create or replace function public.integration_dashboard() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid:=public.integration_owner(); begin
 return jsonb_build_object('keys',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'prefix',prefix,'scopes',scopes,'expires_at',expires_at,'revoked_at',revoked_at,'last_used_at',last_used_at)) from public.integration_keys where clinic_id=c),'[]'::jsonb),
 'connections',coalesce((select jsonb_agg(jsonb_build_object('id',id,'calendar_id',calendar_id,'staff_id',staff_id,'status',case when status='connected' and last_synced_at<now()-interval '5 minutes' then 'attention' else status end,'last_synced_at',last_synced_at,'last_error',last_error,'busy_until',busy_until)) from public.calendar_connections where clinic_id=c),'[]'::jsonb),
 'failed_jobs',(select count(*) from public.integration_jobs j join public.calendar_connections c1 on c1.id=j.connection_id where c1.clinic_id=c and j.dead_at is not null));
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
 status=case when completion_error is not null or conflict_detected or exists(select 1 from public.integration_jobs where connection_id=j.connection_id and last_error is not null) then 'attention' else status end where id=j.connection_id and lease_id=p_lease;
end $$;

commit;
