-- Operator-only, read-only report. No patient names, phones, or notes.
-- Review every returned issue row before applying the migration. It never
-- cancels, deletes, normalizes statuses, repairs times, or changes membership.
begin transaction read only;
select status, count(*) as appointments from public.appointments group by status order by status;
-- These spellings are issues for review, not additional cancellation statuses.
select id as appointment_id, clinic_id, staff_id, status,
       'noncanonical cancellation status' as issue
from public.appointments
where lower(btrim(status)) in ('cancelled','canceled') and status <> 'Cancelled'
order by clinic_id,id;
select id as appointment_id, clinic_id, staff_id, status, start_time, end_time,
       case when start_time is null or end_time is null then 'missing interval'
            when not isfinite(start_time) or not isfinite(end_time) then 'non-finite interval'
            when end_time < start_time then 'reversed interval'
            else 'zero interval' end as issue,
       status <> 'Cancelled' and (start_time is null or end_time is null or
         not isfinite(start_time) or not isfinite(end_time) or end_time < start_time)
         as blocks_constraint_installation
from public.appointments
where start_time is null or end_time is null or not isfinite(start_time) or not isfinite(end_time)
   or end_time <= start_time
order by clinic_id,id;
-- Whole-minute slots cannot represent these legacy durations exactly.
select id as appointment_id, clinic_id, staff_id, status, start_time, end_time,
       extract(epoch from end_time-start_time) as duration_seconds,
       'unsupported reschedule duration; record is retained' as issue
from public.appointments
where isfinite(start_time) and isfinite(end_time) and end_time > start_time
  and (mod(extract(epoch from end_time-start_time),60) <> 0
       or extract(epoch from end_time-start_time) not between 60 and 86400)
order by clinic_id,id;
select a.clinic_id, a.staff_id as practitioner_id,
       a.id as appointment_a, b.id as appointment_b,
       a.start_time as start_a, a.end_time as end_a,
       b.start_time as start_b, b.end_time as end_b,
       a.status as status_a, b.status as status_b
from public.appointments a join public.appointments b
  on a.clinic_id=b.clinic_id and a.staff_id=b.staff_id and a.id < b.id
  and a.status <> 'Cancelled' and b.status <> 'Cancelled'
  and a.end_time > a.start_time and b.end_time > b.start_time
  and a.start_time < b.end_time and a.end_time > b.start_time
order by a.clinic_id,a.staff_id,a.id,b.id;
select c.id as clinic_id, c.timezone,
       exists(select 1 from pg_timezone_names z where z.name=c.timezone) as valid_timezone
from public.clinics c;
select conname, contype, convalidated, condeferrable, pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid='public.appointments'::regclass;
select i.indexrelid::regclass as index_name, am.amname, i.indisvalid, i.indisready,
       i.indisexclusion, pg_get_indexdef(i.indexrelid) as definition
from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am am on am.oid=c.relam
where i.indrelid='public.appointments'::regclass;
select extname, extversion from pg_extension where extname='btree_gist';
select a.id as appointment_id, a.clinic_id, a.client_id, a.staff_id,
       'cross-clinic or missing reference' as issue
from public.appointments a
left join public.clients c on c.id=a.client_id
left join public.staff s on s.id=a.staff_id
where (a.client_id is not null and c.clinic_id is distinct from a.clinic_id)
   or (a.staff_id is not null and s.clinic_id is distinct from a.clinic_id)
order by a.clinic_id,a.id;
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
where schemaname='public' and tablename in ('appointments','clients','staff','staff_availability','staff_time_off')
order by tablename,policyname;
select tgname, tgenabled, pg_get_triggerdef(oid) as definition from pg_trigger
where tgrelid='public.appointments'::regclass and not tgisinternal;
select p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as browser_execute,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
       has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
  ('voice_apply_appointment','appointment_available_slots','appointment_booking_minutes','appointment_slot_open');
rollback;
