-- Test-only snapshot of the already-deployed prerequisite schema.
-- Apply after 01 through 09, after review. This does not modify product rows,
-- clinic membership, existing RLS policies, or service-role privileges.
-- GRANT is additive: legacy/default grants must be removed explicitly.
begin;

do $$
declare
  table_name text;
  columns_sql text;
begin
  foreach table_name in array array[
    'clinics', 'profiles', 'clients', 'staff', 'staff_availability',
    'staff_time_off', 'appointments', 'conversations', 'client_notes',
    'notifications', 'voice_requests', 'voice_operations', 'voice_call_state',
    'voice_checked_slots', 'voice_integrations', 'clinic_service_aliases'
  ] loop
    if not coalesce((select relrowsecurity from pg_class
      where oid = to_regclass(format('public.%I', table_name))), false) then
      raise exception 'Missing table or RLS on public.%; apply prerequisite schema first', table_name;
    end if;
    execute format('revoke all privileges on table public.%I from public, anon, authenticated', table_name);
    -- Table revocation does not remove existing column-level grants.
    select string_agg(quote_ident(attname), ', ' order by attnum) into columns_sql
      from pg_attribute where attrelid = to_regclass(format('public.%I', table_name))
      and attnum > 0 and not attisdropped;
    execute format('revoke all privileges (%s) on table public.%I from public, anon, authenticated', columns_sql, table_name);
  end loop;
end $$;

-- RLS remains the authorization boundary for every permitted operation.
grant select on public.clinics, public.profiles, public.conversations to authenticated;
grant update (name, logo_url, phone, email, timezone) on public.clinics to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
grant select, insert, update, delete on
  public.clients, public.staff, public.staff_availability,
  public.staff_time_off, public.appointments to authenticated;
grant select, insert, delete on public.client_notes, public.notifications to authenticated;
grant update (read) on public.notifications to authenticated;
grant select on public.voice_requests to authenticated;
grant update (status) on public.voice_requests to authenticated;

-- Voice-internal tables intentionally receive no browser grants or policies.
-- No browser role receives TRUNCATE, REFERENCES, or TRIGGER privileges.
-- Keep the membership helpers callable only by the roles that use them.
revoke all on function public.current_clinic_id(), public.current_profile_id(),
  public.current_profile_role() from public, anon;
grant execute on function public.current_clinic_id(), public.current_profile_id(),
  public.current_profile_role() to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
