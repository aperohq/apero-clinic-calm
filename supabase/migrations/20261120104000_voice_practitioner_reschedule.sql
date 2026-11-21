begin;
create or replace function public.guard_appointment_booking()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_booking_unchanged boolean;
begin
  if tg_op='UPDATE' then
    if new.id is distinct from old.id then raise exception 'Appointment identity cannot change'; end if;
    if new.clinic_id is distinct from old.clinic_id then
      raise exception 'Appointment clinic cannot change' using errcode='42501';
    end if;
    -- RI SET NULL executes a nested UPDATE after the referenced row is gone.
    -- Require that context, actual row absence, and no other changed fields.
    -- Browser roles have no TRIGGER privileges and cannot fake a deletion by
    -- just setting staff_id/client_id to NULL while the referenced row exists.
    if pg_trigger_depth() > 1 then
      if old.staff_id is not null and new.staff_id is null
         and (to_jsonb(new)-'staff_id'-'updated_at') = (to_jsonb(old)-'staff_id'-'updated_at')
         and not exists(select 1 from public.staff where id=old.staff_id and clinic_id=old.clinic_id) then
        return new;
      end if;
      -- Retain the existing client ON DELETE SET NULL contract for the same reason.
      if old.client_id is not null and new.client_id is null
         and (to_jsonb(new)-'client_id'-'updated_at') = (to_jsonb(old)-'client_id'-'updated_at')
         and not exists(select 1 from public.clients where id=old.client_id and clinic_id=old.clinic_id) then
        return new;
      end if;
    end if;
    v_booking_unchanged := row(new.client_id,new.staff_id,new.service,new.start_time,new.end_time)
      is not distinct from row(old.client_id,old.staff_id,old.service,old.start_time,old.end_time);
    if new.status='Cancelled' then
      if not v_booking_unchanged then raise exception 'Cancellation must preserve the appointment'; end if;
      return new;
    end if;
    if v_booking_unchanged and new.status is not distinct from old.status then return new; end if;
    -- Invalid legacy intervals remain immutable; cancellation and metadata
    -- updates above are safe, but a reschedule must not silently repair history.
    if old.start_time is null or old.end_time is null or not isfinite(old.start_time)
       or not isfinite(old.end_time) or old.end_time <= old.start_time then
      raise exception 'Invalid legacy appointment booking fields cannot change' using errcode='22023';
    end if;
    if old.status <> 'Booked' or new.status <> 'Booked' then
      raise exception 'Only booked appointments can be rescheduled';
    end if;
    if new.client_id is distinct from old.client_id or (new.staff_id is distinct from old.staff_id and coalesce(auth.jwt()->>'role','') <> 'service_role')
       or new.service is distinct from old.service or
       new.end_time-new.start_time <> old.end_time-old.start_time then
      raise exception 'Rescheduling must preserve patient, practitioner, service and duration';
    end if;
  else
    if new.status <> 'Booked' then raise exception 'New appointments must be booked'; end if;
  end if;
  if new.start_time is null or new.end_time is null or not isfinite(new.start_time)
     or not isfinite(new.end_time) or new.end_time <= new.start_time then
    raise exception 'Appointment requires a finite positive interval' using errcode='22023';
  end if;
  if tg_op='INSERT' and new.end_time-new.start_time <> make_interval(mins=>public.appointment_booking_minutes(new.clinic_id)) then
    raise exception 'Use the configured booking duration';
  end if;
  if new.client_id is null or not exists(select 1 from public.clients where id=new.client_id and clinic_id=new.clinic_id) then
    raise exception 'Choose an existing clinic client' using errcode='42501';
  end if;
  if not public.appointment_slot_open(new.clinic_id,new.staff_id,new.service,new.start_time,new.end_time,
                                     case when tg_op='UPDATE' then old.id else null end) then
    raise exception 'That time is unavailable. Refresh available slots.' using errcode='23P01';
  end if;
  return new;
end $$;
revoke all on function public.guard_appointment_booking() from public, anon, authenticated;
drop trigger if exists guard_appointment_booking on public.appointments;
create trigger guard_appointment_booking before insert or update on public.appointments
for each row execute function public.guard_appointment_booking();

commit;
