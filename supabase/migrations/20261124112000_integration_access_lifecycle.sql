-- Existing clinic-scoped credential controls only. No provider configuration,
-- credentials, worker jobs, external calls or scheduling behavior is changed.
begin;
create or replace function public.integration_owner() returns uuid
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare c uuid; begin
 select clinic_id into c from public.profiles where auth_user_id=auth.uid()
   and role='owner' and revoked_at is null for share;
 if c is null or c is distinct from public.current_clinic_id() then
   raise exception 'Not authorized' using errcode='42501';end if;
 return c;
end $$;
revoke all on function public.integration_owner() from public,anon,authenticated,service_role;
grant execute on function public.integration_owner() to authenticated;

create or replace function public.integration_authorize(p_hash text,p_scope text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare k public.integration_keys%rowtype; begin
 select * into k from public.integration_keys where key_hash=p_hash
   and revoked_at is null and expires_at>now() for update;
 if k.id is null or p_scope is null or not p_scope=any(k.scopes)
   or exists(select 1 from public.clinic_onboarding o where o.clinic_id=k.clinic_id and o.lifecycle<>'activated')
   or not public.clinic_lifecycle_allows_access(k.clinic_id) then return null;end if;
 if k.window_start>now()-interval '1 minute' and k.request_count>=60 then return jsonb_build_object('limited',true);end if;
 update public.integration_keys set last_used_at=now(),
   window_start=case when window_start>now()-interval '1 minute' then window_start else now() end,
   request_count=case when window_start>now()-interval '1 minute' then request_count+1 else 1 end where id=k.id;
 return jsonb_build_object('id',k.id,'clinic_id',k.clinic_id);
end $$;
revoke all on function public.integration_authorize(text,text) from public,anon,authenticated;
grant execute on function public.integration_authorize(text,text) to service_role;

-- Serialize mutation admission in the same clinic -> key order used by clinic
-- lifecycle decisions. A key-first mutation can otherwise deadlock suspension.
alter function public.integration_mutate(uuid,text,jsonb) rename to integration_mutate_locked_original;
revoke all on function public.integration_mutate_locked_original(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.integration_mutate(p_key uuid,p_request text,p_body jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare cid uuid; begin
 select clinic_id into cid from public.integration_keys where id=p_key;
 if cid is null then raise exception 'Not authorized' using errcode='42501';end if;
 perform 1 from public.clinics where id=cid for share;
 if not found then raise exception 'Not authorized' using errcode='42501';end if;
 -- Lock/recheck after clinic admission, so revocation cannot race the original
 -- mutation and a trusted concurrent key reassignment cannot switch clinics.
 perform 1 from public.integration_keys where id=p_key and clinic_id=cid
   and revoked_at is null and expires_at>now() for share;
 if not found or not public.clinic_lifecycle_allows_access(cid) or exists(select 1 from public.clinic_onboarding o
   where o.clinic_id=cid and o.lifecycle<>'activated') then
   raise exception 'Not authorized' using errcode='42501';end if;
 return public.integration_mutate_locked_original(p_key,p_request,p_body);
end $$;
revoke all on function public.integration_mutate(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.integration_mutate(uuid,text,jsonb) to service_role;

create function public.revoke_inactive_clinic_api_keys() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin
 if new.lifecycle in ('suspended','closed') then
   with revoked as (
     update public.integration_keys set revoked_at=clock_timestamp()
     where clinic_id=new.clinic_id and revoked_at is null returning id,clinic_id
   ) insert into public.integration_audit(clinic_id,actor_id,action,object_id)
     select clinic_id,auth.uid(),'key.clinic_'||new.lifecycle,id from revoked;
 end if;
 return new;
end $$;
revoke all on function public.revoke_inactive_clinic_api_keys() from public,anon,authenticated,service_role;
create trigger revoke_inactive_clinic_api_keys after insert or update of lifecycle on public.clinic_onboarding
 for each row execute function public.revoke_inactive_clinic_api_keys();
-- Migration recovery also secures keys predating this guard, with audit evidence.
with revoked as (
 update public.integration_keys k set revoked_at=clock_timestamp()
 where k.revoked_at is null and exists(select 1 from public.clinic_onboarding o where o.clinic_id=k.clinic_id and o.lifecycle in ('suspended','closed'))
 returning k.id,k.clinic_id
) insert into public.integration_audit(clinic_id,actor_id,action,object_id)
 select clinic_id,null,'key.inactive_clinic_migration',id from revoked;
notify pgrst,'reload schema';
commit;
