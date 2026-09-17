-- Follow-up to 03_voice_operations.sql: service_role needs table privileges
-- in addition to bypassing RLS. Grants are safe to run more than once.
begin;

grant select on public.voice_operations to service_role;
grant select, insert, update on public.voice_call_state to service_role;
grant insert on public.voice_checked_slots to service_role;
grant select, insert on public.voice_requests to service_role;

commit;
