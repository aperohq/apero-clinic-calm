begin;
-- Definer search paths must contain no browser-writable schema.
revoke create on schema public from public,anon,authenticated;
-- Internal integration tables deliberately expose no browser table privileges.
create table public.integration_keys (
 id uuid primary key default gen_random_uuid(), clinic_id uuid not null references public.clinics on delete cascade,
 name text not null check(length(name) between 1 and 80), key_hash text not null unique check(key_hash ~ '^[a-f0-9]{64}$'),
 prefix text not null, scopes text[] not null check(cardinality(scopes)>0 and scopes <@ array['appointments:read','appointments:write','availability:read']),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '90 days',
 revoked_at timestamptz, last_used_at timestamptz, window_start timestamptz, request_count integer not null default 0
);
create table public.calendar_connections (
 id uuid primary key default gen_random_uuid(), clinic_id uuid not null references public.clinics on delete cascade,
 provider text not null default 'google' check(provider='google'), credentials text,
 calendar_id text, staff_id uuid references public.staff on delete cascade,
 status text not null default 'pending' check(status in ('pending','connected','attention','disconnected')),
 busy_from timestamptz, busy_until timestamptz, last_synced_at timestamptz,
 conflict_detected boolean not null default false, last_error text, created_at timestamptz not null default now(), lease_id uuid, lease_until timestamptz,
 check(calendar_id is null or staff_id is not null)
);
create unique index calendar_active_staff on public.calendar_connections(clinic_id,staff_id) where status<>'disconnected';
create unique index calendar_active_calendar on public.calendar_connections(clinic_id,calendar_id) where status<>'disconnected';
create table public.integration_oauth_states (
 state_hash text primary key, clinic_id uuid not null references public.clinics on delete cascade,
 actor_id uuid not null, verifier text not null, expires_at timestamptz not null default now()+interval '10 minutes'
);
create table public.calendar_busy_intervals (
 connection_id uuid not null references public.calendar_connections on delete cascade,
 event_id text not null, start_time timestamptz not null, end_time timestamptz not null,
 appointment_id uuid, primary key(connection_id,event_id), check(end_time>start_time)
);
create index calendar_busy_range on public.calendar_busy_intervals(connection_id,start_time,end_time);
-- Preserve remote identity through local hard deletion until its cancellation job finishes.
create table public.calendar_event_links (
 connection_id uuid not null references public.calendar_connections on delete cascade,
 appointment_id uuid not null, external_id text not null, revision integer not null default 0,
 primary key(connection_id,appointment_id),unique(connection_id,external_id)
);
create table public.integration_jobs (
 id uuid primary key default gen_random_uuid(), connection_id uuid not null references public.calendar_connections on delete cascade,
 kind text not null check(kind in ('push','pull')), object_id text not null,
 generation bigint not null default 1, attempts integer not null default 0,
 available_at timestamptz not null default now(), lease_id uuid, lease_until timestamptz,
 dead_at timestamptz, last_error text, unique(connection_id,kind,object_id)
);
create index integration_jobs_due on public.integration_jobs(available_at) where dead_at is null;
create table public.integration_requests (
 key_id uuid not null references public.integration_keys on delete cascade,
 request_key text not null check(length(request_key) between 8 and 128), fingerprint jsonb not null,
 result jsonb not null, created_at timestamptz not null default now(), primary key(key_id,request_key)
);
create index integration_request_age on public.integration_requests(created_at);
create table public.integration_audit (
 id uuid primary key default gen_random_uuid(), clinic_id uuid not null references public.clinics on delete cascade,
 actor_id uuid, action text not null, object_id uuid, created_at timestamptz not null default now()
);
create index integration_audit_age on public.integration_audit(created_at);
-- Revoke inherited/default broad grants too, including TRUNCATE/REFERENCES.
do $$ declare t text; begin
 foreach t in array array['integration_keys','calendar_connections','integration_oauth_states','calendar_busy_intervals','calendar_event_links','integration_jobs','integration_requests','integration_audit'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

create function public.integration_owner() returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid; begin
 select clinic_id into c from public.profiles where auth_user_id=auth.uid() and role='owner' and revoked_at is null for share;
 if c is null then raise exception 'Not authorized' using errcode='42501'; end if; return c;
end $$;
revoke all on function public.integration_owner() from public,anon;
grant execute on function public.integration_owner() to authenticated;

create function public.integration_dashboard() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid:=public.integration_owner(); begin
 return jsonb_build_object('keys',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'prefix',prefix,'scopes',scopes,'expires_at',expires_at,'revoked_at',revoked_at,'last_used_at',last_used_at)) from public.integration_keys where clinic_id=c),'[]'::jsonb),
 'connections',coalesce((select jsonb_agg(jsonb_build_object('id',id,'calendar_id',calendar_id,'staff_id',staff_id,'status',case when status='connected' and last_synced_at<now()-interval '5 minutes' then 'attention' else status end,'last_synced_at',last_synced_at,'last_error',last_error,'busy_until',busy_until)) from public.calendar_connections where clinic_id=c),'[]'::jsonb),
 'failed_jobs',(select count(*) from public.integration_jobs j join public.calendar_connections c1 on c1.id=j.connection_id where c1.clinic_id=c and j.dead_at is not null));
end $$;
revoke all on function public.integration_dashboard() from public,anon;
grant execute on function public.integration_dashboard() to authenticated;

-- Secret material is generated by pgcrypto and returned exactly once. Only its digest is stored.
create function public.integration_create_key(p_name text,p_scopes text[],p_rotate_id uuid default null) returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare c uuid:=public.integration_owner(); raw text; k public.integration_keys%rowtype; begin
 perform 1 from public.clinics where id=c for update;
 if length(trim(p_name)) not between 1 and 80 or p_name is null or p_scopes is null or cardinality(p_scopes)=0 or not p_scopes <@ array['appointments:read','appointments:write','availability:read'] then raise exception 'Invalid key parameters' using errcode='22023'; end if;
 if p_rotate_id is not null then
  update public.integration_keys set revoked_at=now() where id=p_rotate_id and clinic_id=c and revoked_at is null;
  if not found then raise exception 'Key not found' using errcode='22023'; end if;
 end if;
 if (select count(*) from public.integration_keys where clinic_id=c and revoked_at is null and expires_at>now())>=20 then raise exception 'Key limit reached' using errcode='22023'; end if;
 raw:='apero_'||encode(gen_random_bytes(32),'hex');
 insert into public.integration_keys(clinic_id,name,key_hash,prefix,scopes) values(c,trim(p_name),encode(digest(raw,'sha256'),'hex'),left(raw,14),p_scopes) returning * into k;
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(c,auth.uid(),case when p_rotate_id is null then 'key.created' else 'key.rotated' end,k.id);
 return jsonb_build_object('id',k.id,'key',raw,'expires_at',k.expires_at);
end $$;
revoke all on function public.integration_create_key(text,text[],uuid) from public,anon;
grant execute on function public.integration_create_key(text,text[],uuid) to authenticated;
create function public.integration_revoke_key(p_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid:=public.integration_owner(); begin
 update public.integration_keys set revoked_at=coalesce(revoked_at,now()) where id=p_id and clinic_id=c;
 if not found then raise exception 'Key not found' using errcode='22023'; end if;
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(c,auth.uid(),'key.revoked',p_id);
end $$;
revoke all on function public.integration_revoke_key(uuid) from public,anon;
grant execute on function public.integration_revoke_key(uuid) to authenticated;

create function public.integration_authorize(p_hash text,p_scope text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare k public.integration_keys%rowtype; begin
 select * into k from public.integration_keys where key_hash=p_hash and revoked_at is null and expires_at>now() for update;
 if k.id is null or not p_scope=any(k.scopes) then return null; end if;
 if k.window_start>now()-interval '1 minute' and k.request_count>=60 then return jsonb_build_object('limited',true); end if;
 update public.integration_keys set last_used_at=now(),window_start=case when window_start>now()-interval '1 minute' then window_start else now() end,
 request_count=case when window_start>now()-interval '1 minute' then request_count+1 else 1 end where id=k.id;
 return jsonb_build_object('id',k.id,'clinic_id',k.clinic_id);
end $$;
revoke all on function public.integration_authorize(text,text) from public,anon,authenticated;
grant execute on function public.integration_authorize(text,text) to service_role;

create function public.integration_enqueue(p_connection uuid,p_kind text,p_object text) returns void language sql security definer set search_path=public,pg_temp as $$
 insert into public.integration_jobs(connection_id,kind,object_id) values(p_connection,p_kind,p_object)
 on conflict(connection_id,kind,object_id) do update set generation=integration_jobs.generation+1,available_at=now(),dead_at=null,attempts=0
$$;
revoke all on function public.integration_enqueue(uuid,text,text) from public,anon,authenticated;
grant execute on function public.integration_enqueue(uuid,text,text) to service_role;
create function public.integration_appointment_outbox() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare c record; begin
 for c in select id from public.calendar_connections where clinic_id=coalesce(new.clinic_id,old.clinic_id) and calendar_id is not null and status<>'disconnected' and (staff_id=new.staff_id or staff_id=old.staff_id) loop
  perform public.integration_enqueue(c.id,'push',coalesce(new.id,old.id)::text);
 end loop;
 return null;
end $$;
revoke all on function public.integration_appointment_outbox() from public,anon,authenticated;
create trigger integration_appointment_outbox after insert or update or delete on public.appointments for each row execute function public.integration_appointment_outbox();

-- Wrap existing rules so portal, API and Retell share the same calendar gate.
alter function public.appointment_slot_open(uuid,uuid,text,timestamptz,timestamptz,uuid) rename to appointment_slot_open_without_calendars;
create function public.integration_calendar_open(p_clinic uuid,p_staff uuid,p_start timestamptz,p_end timestamptz,p_exclude uuid) returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' and p_clinic is distinct from public.current_clinic_id() then return false; end if;
 return not exists(select 1 from public.calendar_connections c where c.clinic_id=p_clinic and c.staff_id=p_staff and c.calendar_id is not null and c.status<>'disconnected' and
 (c.status<>'connected' or c.last_synced_at is null or c.last_synced_at<now()-interval '5 minutes' or p_start<c.busy_from or p_end>c.busy_until or
 exists(select 1 from public.calendar_busy_intervals b where b.connection_id=c.id and (p_exclude is null or b.appointment_id is distinct from p_exclude) and b.start_time<p_end and b.end_time>p_start)));
end $$;
revoke all on function public.integration_calendar_open(uuid,uuid,timestamptz,timestamptz,uuid) from public,anon;
grant execute on function public.integration_calendar_open(uuid,uuid,timestamptz,timestamptz,uuid) to authenticated,service_role;
create function public.appointment_slot_open(p_clinic_id uuid,p_staff_id uuid,p_service text,p_start timestamptz,p_end timestamptz,p_exclude_id uuid default null) returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
 select public.appointment_slot_open_without_calendars(p_clinic_id,p_staff_id,p_service,p_start,p_end,p_exclude_id) and public.integration_calendar_open(p_clinic_id,p_staff_id,p_start,p_end,p_exclude_id)
$$;
revoke all on function public.appointment_slot_open(uuid,uuid,text,timestamptz,timestamptz,uuid) from public,anon;
grant execute on function public.appointment_slot_open(uuid,uuid,text,timestamptz,timestamptz,uuid) to authenticated,service_role;

-- Serialize local booking acceptance with busy-snapshot replacement. The provider
-- itself has no distributed transaction; provider-side races surface as conflicts.
create function public.integration_booking_lock() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status<>'Booked' then return new; end if;
 if tg_op='UPDATE' and row(new.staff_id,new.start_time,new.end_time,new.status) is not distinct from row(old.staff_id,old.start_time,old.end_time,old.status) then return new; end if;
 perform 1 from public.calendar_connections where clinic_id=new.clinic_id and staff_id=new.staff_id and calendar_id is not null and status<>'disconnected' order by id for share;
 if not public.integration_calendar_open(new.clinic_id,new.staff_id,new.start_time,new.end_time,case when tg_op='UPDATE' then old.id else null end) then raise exception 'That time is unavailable. Refresh available slots.' using errcode='23P01'; end if;
 return new;
end $$;
revoke all on function public.integration_booking_lock() from public,anon,authenticated;
create trigger a_integration_booking_lock before insert or update on public.appointments for each row execute function public.integration_booking_lock();

create function public.integration_mutate(p_key uuid,p_request text,p_body jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare k public.integration_keys%rowtype; r public.integration_requests%rowtype; a public.appointments%rowtype; action text:=p_body->>'action'; result jsonb; begin
 select * into k from public.integration_keys where id=p_key and revoked_at is null and expires_at>now() for share;
 if k.id is null or not 'appointments:write'=any(k.scopes) then raise exception 'Not authorized' using errcode='42501'; end if;
 if length(p_request) not between 8 and 128 or p_request is null then raise exception 'Invalid idempotency key' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(k.id::text||p_request,0));
 select * into r from public.integration_requests where key_id=k.id and request_key=p_request;
 if r.key_id is not null then
  if r.fingerprint<>p_body then raise exception 'Idempotency key reused' using errcode='23505'; end if; return r.result;
 end if;
 if action='book' then
  if not exists(select 1 from public.clients where id=(p_body->>'client_id')::uuid and clinic_id=k.clinic_id) then raise exception 'Invalid client' using errcode='22023'; end if;
  insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time,source)
  values(k.clinic_id,(p_body->>'client_id')::uuid,(p_body->>'staff_id')::uuid,p_body->>'service',(p_body->>'start_time')::timestamptz,(p_body->>'end_time')::timestamptz,'Integration') returning * into a;
 elsif action in ('cancel','reschedule') then
  select * into a from public.appointments where id=(p_body->>'appointment_id')::uuid and clinic_id=k.clinic_id for update;
  if a.id is null then raise exception 'Appointment not found' using errcode='P0002'; end if;
  if action='cancel' then update public.appointments set status='Cancelled' where id=a.id returning * into a;
  else update public.appointments set start_time=(p_body->>'start_time')::timestamptz,end_time=(p_body->>'end_time')::timestamptz,staff_id=coalesce((p_body->>'staff_id')::uuid,a.staff_id) where id=a.id returning * into a; end if;
 else raise exception 'Invalid action' using errcode='22023'; end if;
 result:=jsonb_build_object('id',a.id,'status',a.status,'start_time',a.start_time,'end_time',a.end_time);
 insert into public.integration_requests(key_id,request_key,fingerprint,result) values(k.id,p_request,p_body,result);
 insert into public.integration_audit(clinic_id,action,object_id) values(k.clinic_id,'appointment.'||action,a.id);
 return result;
end $$;
revoke all on function public.integration_mutate(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.integration_mutate(uuid,text,jsonb) to service_role;

create function public.integration_event_link(p_connection uuid,p_lease uuid,p_appointment uuid,p_rotate boolean default false) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.calendar_event_links%rowtype; begin
 perform 1 from public.calendar_connections where id=p_connection and lease_id=p_lease and lease_until>now() and status<>'disconnected' for update;
 if not found then raise exception 'Lease lost' using errcode='40001'; end if;
 insert into public.calendar_event_links(connection_id,appointment_id,external_id) values(p_connection,p_appointment,'apero'||replace(p_appointment::text,'-','')) on conflict do nothing;
 select * into l from public.calendar_event_links where connection_id=p_connection and appointment_id=p_appointment for update;
 if p_rotate then
  update public.calendar_event_links set revision=revision+1,external_id='apero'||replace(p_appointment::text,'-','')||'r'||to_hex(revision+1) where connection_id=p_connection and appointment_id=p_appointment returning * into l;
 end if;
 return l.external_id;
end $$;
revoke all on function public.integration_event_link(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.integration_event_link(uuid,uuid,uuid,boolean) to service_role;

create function public.integration_refresh_claim(p_id uuid,p_credentials text,p_existing_lease uuid default null) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; lease uuid; begin
 select * into c from public.calendar_connections where id=p_id and credentials=p_credentials and status<>'disconnected' for update;
 if c.id is null then return null; end if;
 if p_existing_lease is not null then
  if c.lease_id=p_existing_lease and c.lease_until>now() then return p_existing_lease; end if; return null;
 end if;
 if c.lease_until>now() then return null; end if;
 lease:=gen_random_uuid();
 update public.calendar_connections set lease_id=lease,lease_until=now()+interval '180 seconds' where id=c.id;
 return lease;
end $$;
revoke all on function public.integration_refresh_claim(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.integration_refresh_claim(uuid,text,uuid) to service_role;
create function public.integration_refresh_release(p_id uuid,p_lease uuid) returns void language sql security definer set search_path=public,pg_temp as $$
 update public.calendar_connections set lease_id=null,lease_until=null where id=p_id and lease_id=p_lease and not exists(select 1 from public.integration_jobs where lease_id=p_lease)
$$;
revoke all on function public.integration_refresh_release(uuid,uuid) from public,anon,authenticated;
grant execute on function public.integration_refresh_release(uuid,uuid) to service_role;

create function public.integration_claim() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
revoke all on function public.integration_claim() from public,anon,authenticated;
grant execute on function public.integration_claim() to service_role;
create function public.integration_finish(p_job uuid,p_lease uuid,p_generation bigint,p_error text default null,p_delay integer default 0) returns void language plpgsql security definer set search_path=public,pg_temp as $$
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
revoke all on function public.integration_finish(uuid,uuid,bigint,text,integer) from public,anon,authenticated;
grant execute on function public.integration_finish(uuid,uuid,bigint,text,integer) to service_role;

create function public.integration_replace_busy(p_connection uuid,p_lease uuid,p_from timestamptz,p_until timestamptz,p_events jsonb,p_generation bigint default null) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; conflict boolean; begin
 select * into c from public.calendar_connections where id=p_connection and lease_id=p_lease and lease_until>now() and status<>'disconnected' for update;
 if c.id is null then raise exception 'Lease lost' using errcode='40001'; end if;
 if p_generation is not null and exists(select 1 from public.integration_jobs where connection_id=c.id and kind='pull' and lease_id=p_lease and generation<>p_generation) then raise exception 'Snapshot invalidated' using errcode='40001'; end if;
 delete from public.calendar_busy_intervals where connection_id=c.id;
 insert into public.calendar_busy_intervals(connection_id,event_id,start_time,end_time,appointment_id)
 select c.id,e->>'id',(e->>'start')::timestamptz,(e->>'end')::timestamptz,
 (select a.id from public.appointments a join public.calendar_event_links l on l.appointment_id=a.id and l.connection_id=c.id where a.clinic_id=c.clinic_id and l.external_id=e->>'id') from jsonb_array_elements(p_events) e;
 -- Detect provider-side conflicts with already committed local appointments.
 select exists(select 1 from public.calendar_busy_intervals b join public.appointments a on a.clinic_id=c.clinic_id and a.staff_id=c.staff_id and a.status='Booked'
 where b.connection_id=c.id and b.start_time<a.end_time and b.end_time>a.start_time and (b.appointment_id is null or b.appointment_id<>a.id)) into conflict;
 -- Reconcile missing/edited owned events without resetting failed jobs or retry budgets.
 insert into public.integration_jobs(connection_id,kind,object_id)
 select c.id,'push',a.id::text from public.appointments a where a.clinic_id=c.clinic_id and a.staff_id=c.staff_id and a.status='Booked' and a.end_time>now() and a.start_time<p_until and not exists(select 1 from public.calendar_busy_intervals b where b.connection_id=c.id and b.appointment_id=a.id and b.start_time=a.start_time and b.end_time=a.end_time) on conflict do nothing;
 update public.calendar_connections set busy_from=p_from,busy_until=p_until,last_synced_at=now(),conflict_detected=conflict,
 status=case when conflict or exists(select 1 from public.integration_jobs where connection_id=c.id and last_error is not null) then 'attention' else 'connected' end,
 last_error=case when conflict then 'external_calendar_conflict' else (select last_error from public.integration_jobs where connection_id=c.id and last_error is not null limit 1) end where id=c.id;
end $$;
revoke all on function public.integration_replace_busy(uuid,uuid,timestamptz,timestamptz,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.integration_replace_busy(uuid,uuid,timestamptz,timestamptz,jsonb,bigint) to service_role;

create function public.integration_start_oauth(p_clinic uuid,p_actor uuid,p_hash text,p_verifier text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from public.profiles where auth_user_id=p_actor and clinic_id=p_clinic and role='owner' and revoked_at is null for update;
 if not found then raise exception 'Not authorized' using errcode='42501'; end if;
 perform 1 from public.clinics where id=p_clinic for update;
 delete from public.integration_oauth_states where expires_at<now();
 if (select count(*) from public.integration_oauth_states where clinic_id=p_clinic)>=5 then raise exception 'OAuth limit' using errcode='22023'; end if;
 insert into public.integration_oauth_states(state_hash,clinic_id,actor_id,verifier) values(p_hash,p_clinic,p_actor,p_verifier);
end $$;
revoke all on function public.integration_start_oauth(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.integration_start_oauth(uuid,uuid,text,text) to service_role;
create function public.integration_save_connection(p_id uuid,p_clinic uuid,p_actor uuid,p_credentials text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from public.profiles where auth_user_id=p_actor and clinic_id=p_clinic and role='owner' and revoked_at is null for update;
 if not found then raise exception 'Not authorized' using errcode='42501'; end if;
 perform 1 from public.clinics where id=p_clinic for update;
 if (select count(*) from public.calendar_connections where clinic_id=p_clinic and status<>'disconnected')>=20 then raise exception 'Connection limit' using errcode='22023'; end if;
 insert into public.calendar_connections(id,clinic_id,credentials) values(p_id,p_clinic,p_credentials);
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(p_clinic,p_actor,'calendar.authorized',p_id);
end $$;
revoke all on function public.integration_save_connection(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.integration_save_connection(uuid,uuid,uuid,text) to service_role;
create function public.integration_select_calendar(p_id uuid,p_calendar text,p_staff uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid:=public.integration_owner(); a record; begin
 if p_calendar is null or length(p_calendar) not between 1 and 1024 or not exists(select 1 from public.staff where id=p_staff and clinic_id=c and active) then raise exception 'Invalid selection' using errcode='22023'; end if;
 update public.calendar_connections set calendar_id=p_calendar,staff_id=p_staff,status='attention',last_synced_at=null where id=p_id and clinic_id=c and status<>'disconnected' and calendar_id is null;
 if not found then raise exception 'Selection immutable; disconnect before replacing' using errcode='22023'; end if;
 perform public.integration_enqueue(p_id,'pull','calendar');
 for a in select id from public.appointments where clinic_id=c and staff_id=p_staff and status='Booked' and end_time>now() loop perform public.integration_enqueue(p_id,'push',a.id::text); end loop;
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(c,auth.uid(),'calendar.selected',p_id);
end $$;
revoke all on function public.integration_select_calendar(uuid,text,uuid) from public,anon;
grant execute on function public.integration_select_calendar(uuid,text,uuid) to authenticated;
create function public.integration_disconnect(p_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid:=public.integration_owner(); begin
 update public.calendar_connections set status='disconnected',credentials=null,lease_id=null,lease_until=null where id=p_id and clinic_id=c;
 if not found then raise exception 'Connection not found' using errcode='22023'; end if;
 delete from public.calendar_busy_intervals where connection_id=p_id;
 delete from public.integration_jobs where connection_id=p_id;
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(c,auth.uid(),'calendar.disconnected',p_id);
end $$;
revoke all on function public.integration_disconnect(uuid) from public,anon;
grant execute on function public.integration_disconnect(uuid) to authenticated;
create function public.integration_retry(p_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c uuid:=public.integration_owner(); begin
 perform 1 from public.calendar_connections where id=p_id and clinic_id=c and status<>'disconnected' and calendar_id is not null for update;
 if not found then raise exception 'Connection not found' using errcode='22023'; end if;
 update public.integration_jobs set dead_at=null,attempts=0,available_at=now(),last_error=null where connection_id=p_id;
 perform public.integration_enqueue(p_id,'pull','calendar');
 insert into public.integration_audit(clinic_id,actor_id,action,object_id) values(c,auth.uid(),'calendar.retry',p_id);
end $$;
revoke all on function public.integration_retry(uuid) from public,anon;
grant execute on function public.integration_retry(uuid) to authenticated;

alter table public.calendar_connections add column channel_id uuid, add column channel_hash text, add column resource_id text, add column channel_expires_at timestamptz, add column message_number numeric not null default 0;
create function public.integration_notify(p_channel uuid,p_hash text,p_resource text,p_number numeric,p_state text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; begin
 select * into c from public.calendar_connections where channel_id=p_channel and channel_hash=p_hash and status<>'disconnected' and channel_expires_at>now() for update;
 if c.id is null or p_state not in ('sync','exists','not_exists') or p_number<=0 then return false; end if;
 -- Initial sync may arrive while events.watch is still returning the resource ID.
 if c.resource_id is null and p_state='sync' then return true; end if;
 if c.resource_id is distinct from p_resource then return false; end if;
 if p_number<=c.message_number then return true; end if;
 update public.calendar_connections set message_number=p_number,last_synced_at=null where id=c.id;
 perform public.integration_enqueue(c.id,'pull','calendar'); return true;
end $$;
revoke all on function public.integration_notify(uuid,text,text,numeric,text) from public,anon,authenticated;
grant execute on function public.integration_notify(uuid,text,text,numeric,text) to service_role;

-- Cleanup is deliberately callable only by trusted worker; retain audit without payloads.
create function public.integration_cleanup() returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 delete from public.integration_oauth_states where expires_at<now();
 if not exists(select 1 from public.retention_control where singleton and mode='enabled' and approved_at is not null) then return; end if;
 delete from public.integration_requests r using public.integration_keys k where k.id=r.key_id
 and r.created_at<now()-make_interval(days=>public.retention_days(k.clinic_id,'operation_days'))
 and not exists(select 1 from public.clinic_retention where clinic_id=k.clinic_id and (legal_hold or paused));
 delete from public.integration_audit a where a.created_at<now()-make_interval(days=>public.retention_days(a.clinic_id,'audit_days'))
 and not exists(select 1 from public.clinic_retention where clinic_id=a.clinic_id and (legal_hold or paused));
end $$;
revoke all on function public.integration_cleanup() from public,anon,authenticated;
grant execute on function public.integration_cleanup() to service_role;
-- Approved offboarding immediately invalidates all new integration authority too.
create function public.integration_offboarding() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.state='disabled' then return new; end if;
 update public.integration_keys set revoked_at=coalesce(revoked_at,now()) where clinic_id=new.clinic_id;
 update public.calendar_connections set credentials=null,status='disconnected',lease_id=null,lease_until=null where clinic_id=new.clinic_id;
 delete from public.integration_jobs where connection_id in (select id from public.calendar_connections where clinic_id=new.clinic_id);
 delete from public.calendar_busy_intervals where connection_id in (select id from public.calendar_connections where clinic_id=new.clinic_id);
 delete from public.integration_oauth_states where clinic_id=new.clinic_id;
 return new;
end $$;
revoke all on function public.integration_offboarding() from public,anon,authenticated,service_role;
create trigger integration_offboarding after insert or update of state on public.clinic_offboarding for each row execute function public.integration_offboarding();
-- Do not rewrite pre-existing clinic data; deny provisioning into an offboarding clinic.
create function public.integration_clinic_guard() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from public.clinic_offboarding where clinic_id=new.clinic_id and state<>'disabled') then raise exception 'Clinic is offboarding' using errcode='42501'; end if;
 return new;
end $$;
revoke all on function public.integration_clinic_guard() from public,anon,authenticated,service_role;
create trigger integration_clinic_guard before insert on public.integration_keys for each row execute function public.integration_clinic_guard();
create trigger integration_clinic_guard before insert on public.calendar_connections for each row execute function public.integration_clinic_guard();
create trigger integration_clinic_guard before insert on public.integration_oauth_states for each row execute function public.integration_clinic_guard();
commit;
