begin;
create or replace function public.guard_profile_sensitive_fields()
returns trigger language plpgsql security invoker set search_path = public, pg_temp
as $$
begin
  -- Only the database owner may revoke profiles from a sessionless maintenance
  -- function. Browser requests always carry authenticated claims; definer RPCs
  -- called by browsers therefore retain the existing membership checks.
  if auth.uid() is null and coalesce(auth.jwt()->>'role','') = ''
     and current_user = (select pg_get_userbyid(relowner) from pg_class where oid='public.profiles'::regclass)
     and new.revoked_at is not null
     and (to_jsonb(new)-'revoked_at'-'updated_at') = (to_jsonb(old)-'revoked_at'-'updated_at') then
    return new;
  end if;
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then return new; end if;
  if new.clinic_id is distinct from old.clinic_id
     or new.auth_user_id is distinct from old.auth_user_id
     or new.email is distinct from old.email then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  if (new.role is distinct from old.role or new.revoked_at is distinct from old.revoked_at)
    and not coalesce((public.current_profile_role() = 'owner'
      and old.clinic_id = public.current_clinic_id()
      and old.auth_user_id <> auth.uid() and old.role <> 'owner'
      and old.revoked_at is null and new.role in ('manager','staff')
      and (new.revoked_at is null or new.role = old.role)), false) then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_profile_sensitive_fields() from public, anon, authenticated;
commit;
