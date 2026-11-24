begin;
-- Existing clinics without intake records retain their access contract. Suspended
-- and closed clinics lose portal authorization immediately, even with old JWTs.
create or replace function public.current_clinic_id() returns uuid language sql stable security definer set search_path=pg_catalog,public as $$
 select p.clinic_id from public.profiles p join auth.users u on u.id=p.auth_user_id where p.auth_user_id=auth.uid() and p.revoked_at is null
 and (to_jsonb(u)->>'deleted_at') is null and coalesce((to_jsonb(u)->>'banned_until')::timestamptz,'-infinity'::timestamptz)<=now()
 and public.clinic_lifecycle_allows_access(p.clinic_id) limit 1 $$;
create or replace function public.current_profile_id() returns uuid language sql stable security definer set search_path=pg_catalog,public as $$
 select id from public.profiles where auth_user_id=auth.uid() and revoked_at is null and clinic_id=public.current_clinic_id() limit 1 $$;
create or replace function public.current_profile_role() returns public.profile_role language sql stable security definer set search_path=pg_catalog,public as $$
 select role from public.profiles where auth_user_id=auth.uid() and revoked_at is null and clinic_id=public.current_clinic_id() limit 1 $$;

-- Configuration alone cannot certify readiness if core database enforcement is
-- disabled or trusted provisioning becomes browser-callable. This is a catalog
-- admission check; deployment/UAT evidence remains a separate external gate.
create function public.clinic_security_contract() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare failures jsonb:='[]'; relation text; signature text;
begin
 foreach relation in array array['clinics','profiles','clients','staff','staff_availability','staff_time_off','appointments','conversations','client_notes','notifications','clinic_onboarding','clinic_onboarding_audit'] loop
 if not coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.'||relation)),false) then
 failures:=failures||jsonb_build_array('Database row security must be enabled for '||relation);end if;
 if has_table_privilege('anon','public.'||relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
 or has_any_column_privilege('anon','public.'||relation,'SELECT,INSERT,UPDATE') then
 failures:=failures||jsonb_build_array('Remove anonymous access to '||relation);end if;
 end loop;
 if has_table_privilege('authenticated','public.profiles','INSERT,DELETE,TRUNCATE')
 or has_column_privilege('authenticated','public.profiles','role','UPDATE')
 or has_column_privilege('authenticated','public.profiles','revoked_at','UPDATE')
 or not exists(select 1 from pg_trigger where tgrelid='public.profiles'::regclass
 and tgfoid='public.guard_profile_sensitive_fields()'::regprocedure and not tgisinternal and tgenabled in ('O','A')) then
 failures:=failures||jsonb_build_array('Restore protected membership mutation grants and trigger');end if;
 foreach relation in array array['clinic_onboarding','clinic_onboarding_audit'] loop
 if has_table_privilege('authenticated','public.'||relation,'INSERT,UPDATE,DELETE,TRUNCATE') then
 failures:=failures||jsonb_build_array('Remove direct browser lifecycle mutation privileges');end if;end loop;
 foreach signature in array array['public.provision_clinic(text,jsonb)','public.register_existing_clinic_intake(uuid,text,jsonb,text)','public.decide_clinic_lifecycle(uuid,text,text,text,boolean)'] loop
 if has_function_privilege('anon',signature,'EXECUTE') or has_function_privilege('authenticated',signature,'EXECUTE') then
 failures:=failures||jsonb_build_array('Restrict administrative provisioning and lifecycle RPC execution');end if;end loop;
 return failures;
end $$;
revoke all on function public.clinic_security_contract() from public,anon,authenticated,service_role;

create function public.clinic_activation_readiness(p_clinic_id uuid default null) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare cid uuid:=coalesce(p_clinic_id,public.current_clinic_id()); o public.clinic_onboarding; c public.clinics;
 errors jsonb:='[]'; stage text; item jsonb; live_payload jsonb; field text; fingerprint text; data_fingerprint text;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' and
 (public.current_profile_role() is distinct from 'owner' or cid is distinct from public.current_clinic_id()) then
 raise exception 'Owner access required' using errcode='42501';end if;
 errors:=public.clinic_security_contract();
 select * into c from public.clinics where id=cid;
 if c.id is null then raise exception 'Clinic unavailable' using errcode='22023';end if;
 select * into o from public.clinic_onboarding where clinic_id=cid;
 if o.clinic_id is null then errors:=errors||jsonb_build_array('Import and review onboarding information');
 else
 live_payload:=o.payload;
 for field in select jsonb_object_keys(o.payload->'clinic') loop
 live_payload:=jsonb_set(live_payload,array['clinic',field],coalesce(to_jsonb(c)->field,'null'::jsonb));end loop;
 begin perform public.validate_clinic_intake(live_payload);
 exception when others then errors:=errors||jsonb_build_array(SQLERRM);end;
 if o.synthetic then errors:=errors||jsonb_build_array('Synthetic clinic cannot activate; provision a separate real clinic');end if;
 for item in select value from jsonb_array_elements(o.payload->'services') loop
 if not exists(select 1 from public.staff s where s.clinic_id=cid and s.active and item->>'name'=any(s.services)
 and exists(select 1 from public.staff_availability a where a.staff_id=s.id and a.clinic_id=cid and a.is_available and a.end_time-a.start_time>=make_interval(mins=>(item->>'duration_minutes')::int))) then
 errors:=errors||jsonb_build_array('Configure an eligible scheduled practitioner for '||(item->>'name'));end if;end loop;
 if exists(select 1 from public.staff s,unnest(s.services) v where s.clinic_id=cid and s.active
 and not exists(select 1 from jsonb_array_elements(o.payload->'services') x where x->>'name'=v)) then
 errors:=errors||jsonb_build_array('Practitioner services differ from reviewed duration catalog');end if;
 data_fingerprint:=md5(jsonb_build_object('clients',(select coalesce(jsonb_agg(to_jsonb(clinical_client) order by clinical_client.id),'[]') from public.clients clinical_client where clinic_id=cid),
 'appointments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.appointments a where clinic_id=cid))::text);
 if o.lifecycle<>'activated' and o.data_review_fingerprint is distinct from data_fingerprint and (exists(select 1 from public.clients where clinic_id=cid) or exists(select 1 from public.appointments where clinic_id=cid)) then
 errors:=errors||jsonb_build_array('Existing clinical records require a reviewed synthetic-data cleanup assessment');end if;
 if exists(select 1 from public.staff_availability a join public.staff st on st.id=a.staff_id
 where st.clinic_id=cid and st.active and a.is_available and (a.clinic_id<>cid or not exists(
 select 1 from jsonb_array_elements(c.opening_hours->'days') d, jsonb_array_elements(d->'periods') p
 where (d->>'day')::int=a.day_of_week and (p->>'start')::time<=a.start_time and (p->>'end')::time>=a.end_time))) then
 errors:=errors||jsonb_build_array('Practitioner availability falls outside clinic operating hours');end if;
 if exists(select 1 from public.staff st, jsonb_array_elements_text(o.payload->'closures') d
 where st.clinic_id=cid and st.active and not exists(select 1 from public.staff_time_off t
 where t.staff_id=st.id and t.clinic_id=cid and t.start_time<=d::date::timestamp at time zone c.timezone
 and t.end_time>=(d::date+1)::timestamp at time zone c.timezone)) then
 errors:=errors||jsonb_build_array('Restore clinic closure time off for all active practitioners');end if;
 if not public.clinic_lifecycle_allows_access(cid) then errors:=errors||jsonb_build_array('Clinic access is suspended, closed or offboarding');end if;
 if o.lifecycle in ('suspended','closed') then errors:=errors||jsonb_build_array('Clinic is '||o.lifecycle);end if;
 end if;
 if (select count(*) from public.profiles p join auth.users u on u.id=p.auth_user_id where p.clinic_id=cid and p.role='owner' and p.revoked_at is null and (to_jsonb(u)->>'deleted_at') is null and coalesce((to_jsonb(u)->>'banned_until')::timestamptz,'-infinity'::timestamptz)<=now())<>1 then errors:=errors||jsonb_build_array('Assign exactly one active owner');end if;
 if exists(select 1 from public.staff where clinic_id=cid and active and (length(btrim(full_name))=0 or length(btrim(specialty))=0))
 or exists(select 1 from public.profiles where clinic_id=cid and role='owner' and revoked_at is null and length(btrim(full_name))=0) then
 errors:=errors||jsonb_build_array('Complete active practitioner names, specialties and owner name');end if;
 if exists(select 1 from public.profiles p join auth.users u on u.id=p.auth_user_id where p.clinic_id=cid and p.revoked_at is null and u.email_confirmed_at is null) then errors:=errors||jsonb_build_array('Confirm pending team accounts or revoke unused invitations');end if;
 fingerprint:=md5(jsonb_build_object('clinic',to_jsonb(c),'intake',o.payload,
 'reviewed_data',data_fingerprint,'staff',(select coalesce(jsonb_agg(to_jsonb(s) order by s.id),'[]') from public.staff s where clinic_id=cid),
 'availability',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.staff_availability a where clinic_id=cid),
 'time_off',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') from public.staff_time_off t where clinic_id=cid),
 'members',(select coalesce(jsonb_agg(jsonb_build_array(p.id,p.role,p.revoked_at,u.email_confirmed_at,to_jsonb(u)->'banned_until',to_jsonb(u)->'deleted_at') order by p.id),'[]') from public.profiles p join auth.users u on u.id=p.auth_user_id where p.clinic_id=cid))::text);
 stage:=case when o.lifecycle='activated' then 'activated'
 when o.clinic_id is null or jsonb_array_length(errors)>0 then 'onboarding_incomplete'
 when o.review_fingerprint is distinct from fingerprint or o.consent_revision is null then 'configuration_complete'
 when o.external_review_started_at is null then 'technically_activation_ready'
 else 'awaiting_external_dependencies' end;
 return jsonb_build_object('clinic_id',cid,'state',stage,'configuration_complete',jsonb_array_length(errors)=0,
 'review_fingerprint',fingerprint,'failures',errors,'consent_revision',o.consent_revision,'activated_at',o.activated_at,
 'external_dependencies',jsonb_build_array(
 jsonb_build_object('name','Retell and live telephone readiness','status','EXTERNAL / UNKNOWN'),
 jsonb_build_object('name','Integration and owner MFA deployment verification','status','EXTERNAL / UNKNOWN'),
 jsonb_build_object('name','Service-duration compatibility with the existing scheduler','status','EXTERNAL / UNKNOWN'),
 jsonb_build_object('name','Clinic representative UAT and release approval','status','EXTERNAL / UNKNOWN')));
end $$;
revoke all on function public.clinic_activation_readiness(uuid) from public,anon;
grant execute on function public.clinic_activation_readiness(uuid) to authenticated,service_role;

create function public.decide_clinic_lifecycle(p_clinic_id uuid,p_action text,p_reason text,p_consent_revision text default null,p_external_approved boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare o public.clinic_onboarding; readiness jsonb; ev text;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Trusted lifecycle decision required' using errcode='42501';end if;
 if p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'Review reason required' using errcode='22023';end if;
 -- Same serialization order as settings/member management: profiles then clinic.
 perform 1 from public.profiles where clinic_id=p_clinic_id order by (role<>'owner'),id for update;
 perform 1 from public.clinics where id=p_clinic_id for update;
 select * into o from public.clinic_onboarding where clinic_id=p_clinic_id for update;
 if o.clinic_id is null or o.lifecycle='closed' then raise exception 'Clinic is unavailable or closed' using errcode='22023';end if;
 if p_action='review_data' then
 update public.clinic_onboarding set data_reviewed_at=now(),data_review_fingerprint=md5(jsonb_build_object(
 'clients',(select coalesce(jsonb_agg(to_jsonb(clinical_client) order by clinical_client.id),'[]') from public.clients clinical_client where clinic_id=p_clinic_id),
 'appointments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.appointments a where clinic_id=p_clinic_id))::text),review_fingerprint=null,external_review_started_at=null where clinic_id=p_clinic_id;ev:='data_reviewed';
 elsif p_action in ('review_technical','await_external') then
 readiness:=public.clinic_activation_readiness(p_clinic_id);
 if not (readiness->>'configuration_complete')::boolean or p_consent_revision is null or length(btrim(p_consent_revision)) not between 1 and 200 then raise exception 'Complete configuration and consent required' using errcode='22023';end if;
 if p_action='await_external' and o.review_fingerprint is distinct from readiness->>'review_fingerprint' then raise exception 'Fresh technical review required' using errcode='22023';end if;
 update public.clinic_onboarding set consent_revision=p_consent_revision,review_fingerprint=readiness->>'review_fingerprint',external_review_started_at=case when p_action='await_external' then now() else null end where clinic_id=p_clinic_id;
 ev:=case when p_action='await_external' then 'external_review_requested' else 'technical_reviewed' end;
 elsif p_action='activate' then
 readiness:=public.clinic_activation_readiness(p_clinic_id);
 if o.review_fingerprint is distinct from readiness->>'review_fingerprint' or o.consent_revision is distinct from p_consent_revision
 or not (readiness->>'configuration_complete')::boolean or p_external_approved is distinct from true
 or p_consent_revision is null or length(btrim(p_consent_revision)) not between 1 and 200 then
 raise exception 'Configuration, consent and explicit external release approval required' using errcode='22023';end if;
 update public.clinic_onboarding set lifecycle='activated',consent_revision=p_consent_revision,external_approved_at=now(),activated_at=coalesce(activated_at,now()) where clinic_id=p_clinic_id;
 ev:='activated';
 elsif p_action='suspend' then update public.clinic_onboarding set lifecycle='suspended' where clinic_id=p_clinic_id;ev:='suspended';
 elsif p_action='reactivate' and o.lifecycle='suspended' then
 -- Reactivation restores configuration access only; paying activation requires a new decision.
 update public.clinic_onboarding set lifecycle='configuration',external_approved_at=null,activated_at=null,review_fingerprint=null,external_review_started_at=null where clinic_id=p_clinic_id;ev:='reactivated';
 elsif p_action='close' then update public.clinic_onboarding set lifecycle='closed' where clinic_id=p_clinic_id;ev:='closed';
 else raise exception 'Invalid lifecycle transition' using errcode='22023';end if;
 insert into public.clinic_onboarding_audit(clinic_id,event,reason) values(p_clinic_id,ev,btrim(p_reason));
end $$;
revoke all on function public.decide_clinic_lifecycle(uuid,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.decide_clinic_lifecycle(uuid,text,text,text,boolean) to service_role;
-- Scheduling/configuration edits share the clinic lock used by release decisions.
create function public.lock_clinic_configuration() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare cid uuid; actor public.profiles%rowtype;
begin
 if tg_op='UPDATE' and new.clinic_id is distinct from old.clinic_id then
 raise exception 'Cannot move configuration across clinics' using errcode='42501';end if;
 cid:=case when tg_op='DELETE' then old.clinic_id else new.clinic_id end;
 -- Lock membership before clinic, consistently with suspension/member RPCs.
 -- Re-read after waiting; do not trust a stale outer statement's RLS snapshot.
 if coalesce(auth.jwt()->>'role','')='authenticated' then
 select * into actor from public.profiles where auth_user_id=auth.uid() and clinic_id=cid and revoked_at is null for share;
 if actor.id is null or
 (tg_table_name in ('staff','staff_availability','staff_time_off') and actor.role not in ('owner','manager')) or
 (tg_table_name='clients' and tg_op in ('INSERT','DELETE') and actor.role not in ('owner','manager')) or
 (tg_table_name='appointments' and tg_op='DELETE' and actor.role not in ('owner','manager')) then
 raise exception 'Current membership is not authorized' using errcode='42501';end if;
 end if;
 perform 1 from public.clinics where id=cid for share;
 if coalesce(auth.jwt()->>'role','')='authenticated' and
 (not public.clinic_lifecycle_allows_access(cid)
 or not exists(select 1 from auth.users u where u.id=actor.auth_user_id and (to_jsonb(u)->>'deleted_at') is null
 and coalesce((to_jsonb(u)->>'banned_until')::timestamptz,'-infinity'::timestamptz)<=now())) then
 raise exception 'Clinic or account access is inactive' using errcode='42501';end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function public.lock_clinic_configuration() from public,anon,authenticated,service_role;
create trigger onboarding_configuration_lock before insert or update or delete on public.staff for each row execute function public.lock_clinic_configuration();
create trigger onboarding_configuration_lock before insert or update or delete on public.staff_availability for each row execute function public.lock_clinic_configuration();
create trigger onboarding_configuration_lock before insert or update or delete on public.staff_time_off for each row execute function public.lock_clinic_configuration();
create trigger onboarding_configuration_lock before insert or update or delete on public.clients for each row execute function public.lock_clinic_configuration();
create trigger onboarding_configuration_lock before insert or update or delete on public.appointments for each row execute function public.lock_clinic_configuration();
notify pgrst,'reload schema';
commit;
