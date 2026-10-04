-- Read-only reconciliation captured 2026-10-04. Historical fixed range.
-- No function creation, migration application, DML or persistent configuration.
begin transaction read only;
with proposed as (
with calls as materialized (
    select (started_at at time zone ('Asia/Kuwait'::text))::date as day
    from public.conversations
    where clinic_id=('11111111-1111-4111-8111-111111111111'::uuid) and started_at>=('2026-09-04T21:00:00Z'::timestamptz) and started_at<('2026-10-04T21:00:00Z'::timestamptz)
  ), visits as materialized (
    select (start_time at time zone ('Asia/Kuwait'::text))::date as day, status, staff_id, service
    from public.appointments
    where clinic_id=('11111111-1111-4111-8111-111111111111'::uuid) and start_time>=('2026-09-04T21:00:00Z'::timestamptz) and start_time<('2026-10-04T21:00:00Z'::timestamptz)
  ), call_days as (select day,count(*) n from calls group by day),
  visit_days as (select day,count(*) n from visits group by day),
  days as (select (date '2026-09-05')+i as day from generate_series(0,(date '2026-10-04')-(date '2026-09-05')) i),
  practitioners as (
    select v.staff_id as id, coalesce(s.full_name,'Unassigned') as label,count(*) n
    from visits v left join public.staff s on s.id=v.staff_id and s.clinic_id=('11111111-1111-4111-8111-111111111111'::uuid)
    group by v.staff_id,s.full_name
  ), services as (select service as label,count(*) n from visits group by service),
  top_practitioners as (select * from practitioners order by n desc,id nulls last limit 20),
  top_services as (select * from services order by n desc,label limit 20)
  select jsonb_build_object(
    'timezone',('Asia/Kuwait'::text),'startDate',(date '2026-09-05'),'endDate',(date '2026-10-04'),
    'totalCalls',(select count(*) from calls),
    'totalAppointments',(select count(*) from visits),
    'bookedAppointments',(select count(*) from visits where status='Booked'),
    'cancelledAppointments',(select count(*) from visits where status='Cancelled'),
    'otherAppointments',(select count(*) from visits where status not in ('Booked','Cancelled')),
    'trend',(select jsonb_agg(jsonb_build_object('date',d.day,'calls',coalesce(c.n,0),
      'appointments',coalesce(a.n,0)) order by d.day) from days d
      left join call_days c using(day) left join visit_days a using(day)),
    'practitioners',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'count',n)
      order by n desc,id nulls last) from top_practitioners),'[]'::jsonb),
    'otherPractitionerAppointments',(select coalesce(sum(n),0) from practitioners)-
      (select coalesce(sum(n),0) from top_practitioners),
    'services',coalesce((select jsonb_agg(jsonb_build_object('label',label,'count',n)
      order by n desc,label) from top_services),'[]'::jsonb),
    'otherServiceAppointments',(select coalesce(sum(n),0) from services)-
      (select coalesce(sum(n),0) from top_services)
  )
), raw as (
with c as (select started_at from public.conversations where clinic_id='11111111-1111-4111-8111-111111111111' and (started_at at time zone 'Asia/Kuwait')::date between date '2026-09-05' and date '2026-10-04'),
a as (select staff_id,service,status,start_time from public.appointments where clinic_id='11111111-1111-4111-8111-111111111111' and (start_time at time zone 'Asia/Kuwait')::date between date '2026-09-05' and date '2026-10-04')
select jsonb_build_object('timezone','Asia/Kuwait','startDate','2026-09-05','endDate','2026-10-04',
'totalCalls',(select count(*) from c),'totalAppointments',(select count(*) from a),
'bookedAppointments',(select count(*) from a where status='Booked'),'cancelledAppointments',(select count(*) from a where status='Cancelled'),
'otherAppointments',(select count(*) from a where status not in ('Booked','Cancelled')),
'practitioners',(select jsonb_agg(to_jsonb(t) order by count desc,id nulls last) from (select a.staff_id id,coalesce(s.full_name,'Unassigned') label,count(*) count from a left join public.staff s on s.id=a.staff_id and s.clinic_id='11111111-1111-4111-8111-111111111111' group by a.staff_id,s.full_name) t),
'services',(select jsonb_agg(to_jsonb(t) order by count desc,label) from (select service label,count(*) count from a group by service) t),
'otherServiceAppointments',0,'otherPractitionerAppointments',0,
'trend',(select jsonb_agg(jsonb_build_object('date',date '2026-09-05'+i,
'calls',(select count(*) from c where (started_at at time zone 'Asia/Kuwait')::date=date '2026-09-05'+i),
'appointments',(select count(*) from a where (start_time at time zone 'Asia/Kuwait')::date=date '2026-09-05'+i)) order by i) from generate_series(0,29)i)) as raw_metrics
)
select raw.raw_metrics as expected, proposed.jsonb_build_object as proposed,
 raw.raw_metrics = proposed.jsonb_build_object as identical
from raw cross join proposed;
commit;
