-- Restrict legacy provider credentials without deleting rows or stored values.
-- Existing RLS and service-role privileges are unchanged.
begin;
do $$
declare columns_sql text;
begin
  if not coalesce((select relrowsecurity from pg_class
    where oid = 'public.conversations'::regclass), false) then
    raise exception 'Conversation RLS is required';
  end if;
  revoke select on public.conversations from public, anon, authenticated;
  select string_agg(quote_ident(attname), ', ' order by attnum) into columns_sql
    from pg_attribute where attrelid = 'public.conversations'::regclass
    and attnum > 0 and not attisdropped;
  execute format('revoke select (%s) on public.conversations from public, anon, authenticated', columns_sql);
end $$;
grant select (id, clinic_id, client_id, appointment_id, retell_call_id, retell_agent_id,
  title, status, outcome, caller_phone, started_at, duration_seconds, summary, transcript, created_at)
  on public.conversations to authenticated;
notify pgrst, 'reload schema';
commit;
