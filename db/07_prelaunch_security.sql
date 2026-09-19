-- Pre-launch authorization hardening. Review and apply separately.
-- Conversations are written by the signed Retell webhook through service_role;
-- the dashboard only reads them. Browser roles must not forge call records.
begin;

revoke insert, update, delete on public.conversations from authenticated;
drop policy if exists "conversations write" on public.conversations;

-- The profile email mirrors the Auth account. A browser may change its display
-- name and phone, but must not make this mirror disagree with auth.users.
create or replace function public.guard_profile_sensitive_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (new.clinic_id is distinct from old.clinic_id
          or new.role is distinct from old.role
          or new.auth_user_id is distinct from old.auth_user_id
          or new.email is distinct from old.email) then
    raise exception 'profile identity fields cannot be changed';
  end if;
  return new;
end $$;

revoke all on function public.guard_profile_sensitive_fields() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
