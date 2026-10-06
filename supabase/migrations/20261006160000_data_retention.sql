-- Additive retention infrastructure. No existing patient rows are rewritten.
-- Global mode starts dry_run. Approval can only be recorded by a DB administrator.
begin;
create table public.retention_control (
 singleton boolean primary key default true check(singleton),
 mode text not null default 'dry_run' check(mode in ('disabled','dry_run','enabled')),
 policy_version integer not null default 1 check(policy_version=1),
 defaults jsonb not null default '{"call_content_days":30,"retell_call_days":30,"call_metadata_days":365,"appointment_days":730,"client_inactivity_days":730,"note_days":365,"closed_request_days":90,"operation_days":30,"call_state_days":30,"expired_slot_days":1,"notification_days":30,"revoked_user_days":90,"invitation_days":30,"audit_days":365,"offboarding_grace_days":30,"tombstone_min_days":400,"staff_contact_days":180,"staff_record_days":730}'::jsonb,
 approved_at timestamptz, restore_ledger_ready boolean not null default false,
 check(mode<>'enabled' or (approved_at is not null and restore_ledger_ready))
);
insert into public.retention_control(singleton) values(true);
create table public.clinic_retention (
 clinic_id uuid primary key references public.clinics(id),
 overrides jsonb not null default '{}', legal_hold boolean not null default false,
 paused boolean not null default false
);
-- Preserve a timestamp when shorter-lived source rows expire; no contact/text copy.
create table public.retention_client_activity(
 clinic_id uuid not null,client_id uuid primary key references public.clients(id) on delete cascade,
 last_activity_at timestamptz not null
);
alter table public.retention_client_activity enable row level security;
revoke all on public.retention_client_activity from public,anon,authenticated,service_role;
create table public.retention_runs (
 id uuid primary key default gen_random_uuid(), clinic_id uuid not null,
 started_at timestamptz not null default now(), category text not null,
 mode text not null check(mode in ('dry_run','enabled')),
 processed integer not null default 0 check(processed>=0),
 state text not null check(state in ('success','failure')),
 failure_category text check(failure_category in ('database_error','provider_error','configuration_error'))
);
-- Not a log: restricted enforcement identifiers only, never deleted content.
create table public.retention_deletion_ledger (
 id uuid primary key default gen_random_uuid(), clinic_id uuid not null,
 resource_table text not null, resource_key text not null, action text not null check(action in ('delete','clear_content','anonymize','offboard')),
 occurred_at timestamptz not null default now(), replay_until timestamptz not null default now()+interval '400 days',
 durable_at timestamptz,
 unique(clinic_id,resource_table,resource_key,action)
);
create table public.retention_provider_jobs (
 id uuid primary key default gen_random_uuid(), clinic_id uuid not null,
 provider text not null check(provider in ('retell','supabase_auth')),
 target_key text not null, agent_id text,
 state text not null default 'pending' check(state in ('pending','leased','succeeded')),
 lease_token uuid, lease_until timestamptz,
 attempts integer not null default 0, next_attempt_at timestamptz not null default now(),
 created_at timestamptz not null default now(), completed_at timestamptz,
 failure_category text check(failure_category in ('provider_error','database_error','configuration_error')),
 verified_key_fingerprint text, ownership_verified_at timestamptz,
 unique(clinic_id,provider,target_key)
);
create table public.clinic_offboarding (
 clinic_id uuid primary key, requested_at timestamptz not null default now(),
 grace_until timestamptz not null default now()+interval '30 days',
 state text not null default 'disabled' check(state in ('disabled','grace','purging','complete')),
 provider_inventory_verified boolean not null default false,
 telephony_stopped_verified boolean not null default false,
 secrets_revoked_verified boolean not null default false,
 active_work_handover_verified boolean not null default false,
 completed_at timestamptz
);
alter table public.voice_requests add column closed_at timestamptz;
alter table public.clients add column anonymized_at timestamptz;
alter table public.staff add column deactivated_at timestamptz;
-- Column ACLs on existing tables must not widen old browser privileges.
revoke all(closed_at) on public.voice_requests from public,anon,authenticated;
revoke all(anonymized_at) on public.clients from public,anon,authenticated;

create function public.retention_days(p_clinic uuid,p_key text) returns integer
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v integer;begin
 select coalesce((r.overrides->>p_key)::integer,(c.defaults->>p_key)::integer) into v
 from public.retention_control c left join public.clinic_retention r on r.clinic_id=p_clinic where c.singleton;
 if v is null or v<1 or v>3650 then raise exception 'Invalid retention configuration' using errcode='22023';end if;
 return v;end $$;
create function public.retention_validate_config() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare k text;v jsonb;begin
 for k,v in select * from jsonb_each(to_jsonb(new)->case when tg_table_name='clinic_retention' then 'overrides' else 'defaults' end) loop
 if k not in ('call_content_days','retell_call_days','call_metadata_days','appointment_days','client_inactivity_days','note_days','closed_request_days','operation_days','call_state_days','expired_slot_days','notification_days','revoked_user_days','invitation_days','audit_days','offboarding_grace_days','tombstone_min_days','staff_contact_days','staff_record_days') or jsonb_typeof(v)<>'number' or v::text !~ '^[0-9]+$' or (v::text)::integer not between 1 and 3650 then
 raise exception 'Invalid retention configuration' using errcode='22023';end if;end loop;
 if tg_table_name='retention_control' and not (to_jsonb(new)->'defaults') ?& array['call_content_days','retell_call_days','call_metadata_days','appointment_days','client_inactivity_days','note_days','closed_request_days','operation_days','call_state_days','expired_slot_days','notification_days','revoked_user_days','invitation_days','audit_days','offboarding_grace_days','tombstone_min_days','staff_contact_days','staff_record_days'] then raise exception 'Incomplete retention configuration';end if;
 return new;end $$;
create trigger retention_config_validate before insert or update on public.retention_control for each row execute function public.retention_validate_config();
create trigger retention_clinic_config_validate before insert or update on public.clinic_retention for each row execute function public.retention_validate_config();

create function public.retention_closed_clock() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.status='Closed' then
  if tg_op='INSERT' then new.closed_at=now();else new.closed_at=case when old.status='Closed' then coalesce(old.closed_at,now()) else now() end;end if;
 else new.closed_at=null;end if;return new;end $$;
create trigger retention_closed_clock before insert or update on public.voice_requests for each row execute function public.retention_closed_clock();

create function public.retention_staff_clock() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if not new.active then
 if tg_op='INSERT' then new.deactivated_at=now();else new.deactivated_at=case when not old.active then coalesce(old.deactivated_at,now()) else now() end;end if;
 else new.deactivated_at=null;end if;return new;end $$;
create trigger retention_staff_clock before insert or update on public.staff for each row execute function public.retention_staff_clock();

create function public.retention_client_protected(p_clinic uuid,p_client uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.appointments a where a.clinic_id=p_clinic and a.client_id=p_client and a.end_time>=now())
 or exists(select 1 from public.voice_requests r join public.clients c on c.id=p_client and c.clinic_id=p_clinic
 where r.clinic_id=p_clinic and r.status<>'Closed' and (
 (regexp_replace(r.phone,'[^0-9]','','g')<>'' and regexp_replace(r.phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g'))
 or exists(select 1 from public.conversations cv where cv.clinic_id=p_clinic and cv.client_id=p_client and cv.retell_call_id=r.call_id)))
$$;
create function public.retention_client_last_activity(p_clinic uuid,p_client uuid) returns timestamptz
language sql stable security definer set search_path=pg_catalog,public as $$
 select greatest(c.created_at,c.updated_at,
 (select last_activity_at from public.retention_client_activity x where x.clinic_id=p_clinic and x.client_id=p_client),
 (select max(greatest(a.end_time,a.updated_at)) from public.appointments a where a.clinic_id=p_clinic and a.client_id=p_client),
 (select max(cv.started_at) from public.conversations cv where cv.clinic_id=p_clinic and cv.client_id=p_client),
 (select max(n.created_at) from public.client_notes n where n.clinic_id=p_clinic and n.client_id=p_client),
 (select max(greatest(r.created_at,r.closed_at)) from public.voice_requests r where r.clinic_id=p_clinic and regexp_replace(r.phone,'[^0-9]','','g')<>'' and regexp_replace(r.phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g')))
from public.clients c where c.clinic_id=p_clinic and c.id=p_client
$$;

create function public.retention_activity_clock() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d jsonb;v_clinic uuid;v_client uuid;v_clock timestamptz;v_phone text;begin
 d:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 v_clinic:=(d->>'clinic_id')::uuid;
 v_clock:=greatest((d->>'created_at')::timestamptz,(d->>'updated_at')::timestamptz,(d->>'started_at')::timestamptz,
 (d->>'end_time')::timestamptz,(d->>'closed_at')::timestamptz);
 if tg_table_name='voice_requests' then
 v_phone:=regexp_replace(d->>'phone','[^0-9]','','g');
 insert into public.retention_client_activity(clinic_id,client_id,last_activity_at)
 select v_clinic,c.id,v_clock from public.clients c where c.clinic_id=v_clinic and v_phone<>'' and regexp_replace(c.phone,'[^0-9]','','g')=v_phone
 on conflict(client_id) do update set last_activity_at=greatest(retention_client_activity.last_activity_at,excluded.last_activity_at);
 else
 v_client:=(d->>'client_id')::uuid;
 if v_client is not null and v_clock is not null and exists(select 1 from public.clients where id=v_client and clinic_id=v_clinic) then
 insert into public.retention_client_activity(clinic_id,client_id,last_activity_at) values(v_clinic,v_client,v_clock)
 on conflict(client_id) do update set last_activity_at=greatest(retention_client_activity.last_activity_at,excluded.last_activity_at);
 end if;end if;
 return null;end $$;
create trigger retention_activity_appointments after insert or update or delete on public.appointments for each row execute function public.retention_activity_clock();
create trigger retention_activity_conversations after insert or update or delete on public.conversations for each row execute function public.retention_activity_clock();
create trigger retention_activity_notes after insert or update or delete on public.client_notes for each row execute function public.retention_activity_clock();
create trigger retention_activity_requests after insert or update or delete on public.voice_requests for each row execute function public.retention_activity_clock();

create view public.retention_candidates as
select clinic_id,'call_content'::text category,'conversations'::text resource_table,id::text resource_key,started_at as age_clock from public.conversations where started_at < now()-make_interval(days=>public.retention_days(clinic_id,'call_content_days')) and (transcript is not null or summary is not null or caller_phone is not null or recording_url is not null or title not in ('Phone Call','Call content removed'))
union all
select clinic_id,'retell_call'::text category,'conversations'::text resource_table,id::text resource_key,started_at as age_clock from public.conversations where retell_call_id is not null and retell_agent_id is not null and started_at < now()-make_interval(days=>public.retention_days(clinic_id,'retell_call_days')) and not exists(select 1 from public.retention_provider_jobs j where j.clinic_id=conversations.clinic_id and j.target_key=conversations.retell_call_id and j.provider='retell')
union all
select clinic_id,'call_metadata'::text category,'conversations'::text resource_table,id::text resource_key,started_at as age_clock from public.conversations where started_at < now()-make_interval(days=>public.retention_days(clinic_id,'call_metadata_days')) and not exists(select 1 from public.appointments a where a.clinic_id=conversations.clinic_id and a.id=conversations.appointment_id and a.end_time>=now()) and not exists(select 1 from public.voice_requests r where r.clinic_id=conversations.clinic_id and r.call_id=conversations.retell_call_id and r.status<>'Closed') and (retell_call_id is null or exists(select 1 from public.retention_provider_jobs j where j.clinic_id=conversations.clinic_id and j.provider='retell' and j.target_key=conversations.retell_call_id and j.state='succeeded'))
union all
select clinic_id,'closed_request'::text category,'voice_requests'::text resource_table,id::text resource_key,closed_at as age_clock from public.voice_requests where status='Closed' and closed_at < now()-make_interval(days=>public.retention_days(clinic_id,'closed_request_days'))
union all
select clinic_id,'appointment'::text category,'appointments'::text resource_table,id::text resource_key,end_time as age_clock from public.appointments where status in ('Completed','Cancelled','No Show') and end_time<now() and greatest(end_time,updated_at) < now()-make_interval(days=>public.retention_days(clinic_id,'appointment_days'))
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

create function public.retention_record(p_clinic uuid,p_table text,p_key text,p_action text) returns void
language sql security definer set search_path=pg_catalog,public as $$
 insert into public.retention_deletion_ledger(clinic_id,resource_table,resource_key,action,replay_until)
 values(p_clinic,p_table,p_key,p_action,now()+make_interval(days=>public.retention_days(p_clinic,'tombstone_min_days')))
 on conflict(clinic_id,resource_table,resource_key,action) do nothing
$$;
create function public.retention_queue_call(p_clinic uuid,p_call text,p_agent text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_call is not null then
  insert into public.retention_provider_jobs(clinic_id,provider,target_key,agent_id) values(p_clinic,'retell',p_call,p_agent) on conflict do nothing;
  perform public.retention_record(p_clinic,'retell_call',p_call,'clear_content');
 end if;end $$;

-- Always prevent manual client deletion from breaking upcoming appointments.
create function public.retention_client_delete_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if public.retention_client_protected(old.clinic_id,old.id) then raise exception 'Patient has active work; resolve before deletion' using errcode='23503';end if;
 if old.anonymized_at is null and not exists(select 1 from public.clinic_offboarding where clinic_id=old.clinic_id and state='purging') then raise exception 'Use reviewed patient erasure lifecycle before hard deletion' using errcode='23503';end if;
 return old;end $$;
create trigger retention_client_delete_guard before delete on public.clients for each row execute function public.retention_client_delete_guard();

create function public.retention_removed_client_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and old.anonymized_at is not null then
 new.full_name='Removed patient';new.phone='';new.email=null;new.notes=null;new.anonymized_at=old.anonymized_at;
 end if;return new;end $$;
create trigger retention_removed_client_guard before update on public.clients for each row execute function public.retention_removed_client_guard();

-- Serialize upcoming appointment creation against contact removal.
create function public.retention_appointment_client_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_removed timestamptz;begin
 if new.client_id is not null then
 select anonymized_at into v_removed from public.clients where id=new.client_id and clinic_id=new.clinic_id for update;
 if new.end_time>=now() and v_removed is not null then raise exception 'Removed patient cannot receive future work' using errcode='23503';end if;
 end if;return new;end $$;
create trigger retention_appointment_client_guard before insert or update on public.appointments for each row execute function public.retention_appointment_client_guard();

-- Replay/webhook enforcement is separate from cleanup audit. No effect before tombstones exist.
create function public.retention_conversation_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from public.retention_deletion_ledger l where l.durable_at is not null and l.clinic_id=new.clinic_id and (
 (l.resource_table='clinics' and l.action='offboard') or
 (l.resource_table='retell_call' and l.resource_key=new.retell_call_id and l.action='delete') or
 (l.resource_table='conversations' and l.resource_key=new.id::text and l.action='delete'))) then
 return null;end if;
 if exists(select 1 from public.retention_deletion_ledger l where l.durable_at is not null and l.clinic_id=new.clinic_id and (
 (l.resource_table='retell_call' and l.resource_key=new.retell_call_id) or
 (l.resource_table='conversations' and l.resource_key=new.id::text and l.action='clear_content'))) then
 new.transcript=null;new.summary=null;new.caller_phone=null;new.recording_url=null;new.title='Call content removed';
 end if;return new;end $$;
create trigger retention_conversation_guard before insert or update on public.conversations for each row execute function public.retention_conversation_guard();

create function public.retention_run_clinic(p_clinic uuid,p_dry_run boolean default true,p_batch integer default 100)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_mode text; v_run uuid:=gen_random_uuid(); v_category text; v_count integer; v_result jsonb:='{}'; r record; v_call text;v_agent text;v_auth uuid;begin
 if p_batch not between 1 and 500 or p_clinic is null or not exists(select 1 from public.clinics where id=p_clinic) then raise exception 'Invalid retention scope' using errcode='22023';end if;
 select mode into v_mode from public.retention_control where singleton;
 if v_mode='disabled' then return jsonb_build_object('state','disabled');end if;
 if exists(select 1 from public.clinic_retention where clinic_id=p_clinic and (paused or legal_hold)) then return jsonb_build_object('state','held');end if;
 if not pg_try_advisory_xact_lock(hashtextextended('retention:'||p_clinic::text,0)) then return jsonb_build_object('state','busy');end if;
 v_mode:=case when p_dry_run or v_mode<>'enabled' then 'dry_run' else 'enabled' end;
 for v_category in select distinct category from public.retention_candidates where clinic_id=p_clinic order by category loop
 v_count:=0;
 begin
 for r in select * from public.retention_candidates where clinic_id=p_clinic and category=v_category order by age_clock,resource_key limit p_batch loop
 if v_mode='enabled' then
 -- Exact table/key whitelist comes from our internal view, never HTTP input.
 if r.resource_table not in ('staff','staff_time_off','retention_provider_jobs','conversations','voice_requests','appointments','client_notes','clients','voice_operations','voice_checked_slots','voice_call_state','notifications','profiles','clinic_invitation_claims') then raise exception 'Invalid retention category';end if;
 execute format('select 1 from public.%I where clinic_id=$1 and %I::text=$2 for update',r.resource_table,
 case r.resource_table when 'voice_operations' then 'operation_key' when 'voice_call_state' then 'call_id' when 'clinic_invitation_claims' then 'email' else 'id' end) using p_clinic,r.resource_key;
 if not exists(select 1 from public.retention_candidates where clinic_id=p_clinic and category=v_category and resource_key=r.resource_key) then continue;end if;
 -- Commit erasure intent first; external encrypted custody must ACK it on a later run.
 if v_category not in ('invitation','provider_receipt','retell_call','revoked_user') then
 perform public.retention_record(p_clinic,r.resource_table,r.resource_key,case v_category when 'call_content' then 'clear_content' when 'client_contact' then 'anonymize' when 'staff_contact' then 'clear_content' else 'delete' end);
 if not exists(select 1 from public.retention_deletion_ledger l where l.clinic_id=p_clinic and l.resource_table=r.resource_table and l.resource_key=r.resource_key
 and l.action=case v_category when 'call_content' then 'clear_content' when 'client_contact' then 'anonymize' when 'staff_contact' then 'clear_content' else 'delete' end and l.durable_at is not null) then continue;end if;
 end if;
 case v_category
 when 'call_content' then
  select retell_call_id,retell_agent_id into v_call,v_agent from public.conversations where clinic_id=p_clinic and id=r.resource_key::uuid;
  perform public.retention_queue_call(p_clinic,v_call,v_agent);
  perform public.retention_record(p_clinic,'conversations',r.resource_key,'clear_content');
  update public.conversations set transcript=null,summary=null,caller_phone=null,recording_url=null,title='Call content removed' where clinic_id=p_clinic and id=r.resource_key::uuid;
 when 'retell_call' then
  select retell_call_id,retell_agent_id into v_call,v_agent from public.conversations where clinic_id=p_clinic and id=r.resource_key::uuid;
  perform public.retention_queue_call(p_clinic,v_call,v_agent);
 when 'revoked_user' then
  select auth_user_id into v_auth from public.profiles where clinic_id=p_clinic and id=r.resource_key::uuid;
  perform public.retention_record(p_clinic,'auth.users',v_auth::text,'delete');
  insert into public.retention_provider_jobs(clinic_id,provider,target_key) values(p_clinic,'supabase_auth',v_auth::text) on conflict do nothing;
 when 'client_contact' then
  perform public.retention_record(p_clinic,'clients',r.resource_key,'anonymize');
  update public.clients set full_name='Removed patient',phone='',email=null,notes=null,anonymized_at=now() where clinic_id=p_clinic and id=r.resource_key::uuid;
 when 'staff_contact' then
  perform public.retention_record(p_clinic,'staff',r.resource_key,'clear_content');
  update public.staff set phone=null,email=null where clinic_id=p_clinic and id=r.resource_key::uuid;
 else
  if v_category not in ('invitation','provider_receipt') then perform public.retention_record(p_clinic,r.resource_table,r.resource_key,'delete');end if;
  execute format('delete from public.%I where clinic_id=$1 and %I::text=$2',r.resource_table,
  case r.resource_table when 'voice_operations' then 'operation_key' when 'voice_call_state' then 'call_id' when 'clinic_invitation_claims' then 'email' else 'id' end) using p_clinic,r.resource_key;
 end case;
 end if;
 v_count:=v_count+1;
 end loop;
 insert into public.retention_runs(id,clinic_id,category,mode,processed,state) values(gen_random_uuid(),p_clinic,v_category,v_mode,v_count,'success');
 v_result:=v_result||jsonb_build_object(v_category,jsonb_build_object('processed',v_count,'state','success'));
 exception when others then
 -- Entire category subtransaction rolls back, including tombstones and outbox.
 insert into public.retention_runs(clinic_id,category,mode,processed,state,failure_category) values(p_clinic,v_category,v_mode,0,'failure','database_error');
 v_result:=v_result||jsonb_build_object(v_category,jsonb_build_object('processed',0,'state','failure','failure_category','database_error'));
 end;
 end loop;
 insert into public.retention_runs(id,clinic_id,category,mode,processed,state) values(v_run,p_clinic,'run',v_mode,0,
 case when exists(select 1 from jsonb_each(v_result) x where x.value->>'state'='failure') then 'failure' else 'success' end);
 if v_mode='enabled' then delete from public.retention_runs where clinic_id=p_clinic and started_at<now()-make_interval(days=>public.retention_days(p_clinic,'audit_days'));end if;
 return jsonb_build_object('run_id',v_run,'clinic_id',p_clinic,'mode',v_mode,'categories',v_result);
end $$;

create function public.retention_daily() returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c uuid;begin
 for c in select cl.id from public.clinics cl
 where not exists(select 1 from public.clinic_retention cr where cr.clinic_id=cl.id and (cr.paused or cr.legal_hold))
 order by coalesce((select max(started_at) from public.retention_runs where clinic_id=cl.id and category='run'),'-infinity'::timestamptz),cl.id limit 100
 loop perform public.retention_run_clinic(c,false,100);end loop;
end $$;

-- Tenant-checked lease; no provider request is permitted in dry_run/disabled mode.
create function public.retention_claim(p_clinic uuid,p_batch integer default 20) returns setof public.retention_provider_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_batch not between 1 and 50 then raise exception 'Invalid batch';end if;
 if not exists(select 1 from public.retention_control where singleton and mode='enabled' and approved_at is not null)
 or exists(select 1 from public.clinic_retention where clinic_id=p_clinic and (paused or legal_hold)) then return;end if;
 return query with selected as (select j.id from public.retention_provider_jobs j where j.clinic_id=p_clinic and j.state<>'succeeded' and j.next_attempt_at<=now() and (j.lease_until is null or j.lease_until<now())
 and exists(select 1 from public.retention_deletion_ledger l where l.clinic_id=p_clinic and l.resource_table=case j.provider when 'retell' then 'retell_call' else 'auth.users' end and l.resource_key=j.target_key and l.durable_at is not null)
 order by j.next_attempt_at,j.id limit p_batch for update skip locked)
 update public.retention_provider_jobs j set state='leased',lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempts=j.attempts+1 from selected where j.id=selected.id returning j.*;
end $$;
create function public.retention_finish(p_clinic uuid,p_job uuid,p_lease uuid,p_success boolean,p_failure text default 'provider_error') returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.retention_provider_jobs;begin
 select * into j from public.retention_provider_jobs where clinic_id=p_clinic and id=p_job and state='leased' and lease_token=p_lease and lease_until>now() for update;
 if not found then return false;end if;
 if p_failure not in ('provider_error','database_error','configuration_error') then raise exception 'Invalid failure category';end if;
 update public.retention_provider_jobs set state=case when p_success then 'succeeded' else 'pending' end,
 completed_at=case when p_success then now() else null end,
 next_attempt_at=now()+make_interval(secs=>least(86400,60*power(2,least(j.attempts,10)))::integer),
 failure_category=case when p_success then null else p_failure end,lease_token=null,lease_until=null where id=p_job and clinic_id=p_clinic;
 if p_success then perform public.retention_record(p_clinic,case j.provider when 'retell' then 'retell_call' else 'auth.users' end,j.target_key,'delete');end if;
 insert into public.retention_runs(clinic_id,category,mode,processed,state,failure_category) values(p_clinic,'provider_'||j.provider,'enabled',case when p_success then 1 else 0 end,case when p_success then 'success' else 'failure' end,case when p_success then null else p_failure end);
 return true;end $$;

-- Explicit operator-only manual erasure. Future work and ambiguous unresolved work block it.
create function public.retention_erase_client(p_clinic uuid,p_client uuid,p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
 declare c public.clients;cv record;v_count integer;begin
 perform pg_advisory_xact_lock(hashtextextended('retention:'||p_clinic::text,0));
 select * into c from public.clients where clinic_id=p_clinic and id=p_client for update;
 if not found then raise exception 'Invalid patient scope';end if;
 if c.phone<>'' and exists(select 1 from public.clients other where other.clinic_id=p_clinic and other.id<>p_client
 and regexp_replace(other.phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g')) then raise exception 'Ambiguous shared contact; review scope';end if;
 if public.retention_client_protected(p_clinic,p_client) then raise exception 'Patient has active work; resolve before deletion' using errcode='23503';end if;
 select count(*) into v_count from public.conversations where clinic_id=p_clinic and (client_id=p_client or (c.phone<>'' and regexp_replace(caller_phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g')));
 if v_count>500 then raise exception 'Manual erasure requires staged review';end if;
 if p_dry_run then return jsonb_build_object('mode','dry_run','clients',1,'calls',v_count);end if;
 if not exists(select 1 from public.retention_control where singleton and mode='enabled' and approved_at is not null) then raise exception 'Retention approval required';end if;
 perform public.retention_record(p_clinic,'clients',p_client::text,'anonymize');
 for cv in select id from public.conversations where clinic_id=p_clinic and (client_id=p_client or (c.phone<>'' and regexp_replace(caller_phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g'))) loop
 perform public.retention_record(p_clinic,'conversations',cv.id::text,'clear_content');end loop;
 perform public.retention_record(p_clinic,'client_notes',n.id::text,'delete') from public.client_notes n where n.clinic_id=p_clinic and n.client_id=p_client;
 perform public.retention_record(p_clinic,'appointments',n.id::text,'clear_content') from public.appointments n where n.clinic_id=p_clinic and n.client_id=p_client and n.end_time<now();
 perform public.retention_record(p_clinic,'voice_requests',n.id::text,'delete') from public.voice_requests n where n.clinic_id=p_clinic and n.status='Closed' and c.phone<>'' and regexp_replace(n.phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g');
 perform public.retention_record(p_clinic,'voice_operations',n.operation_key,'delete') from public.voice_operations n where n.clinic_id=p_clinic and (n.call_id in (select retell_call_id from public.conversations where clinic_id=p_clinic and client_id=p_client) or (c.phone<>'' and regexp_replace(n.caller_phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g')));
 if exists(select 1 from public.retention_deletion_ledger where clinic_id=p_clinic and durable_at is null) then
 return jsonb_build_object('mode','awaiting_durable_ledger','clients',1,'calls',v_count);end if;
 for cv in select * from public.conversations where clinic_id=p_clinic and (client_id=p_client or (c.phone<>'' and regexp_replace(caller_phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g'))) for update loop
 perform public.retention_queue_call(p_clinic,cv.retell_call_id,cv.retell_agent_id);
 perform public.retention_record(p_clinic,'conversations',cv.id::text,'clear_content');
 update public.conversations set transcript=null,summary=null,caller_phone=null,recording_url=null,title='Call content removed' where clinic_id=p_clinic and id=cv.id;
 end loop;
 -- Existing Requests have no patient FK: matching scope must be reviewed by the operator first.
 delete from public.voice_requests where clinic_id=p_clinic and status='Closed' and c.phone<>'' and regexp_replace(phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g');
 perform public.retention_record(p_clinic,'client_notes',n.id::text,'delete') from public.client_notes n where n.clinic_id=p_clinic and n.client_id=p_client;
 delete from public.client_notes where clinic_id=p_clinic and client_id=p_client;
 perform public.retention_record(p_clinic,'appointments',a.id::text,'clear_content') from public.appointments a where a.clinic_id=p_clinic and a.client_id=p_client and a.end_time<now();
 update public.appointments set notes=null where clinic_id=p_clinic and client_id=p_client and end_time<now();
 delete from public.voice_operations where clinic_id=p_clinic and (call_id in (select retell_call_id from public.conversations where clinic_id=p_clinic and client_id=p_client) or (c.phone<>'' and regexp_replace(caller_phone,'[^0-9]','','g')=regexp_replace(c.phone,'[^0-9]','','g')));
 perform public.retention_record(p_clinic,'clients',p_client::text,'anonymize');
 update public.clients set full_name='Removed patient',phone='',email=null,notes=null,anonymized_at=now() where clinic_id=p_clinic and id=p_client;
 return jsonb_build_object('mode','enabled','clients',1,'calls',v_count,'provider_deletion','pending');
end $$;

-- Safe mechanism: execution requires separately approved global enabled mode.
create function public.retention_begin_offboarding(p_clinic uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if not exists(select 1 from public.retention_control where singleton and mode='enabled' and approved_at is not null) then raise exception 'Retention approval required';end if;
 if not exists(select 1 from public.clinics where id=p_clinic) then raise exception 'Invalid clinic scope';end if;
 perform pg_advisory_xact_lock(hashtextextended('retention:'||p_clinic::text,0));
 insert into public.clinic_offboarding(clinic_id,grace_until,state) values(p_clinic,now()+make_interval(days=>public.retention_days(p_clinic,'offboarding_grace_days')),'grace') on conflict do nothing;
 update public.voice_integrations set active=false where clinic_id=p_clinic;
 update public.profiles set revoked_at=coalesce(revoked_at,now()) where clinic_id=p_clinic;
end $$;

-- New internal tables and functions have no browser authority, including inherited ACLs.
alter table public.retention_control enable row level security;
revoke all on public.retention_control from public,anon,authenticated,service_role;
alter table public.clinic_retention enable row level security;
revoke all on public.clinic_retention from public,anon,authenticated,service_role;
alter table public.retention_runs enable row level security;
revoke all on public.retention_runs from public,anon,authenticated,service_role;
alter table public.retention_deletion_ledger enable row level security;
revoke all on public.retention_deletion_ledger from public,anon,authenticated,service_role;
alter table public.retention_provider_jobs enable row level security;
revoke all on public.retention_provider_jobs from public,anon,authenticated,service_role;
alter table public.clinic_offboarding enable row level security;
revoke all on public.clinic_offboarding from public,anon,authenticated,service_role;
grant select on public.retention_control,public.clinic_retention,public.retention_runs,public.retention_provider_jobs,public.clinic_offboarding to service_role;
revoke all on function public.retention_days(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.retention_validate_config() from public,anon,authenticated,service_role;
revoke all on function public.retention_closed_clock() from public,anon,authenticated,service_role;
revoke all on function public.retention_client_protected(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.retention_client_last_activity(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.retention_record(uuid,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.retention_queue_call(uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.retention_client_delete_guard() from public,anon,authenticated,service_role;
revoke all on function public.retention_conversation_guard() from public,anon,authenticated,service_role;
revoke all on function public.retention_run_clinic(uuid,boolean,integer) from public,anon,authenticated,service_role;
revoke all on function public.retention_daily() from public,anon,authenticated,service_role;
revoke all on function public.retention_claim(uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.retention_finish(uuid,uuid,uuid,boolean,text) from public,anon,authenticated,service_role;
revoke all on function public.retention_erase_client(uuid,uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.retention_begin_offboarding(uuid) from public,anon,authenticated,service_role;
grant execute on function public.retention_run_clinic(uuid,boolean,integer),public.retention_claim(uuid,integer),public.retention_finish(uuid,uuid,uuid,boolean,text) to service_role;
create index retention_jobs_due on public.retention_provider_jobs(clinic_id,next_attempt_at) where state<>'succeeded';
create index retention_ledger_lookup on public.retention_deletion_ledger(clinic_id,resource_table,resource_key);
create index retention_runs_recent on public.retention_runs(clinic_id,started_at);
revoke all on function public.retention_appointment_client_guard() from public,anon,authenticated,service_role;
revoke all on function public.retention_removed_client_guard() from public,anon,authenticated,service_role;
revoke all on function public.retention_activity_clock() from public,anon,authenticated,service_role;
revoke all on function public.retention_staff_clock() from public,anon,authenticated,service_role;
commit;
