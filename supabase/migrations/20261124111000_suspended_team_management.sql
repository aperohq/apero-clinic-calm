-- Existing account RPCs resolved actors directly, bypassing the tenant helper
-- when a clinic was suspended. Keep their reviewed logic behind a common guard.
begin;
create function public.assert_member_management_active(p_actor uuid,p_clinic uuid default null)
returns void language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare actor public.profiles%rowtype; cid uuid:=p_clinic;
begin
 if p_actor is not null then
   select * into actor from public.profiles where auth_user_id=p_actor for update;
   if actor.id is null or actor.role<>'owner' or actor.revoked_at is not null
      or not exists(select 1 from auth.users u where u.id=actor.auth_user_id
        and to_jsonb(u)->>'deleted_at' is null
        and coalesce((to_jsonb(u)->>'banned_until')::timestamptz<=now(),true)) then
     raise exception 'Not authorized' using errcode='42501';end if;
   cid:=actor.clinic_id;
 end if;
 -- Owner operations serialize through profiles; operator operations have no
 -- actor row. Both acquire the clinic lock before examining lifecycle state.
 perform 1 from public.clinics where id=cid for share;
 if not found then raise exception 'Not authorized' using errcode='42501';end if;
 if cid is null or not public.clinic_lifecycle_allows_access(cid) then
   raise exception 'Not authorized' using errcode='42501';end if;
end $$;
revoke all on function public.assert_member_management_active(uuid,uuid) from public,anon,authenticated,service_role;

alter function public.set_clinic_member_role(uuid,public.profile_role) rename to member_access_original_set_role;
revoke all on function public.member_access_original_set_role(uuid,public.profile_role) from public,anon,authenticated,service_role;
create function public.set_clinic_member_role(p_profile_id uuid,p_role public.profile_role)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin
 perform public.assert_member_management_active(auth.uid());
 return public.member_access_original_set_role(p_profile_id,p_role);
end $$;
revoke all on function public.set_clinic_member_role(uuid,public.profile_role) from public,anon,service_role;
grant execute on function public.set_clinic_member_role(uuid,public.profile_role) to authenticated;

alter function public.revoke_clinic_member(uuid) rename to member_access_original_revoke;
revoke all on function public.member_access_original_revoke(uuid) from public,anon,authenticated,service_role;
create function public.revoke_clinic_member(p_profile_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin
 perform public.assert_member_management_active(auth.uid());
 return public.member_access_original_revoke(p_profile_id);
end $$;
revoke all on function public.revoke_clinic_member(uuid) from public,anon,service_role;
grant execute on function public.revoke_clinic_member(uuid) to authenticated;

alter function public.owner_invite_clinic_member(uuid,uuid,text,text,public.profile_role) rename to member_access_original_invite;
revoke all on function public.member_access_original_invite(uuid,uuid,text,text,public.profile_role) from public,anon,authenticated,service_role;
create function public.owner_invite_clinic_member(p_actor_auth_id uuid,p_auth_user_id uuid,p_email text,p_full_name text,p_role public.profile_role)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Not authorized' using errcode='42501';end if;
 perform public.assert_member_management_active(p_actor_auth_id);
 return public.member_access_original_invite(p_actor_auth_id,p_auth_user_id,p_email,p_full_name,p_role);
end $$;
revoke all on function public.owner_invite_clinic_member(uuid,uuid,text,text,public.profile_role) from public,anon,authenticated;
grant execute on function public.owner_invite_clinic_member(uuid,uuid,text,text,public.profile_role) to service_role;

alter function public.owner_invite_email_available(uuid,text) rename to member_access_original_email_available;
revoke all on function public.member_access_original_email_available(uuid,text) from public,anon,authenticated,service_role;
create function public.owner_invite_email_available(p_actor_auth_id uuid,p_email text)
returns boolean language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$ begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Not authorized' using errcode='42501';end if;
 perform public.assert_member_management_active(p_actor_auth_id);
 return public.member_access_original_email_available(p_actor_auth_id,p_email);
end $$;
revoke all on function public.owner_invite_email_available(uuid,text) from public,anon,authenticated;
grant execute on function public.owner_invite_email_available(uuid,text) to service_role;

alter function public.reserve_clinic_invitation(uuid,uuid,text,text,uuid) rename to member_access_original_reserve;
revoke all on function public.member_access_original_reserve(uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;
create function public.reserve_clinic_invitation(p_actor_auth_id uuid,p_clinic_id uuid,p_email text,p_action text,p_profile_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp set lock_timeout='2s' as $$ begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Not authorized' using errcode='42501';end if;
 perform public.assert_member_management_active(p_actor_auth_id,p_clinic_id);
 return public.member_access_original_reserve(p_actor_auth_id,p_clinic_id,p_email,p_action,p_profile_id);
end $$;
revoke all on function public.reserve_clinic_invitation(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.reserve_clinic_invitation(uuid,uuid,text,text,uuid) to service_role;
notify pgrst,'reload schema';
commit;
