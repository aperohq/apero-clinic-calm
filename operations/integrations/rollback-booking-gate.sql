-- RELEASE AUTHORIZATION REQUIRED. Use only as the reviewed incident rollback.
-- Disable new API/OAuth traffic and stop the worker scheduler first.
-- This restores the pre-integration booking predicate. It does NOT erase keys,
-- credentials, audit or outbox rows; new appointment changes continue to queue.
-- Reconcile outstanding Google conflicts before reopening clinic bookings.
begin;
drop trigger if exists a_integration_booking_lock on public.appointments;
create or replace function public.appointment_slot_open(
 p_clinic_id uuid,p_staff_id uuid,p_service text,p_start timestamptz,p_end timestamptz,p_exclude_id uuid default null
) returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
 select public.appointment_slot_open_without_calendars(p_clinic_id,p_staff_id,p_service,p_start,p_end,p_exclude_id)
$$;
revoke all on function public.appointment_slot_open(uuid,uuid,text,timestamptz,timestamptz,uuid) from public,anon;
grant execute on function public.appointment_slot_open(uuid,uuid,text,timestamptz,timestamptz,uuid) to authenticated,service_role;
commit;
-- Do not rerun the original CREATE TABLE migration to resume. Reapply only the
-- reviewed wrapper/locking trigger definitions from the release migration,
-- synchronize snapshots, then enable traffic and scheduling after validation.
