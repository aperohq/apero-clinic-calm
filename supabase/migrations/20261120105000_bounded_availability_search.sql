begin;
-- One network round trip, bounded days/practitioners, shared availability rules.
create function public.appointment_search_slots(
 p_clinic_id uuid, p_staff_ids uuid[], p_service text, p_date date,
 p_days integer default 1, p_window_start time default null,
 p_window_end time default null, p_exclude_id uuid default null, p_requested_time time default null
) returns table(staff_id uuid,start_time timestamptz,end_time timestamptz,duration_minutes integer)
language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare d integer; n integer; zone text;
begin
 if p_date is null or p_days is null or p_days not between 1 and 30
    or coalesce(cardinality(p_staff_ids),0) not between 1 and 50 then
  raise exception 'Invalid availability search bounds' using errcode='22023';
 end if;
 -- Authorize before inspecting schedule/clinic configuration, even with no matches.
 if coalesce(auth.jwt()->>'role','') <> 'service_role'
    and p_clinic_id is distinct from public.current_clinic_id() then
  raise exception 'Not authorized' using errcode='42501';
 end if;
 select timezone into zone from public.clinics where id=p_clinic_id;
 for d in 0..p_days-1 loop
  return query
   select s.id,slot.start_time,slot.end_time,slot.duration_minutes
   from public.staff s
   cross join lateral public.appointment_available_slots(p_clinic_id,s.id,p_service,p_date+d,p_exclude_id) slot
   where s.clinic_id=p_clinic_id and s.id=any(p_staff_ids) and s.active and p_service=any(s.services)
   and (p_window_start is null or (slot.start_time at time zone zone)::time>=p_window_start)
   and (p_window_end is null or (slot.start_time at time zone zone)::time<p_window_end)
   order by case when (slot.start_time at time zone zone)::time=p_requested_time then 0 else 1 end,slot.start_time,s.id limit 12;
  get diagnostics n=row_count;
  if n>0 then return;end if;
 end loop;
end $$;
revoke all on function public.appointment_search_slots(uuid,uuid[],text,date,integer,time,time,uuid,time) from public,anon;
grant execute on function public.appointment_search_slots(uuid,uuid[],text,date,integer,time,time,uuid,time) to authenticated,service_role;
commit;
