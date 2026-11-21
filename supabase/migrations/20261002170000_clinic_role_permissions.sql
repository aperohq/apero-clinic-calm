-- Reuse owner/manager/staff and existing role-aware RLS. No product data is
-- rewritten. Browser role/identity column grants remain unchanged.
begin;

do $$ begin
  if not exists (select 1 from pg_class where oid = 'public.profiles'::regclass and relrowsecurity)
     or not exists (select 1 from pg_trigger
       where tgrelid = 'public.profiles'::regclass
         and tgname = 'guard_profile_sensitive_fields' and tgenabled in ('O','A')) then
    raise exception 'Apply the existing profile RLS and identity guard before role permissions';
  end if;
end $$;

-- Staff can load their own account, but account-directory details are for
-- owners/managers. Membership helpers already bypass RLS safely.
drop policy if exists "read clinic profiles" on public.profiles;
create policy "read clinic profiles" on public.profiles
  for select to authenticated
  using (clinic_id = public.current_clinic_id() and (
    auth_user_id = auth.uid() or public.current_profile_role() in ('owner', 'manager')
  ));

-- Retain immutable identity/membership/email and trusted backend behavior.
-- The only new exception is an owner assigning manager/staff to a non-owner
-- of their own clinic. Direct role UPDATE grants are NOT granted to browsers.
create or replace function public.guard_profile_sensitive_fields()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    return new;
  end if;
  if new.clinic_id is distinct from old.clinic_id
     or new.auth_user_id is distinct from old.auth_user_id
     or new.email is distinct from old.email then
    raise exception 'profile identity fields cannot be changed' using errcode = '42501';
  end if;
  if new.role is distinct from old.role and not coalesce((
    public.current_profile_role() = 'owner'
    and old.clinic_id = public.current_clinic_id()
    and old.auth_user_id <> auth.uid()
    and old.role <> 'owner' and new.role in ('manager', 'staff')
  ), false) then
    raise exception 'Not authorized to change account access' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_profile_sensitive_fields() from public, anon, authenticated;

create or replace function public.set_clinic_member_role(
  p_profile_id uuid, p_role public.profile_role
) returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles%rowtype;
  target public.profiles%rowtype;
begin
  -- Resolve and lock the caller's real membership, never a supplied clinic ID
  -- or JWT metadata role. Locking serializes concurrent backend role changes.
  select * into actor from public.profiles
    where auth_user_id = auth.uid() for update;
  if actor.id is null or actor.role <> 'owner'
     or p_role is null or p_role not in ('manager', 'staff') then
    raise exception 'Not authorized to change account access' using errcode = '42501';
  end if;
  select * into target from public.profiles
    where id = p_profile_id and clinic_id = actor.clinic_id for update;
  if target.id is null or target.role = 'owner'
     or target.auth_user_id = actor.auth_user_id then
    raise exception 'Not authorized to change account access' using errcode = '42501';
  end if;
  update public.profiles set role = p_role where id = target.id;
  return target.id;
end $$;
revoke all on function public.set_clinic_member_role(uuid,public.profile_role) from public, anon;
grant execute on function public.set_clinic_member_role(uuid,public.profile_role) to authenticated;

notify pgrst, 'reload schema';
commit;
