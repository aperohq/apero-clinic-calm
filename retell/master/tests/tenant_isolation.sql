-- Integration test against the ACTUAL appointment RPC and constraints.
-- Every fixture has random IDs. No existing clinic/patient is modified.
-- Must execute the ENTIRE file as one request. All fixtures roll back even on success.
begin;
set local statement_timeout = '30s';
do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  sa uuid := gen_random_uuid(); sb uuid := gen_random_uuid();
  ca text := 'apero-test-' || gen_random_uuid(); cb text := 'apero-test-' || gen_random_uuid();
  ka uuid := gen_random_uuid(); kb uuid := gen_random_uuid();
  qa uuid := gen_random_uuid(); qb uuid := gen_random_uuid();
  when_slot timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' + interval '10 days 10 hours';
  finish timestamptz;
  ra jsonb; rb jsonb; r jsonb; appointment_a uuid; appointment_b uuid;
  operation_a text := 'apero-test-' || gen_random_uuid();
  blocked boolean;
begin
  finish := when_slot + interval '45 minutes';
  insert into public.clinics(id,name,timezone,phone) values
    (a,'Apero rollback fixture A','UTC','+12025550101'),(b,'Apero rollback fixture B','UTC','+12025550102');
  insert into public.voice_integrations(clinic_id,workspace_id,agent_id,secret_env_name,dialing_prefix,local_number_length,slot_minutes,active) values
    (a,'org_test_'||a,'agent_test_'||a,'RETELL_TEST_'||upper(replace(a::text,'-','')),'+1',10,45,true),
    (b,'org_test_'||b,'agent_test_'||b,'RETELL_TEST_'||upper(replace(b::text,'-','')),'+1',10,45,true);
  insert into public.staff(id,clinic_id,full_name,specialty,services,aliases) values
    (sa,a,'Dr. Same Name','General',array['Consultation','Only A'],array['Same Alias']),
    (sb,b,'Dr. Same Name','General',array['Consultation','Only B'],array['Same Alias']);
  insert into public.staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time,is_available) values
    (a,sa,extract(dow from when_slot at time zone 'UTC'), '09:00','17:00',true),
    (b,sb,extract(dow from when_slot at time zone 'UTC'), '09:00','17:00',true);
  insert into public.voice_call_state(call_id,clinic_id,current_check_id) values(ca,a,ka),(cb,b,kb);
  insert into public.voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at) values
    (qa,ka,ca,a,sa,'Consultation',when_slot,finish,now()+interval '10 minutes'),
    (qb,kb,cb,b,sb,'Consultation',when_slot,finish,now()+interval '10 minutes');

  -- Cross-tenant checked slot and staff can never be consumed.
  r := public.voice_apply_appointment('book',b,'apero-test-'||gen_random_uuid(),cb,null,'Fixture Patient','+12025550102',null,null,sa,'Consultation',when_slot,finish,kb,qa);
  if r->>'error_type' <> 'slot_not_checked' then raise exception 'Cross slot/staff accepted: %',r; end if;
  r := public.voice_apply_appointment('book',b,'apero-test-'||gen_random_uuid(),cb,null,'Fixture Patient','+12025550102',null,null,sb,'Only A',when_slot,finish,kb,qb);
  if r->>'error_type' <> 'slot_not_checked' then raise exception 'Cross service accepted: %',r; end if;
  r := public.voice_apply_appointment('book',b,'apero-test-'||gen_random_uuid(),ca,null,'Fixture Patient','+12025550102',null,null,sb,'Consultation',when_slot,finish,ka,qb);
  if r->>'error_type' <> 'stale_or_invalid_slot' then raise exception 'Cross call accepted: %',r; end if;

  ra := public.voice_apply_appointment('book',a,operation_a,ca,null,'Fixture Patient','+12025550101',null,null,sa,'Consultation',when_slot,finish,ka,qa);
  rb := public.voice_apply_appointment('book',b,'apero-test-'||gen_random_uuid(),cb,null,'Fixture Patient','+12025550102',null,null,sb,'Consultation',when_slot,finish,kb,qb);
  if ra->>'success' <> 'true' or rb->>'success' <> 'true' then raise exception 'Valid fixture booking failed: %, %',ra,rb; end if;
  appointment_a := (ra->>'appointment_id')::uuid; appointment_b := (rb->>'appointment_id')::uuid;
  if not exists(select 1 from public.appointments where id=appointment_a and clinic_id=a and staff_id=sa)
     or not exists(select 1 from public.appointments where id=appointment_b and clinic_id=b and staff_id=sb) then
    raise exception 'Same-name practitioner appointments crossed tenants';
  end if;
  r := public.voice_apply_appointment('book',a,operation_a,ca,null,'Fixture Patient','+12025550101',null,null,sa,'Consultation',when_slot,finish,ka,qa);
  if r <> ra then raise exception 'Idempotent repeat changed result'; end if;
  r := public.voice_apply_appointment('book',b,operation_a,cb,null,'Fixture Patient','+12025550102',null,null,sb,'Consultation',when_slot,finish,kb,qb);
  if r->>'error_type' <> 'operation_mismatch' then raise exception 'Cross operation key accepted'; end if;
  r := public.voice_apply_appointment('book',a,'apero-test-'||gen_random_uuid(),ca,null,'Fixture Patient','+12025550101',null,null,sa,'Consultation',when_slot,finish,ka,qa);
  if r->>'error_type' <> 'stale_or_invalid_slot' then raise exception 'Consumed slot reused'; end if;

  -- Valid B checked slot cannot move A's appointment. Original A must stay intact.
  update public.voice_call_state set current_check_id=kb where call_id=cb;
  r := public.voice_apply_appointment('reschedule',b,'apero-test-'||gen_random_uuid(),cb,appointment_a,'Fixture Patient','+12025550102',null,null,sb,'Consultation',when_slot,finish,kb,qb);
  if r->>'error_type' <> 'appointment_not_found' then raise exception 'Cross reschedule accepted'; end if;
  r := public.voice_apply_appointment('cancel',b,'apero-test-'||gen_random_uuid(),cb,appointment_a,'Fixture Patient','+12025550101',null,null,null,null,null,null,null,null);
  if r->>'error_type' <> 'appointment_not_found' then raise exception 'Cross cancel accepted'; end if;
  if not exists(select 1 from public.appointments where id=appointment_a and status='Booked' and start_time=when_slot and clinic_id=a) then raise exception 'Failed reschedule damaged original'; end if;

  -- Even service-role upserts cannot reassign global call ownership.
  blocked := false;
  begin update public.voice_call_state set clinic_id=b where call_id=ca;
  exception when raise_exception then blocked := true; end;
  if not blocked then raise exception 'Call ownership reassignment accepted'; end if;
  -- Composite staff foreign key is a second line of defense behind the RPC.
  blocked := false;
  begin update public.appointments set staff_id=sa where id=appointment_b;
  exception when foreign_key_violation then blocked := true; end;
  if not blocked then raise exception 'Cross clinic staff FK accepted'; end if;

  -- Only the verified tenant/patient can cancel its own appointment.
  r := public.voice_apply_appointment('cancel',b,'apero-test-'||gen_random_uuid(),cb,appointment_b,'Fixture Patient','+12025550102',null,null,null,null,null,null,null,null);
  if r->>'success' <> 'true' then raise exception 'Own clinic cancellation failed: %',r; end if;
end $$;
rollback;
select 'PASS: rollback tenant/RPC isolation; no fixture rows persisted' as result;
