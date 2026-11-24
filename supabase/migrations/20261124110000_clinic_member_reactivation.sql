-- Additive, local proposal: explicit Owner restoration of verified non-owner
-- accounts. No Auth credentials, invitation tokens or historical records change.
begin;
create table public.clinic_membership_audit (
  id uuid primary key default gen_random_uuid(),
  -- Immutable identifier survives authorized clinic erasure; no blocking FK.
  clinic_id uuid not null,
  actor_profile_id uuid,
  target_profile_id uuid not null,
  previous_role public.profile_role not null,
  next_role public.profile_role not null,
  previous_revoked_at timestamptz,
  next_revoked_at timestamptz,
  occurred_at timestamptz not null default clock_timestamp()
);
alter table public.clinic_membership_audit enable row level security;
revoke all on public.clinic_membership_audit from public,anon,authenticated,service_role;
grant select on public.clinic_membership_audit to authenticated,service_role;
create policy "owner reads membership audit" on public.clinic_membership_audit
  for select to authenticated using (
    clinic_id=public.current_clinic_id() and public.current_profile_role()='owner'
  );

create or replace function public.guard_profile_sensitive_fields()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp
as $$ begin
  -- Preserve the existing narrow retention maintenance exception. SECURITY
  -- INVOKER is essential: definer execution would disguise a browser as owner.
  if auth.uid() is null and coalesce(auth.jwt()->>'role','') = ''
     and current_user = (select pg_get_userbyid(relowner) from pg_class where oid='public.profiles'::regclass)
     and new.revoked_at is not null
     and (to_jsonb(new)-'revoked_at'-'updated_at') = (to_jsonb(old)-'revoked_at'-'updated_at') then
    return new;
  end if;
  if coalesce(auth.jwt()->>'role','')='service_role' then return new; end if;
  if new.clinic_id is distinct from old.clinic_id
     or new.auth_user_id is distinct from old.auth_user_id
     or new.email is distinct from old.email then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  if (new.role is distinct from old.role or new.revoked_at is distinct from old.revoked_at)
     and not coalesce((public.current_profile_role()='owner'
       and old.clinic_id=public.current_clinic_id()
       and old.auth_user_id<>auth.uid() and old.role<>'owner'
       and new.role in ('manager','staff')
       and ((old.revoked_at is null and (new.revoked_at is null or new.role=old.role))
         or (old.revoked_at is not null and new.revoked_at is null and new.role=old.role))),false) then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_profile_sensitive_fields() from public,anon,authenticated,service_role;
-- Restoring access is exposed only through the locked RPC, never column UPDATE.
revoke update(role,revoked_at) on public.profiles from public,anon,authenticated;

create function public.reactivate_clinic_member(p_profile_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$ declare actor public.profiles%rowtype; target public.profiles%rowtype; begin
  select * into actor from public.profiles where auth_user_id=auth.uid() for update;
  if actor.id is null or actor.role<>'owner' or actor.revoked_at is not null
     or actor.clinic_id is distinct from public.current_clinic_id() then
    raise exception 'Not authorized to restore account access' using errcode='42501';
  end if;
  select * into target from public.profiles
    where id=p_profile_id and clinic_id=actor.clinic_id for update;
  if target.id is null or target.role not in ('manager','staff')
     or target.auth_user_id=actor.auth_user_id or not exists (
       select 1 from auth.users u where u.id=target.auth_user_id
         and u.email_confirmed_at is not null and lower(u.email)=lower(target.email)
         and to_jsonb(u)->>'deleted_at' is null
         and coalesce((to_jsonb(u)->>'banned_until')::timestamptz<=now(),true)
     ) then
    raise exception 'Not authorized to restore account access' using errcode='42501';
  end if;
  update public.profiles set revoked_at=null where id=target.id and revoked_at is not null;
  return target.id;
end $$;
revoke all on function public.reactivate_clinic_member(uuid) from public,anon,authenticated,service_role;
grant execute on function public.reactivate_clinic_member(uuid) to authenticated;

create function public.audit_clinic_membership_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp
as $$ begin
  if new.role is distinct from old.role or new.revoked_at is distinct from old.revoked_at then
    insert into public.clinic_membership_audit(clinic_id,actor_profile_id,target_profile_id,
      previous_role,next_role,previous_revoked_at,next_revoked_at)
    values(old.clinic_id,public.current_profile_id(),old.id,old.role,new.role,old.revoked_at,new.revoked_at);
  end if;
  return new;
end $$;
revoke all on function public.audit_clinic_membership_change() from public,anon,authenticated,service_role;
create trigger audit_clinic_membership_change after update of role,revoked_at on public.profiles
  for each row execute function public.audit_clinic_membership_change();
notify pgrst, 'reload schema';
commit;
