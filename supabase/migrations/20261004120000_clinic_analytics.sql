-- Read-only analytics; requires the existing Team membership/revocation model.
-- No policies, product rows or indexes are changed.
begin;
create or replace function public.clinic_analytics(
  p_clinic_id uuid, p_start_date date, p_end_date date
) returns jsonb
language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_clinic uuid := public.current_clinic_id();
  v_zone text;
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
begin
  if auth.uid() is null or v_clinic is null
     or p_clinic_id is distinct from v_clinic
     or not coalesce(public.current_profile_role() in ('owner','manager'), false)
     or not exists (select 1 from public.profiles where auth_user_id=auth.uid()
       and clinic_id=v_clinic and revoked_at is null) then
    raise exception 'Not authorized to view clinic analytics' using errcode='42501';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date
     or p_end_date - p_start_date > 89
     or p_start_date < date '2000-01-01' or p_end_date > date '2100-12-31' then
    raise exception 'Analytics range must contain 1 to 90 days' using errcode='22023';
  end if;
  select timezone into strict v_zone from public.clinics where id=v_clinic;
  if v_zone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name=v_zone) then
    raise exception 'Clinic timezone is unavailable' using errcode='22023';
  end if;
  v_start := p_start_date::timestamp at time zone v_zone;
  v_end := (p_end_date + 1)::timestamp at time zone v_zone;
  with calls as materialized (
    select (started_at at time zone v_zone)::date as day
    from public.conversations
    where clinic_id=v_clinic and started_at>=v_start and started_at<v_end
  ), visits as materialized (
    select (start_time at time zone v_zone)::date as day, status, staff_id, service
    from public.appointments
    where clinic_id=v_clinic and start_time>=v_start and start_time<v_end
  ), call_days as (select day,count(*) n from calls group by day),
  visit_days as (select day,count(*) n from visits group by day),
  days as (select p_start_date+i as day from generate_series(0,p_end_date-p_start_date) i),
  practitioners as (
    select v.staff_id as id, coalesce(s.full_name,'Unassigned') as label,count(*) n
    from visits v left join public.staff s on s.id=v.staff_id and s.clinic_id=v_clinic
    group by v.staff_id,s.full_name
  ), services as (select service as label,count(*) n from visits group by service),
  top_practitioners as (select * from practitioners order by n desc,id nulls last limit 20),
  top_services as (select * from services order by n desc,label limit 20)
  select jsonb_build_object(
    'timezone',v_zone,'startDate',p_start_date,'endDate',p_end_date,
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
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.clinic_analytics(uuid,date,date) from public, anon, service_role;
grant execute on function public.clinic_analytics(uuid,date,date) to authenticated;
notify pgrst, 'reload schema';
commit;
