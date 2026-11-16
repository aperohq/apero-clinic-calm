-- Unblock trusted backend paths that the identity guards rejected because they run
-- without a request JWT (GoTrue user deletion, administrator-run retention).
begin;

-- 1. Deleting an Auth user cascades auth.users -> profiles -> client_notes
--    (author_profile_id ON DELETE SET NULL). That cascade has no JWT, so the
--    immutability guard rejected it and the user could never be deleted.
--    Allow exactly that change: author cleared, clinic/client untouched, and
--    the former author profile no longer exists. Browsers cannot produce it.
create or replace function public.guard_client_notes_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_profile_id is null and old.author_profile_id is not null
     and new.clinic_id is not distinct from old.clinic_id
     and new.client_id is not distinct from old.client_id
     and not exists (select 1 from public.profiles where id = old.author_profile_id) then
    return new;
  end if;
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (new.author_profile_id is distinct from old.author_profile_id
          or new.clinic_id is distinct from old.clinic_id
          or new.client_id is distinct from old.client_id) then
    raise exception 'author, clinic and client of a note cannot be changed';
  end if;
  return new;
end $$;

-- 2. retention_begin_offboarding / retention_replay_ledger revoke profiles, but
--    they are callable only by administrators (no JWT), so the profile guard
--    rejected the revocation. Those two functions now run with a function-scoped
--    flag (Postgres restores it on exit); while set, the guard permits only a
--    pure revocation. Browser roles also lack UPDATE on revoked_at.
create or replace function public.guard_profile_sensitive_fields()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then return new; end if;
  if new.clinic_id is distinct from old.clinic_id
     or new.auth_user_id is distinct from old.auth_user_id
     or new.email is distinct from old.email then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  if coalesce(current_setting('apero.retention_revocation', true), '') = 'on'
     and new.role is not distinct from old.role
     and old.revoked_at is null and new.revoked_at is not null then
    return new;
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

alter function public.retention_begin_offboarding(uuid) set apero.retention_revocation = 'on';
alter function public.retention_replay_ledger(uuid) set apero.retention_revocation = 'on';

commit;
