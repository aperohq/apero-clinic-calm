begin;
-- FK SET NULL is permitted only after the referenced author has disappeared.
-- Ordinary reassignment/removal while the profile exists remains forbidden.
create or replace function public.guard_client_notes_immutable()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' and (
    new.clinic_id is distinct from old.clinic_id or
    new.client_id is distinct from old.client_id or
    (new.author_profile_id is distinct from old.author_profile_id and not (
      new.author_profile_id is null and old.author_profile_id is not null and
      not exists(select 1 from public.profiles where id=old.author_profile_id)
    ))
  ) then
    raise exception 'author, clinic and client of a note cannot be changed' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_client_notes_immutable() from public,anon,authenticated;
commit;
