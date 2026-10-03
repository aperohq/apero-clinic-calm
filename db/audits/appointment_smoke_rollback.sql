-- Production acceptance only; this does NOT install or rerun the migration.
-- Run the ENTIRE file in Supabase SQL Editor as the database administrator.
-- Every written row belongs to randomly generated disposable clinics/users.
-- No emails/invitations/API calls are sent. All fixtures are rolled back.
-- Expected result: every boolean in the smoke JSON is true.
-- The final ROLLBACK is mandatory. On any error, run ROLLBACK before continuing.

begin;
set local statement_timeout = '20s';
set local lock_timeout = '3s';
do $$
declare
 v_a uuid:=gen_random_uuid(); v_b uuid:=gen_random_uuid();
 v_ca uuid:=gen_random_uuid(); v_cb uuid:=gen_random_uuid();
 v_sa uuid:=gen_random_uuid(); v_sb uuid:=gen_random_uuid();
 v_users uuid[]:=array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
 v_roles text[]:=array['owner','manager','staff'];
 v_date date:=current_date+30; v_start timestamptz; v_end timestamptz;
 v_next timestamptz; v_appt uuid; v_bappt uuid; v_ai uuid;
 v_check uuid; v_slot uuid; v_call text; v_result jsonb;
 v_ok boolean; v_count int; v_i int; v_checks jsonb:='{}';
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.clinics(id,name,timezone) values(v_a,'APERO rollback-only deployment smoke A','UTC'),(v_b,'APERO rollback-only deployment smoke B','UTC');
 insert into public.clients(id,clinic_id,full_name,phone) values(v_ca,v_a,'APERO deployment smoke patient A','+96599000001'),(v_cb,v_b,'APERO deployment smoke patient B','+96599000002');
 insert into public.staff(id,clinic_id,full_name,specialty,services) values(v_sa,v_a,'APERO smoke practitioner A','Test',array['Smoke consultation']),(v_sb,v_b,'APERO smoke practitioner B','Test',array['Smoke consultation']);
 insert into public.staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time) select v_a,v_sa,d,'08:00','18:00' from generate_series(0,6) d;
 insert into public.staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time) select v_b,v_sb,d,'08:00','18:00' from generate_series(0,6) d;
 insert into public.voice_integrations(clinic_id,workspace_id,agent_id,secret_env_name,active) values(v_a,'smoke-'||v_a,'smoke-'||v_a,'RETELL_SMOKE_'||upper(replace(v_a::text,'-','')),true),(v_b,'smoke-'||v_b,'smoke-'||v_b,'RETELL_SMOKE_'||upper(replace(v_b::text,'-','')),true);
 for v_i in 1..3 loop
   insert into auth.users(id,email) values(v_users[v_i],'apero-smoke-'||v_users[v_i]||'@example.invalid');
   insert into public.profiles(auth_user_id,clinic_id,full_name,email,role) values(v_users[v_i],v_a,'APERO rollback-only smoke role','apero-smoke-'||v_users[v_i]||'@example.invalid',v_roles[v_i]::public.profile_role);
 end loop;
 for v_i in 1..3 loop
   execute 'set local role authenticated';
   perform set_config('request.jwt.claims',jsonb_build_object('sub',v_users[v_i],'role','authenticated')::text,true);
   if public.current_clinic_id()<>v_a or public.current_profile_role()::text<>v_roles[v_i] then raise exception 'Membership smoke failed'; end if;
   select start_time,end_time into v_start,v_end from public.appointment_available_slots(v_a,v_sa,'Smoke consultation',v_date,null) order by start_time limit 1;
   if v_start is null or v_end-v_start<>interval '45 minutes' then raise exception 'Availability smoke failed'; end if;
   insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time,source) values(v_a,v_ca,v_sa,'Smoke consultation',v_start,v_end,'Front desk') returning id into v_appt;
   v_ok:=false;
   begin
     insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values(v_a,v_ca,v_sa,'Smoke consultation',v_start,v_end);
   exception when exclusion_violation then v_ok:=true; end;
   if not v_ok then raise exception 'Conflict not rejected'; end if;
   select start_time into v_next from public.appointment_available_slots(v_a,v_sa,'Smoke consultation',v_date,v_appt) where start_time>=v_end order by start_time limit 1;
   update public.appointments set start_time=v_next,end_time=v_next+interval '45 minutes' where id=v_appt;
   if not exists(select 1 from public.appointments where id=v_appt and client_id=v_ca and staff_id=v_sa and start_time=v_next) then raise exception 'Reschedule failed'; end if;
   update public.appointments set status='Cancelled' where id=v_appt;
   if not exists(select 1 from public.appointment_available_slots(v_a,v_sa,'Smoke consultation',v_date,null) where start_time=v_next) then raise exception 'Cancellation did not release slot'; end if;
   if not exists(select 1 from public.appointments where id=v_appt and status='Cancelled') then raise exception 'Cancelled history lost'; end if;
   v_checks:=v_checks||jsonb_build_object(v_roles[v_i]||'_create_reschedule_cancel',true);
   execute 'reset role';
 end loop;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 v_start:=(v_date+time '10:00') at time zone 'UTC';v_end:=v_start+interval '45 minutes';
 insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values(v_b,v_cb,v_sb,'Smoke consultation',v_start,v_end) returning id into v_bappt;
 execute 'set local role authenticated';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',v_users[3],'role','authenticated')::text,true);
 if exists(select 1 from public.appointments where clinic_id=v_b) then raise exception 'Cross-clinic read leaked'; end if;
 update public.appointments set status='Cancelled' where id=v_bappt;get diagnostics v_count=row_count;
 if v_count<>0 then raise exception 'Cross-clinic cancellation allowed'; end if;
 update public.appointments set start_time=v_start+interval '1 hour',end_time=v_end+interval '1 hour' where id=v_bappt;get diagnostics v_count=row_count;
 if v_count<>0 then raise exception 'Cross-clinic reschedule allowed'; end if;
 v_ok:=false;begin
 insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values(v_a,v_cb,v_sa,'Smoke consultation',v_start,v_end);
 exception when insufficient_privilege then v_ok:=true;end;
 if not v_ok then raise exception 'Cross-clinic client allowed';end if;
 v_ok:=false;begin
 insert into public.appointments(clinic_id,client_id,staff_id,service,start_time,end_time) values(v_a,v_ca,v_sb,'Smoke consultation',v_start,v_end);
 exception when insufficient_privilege or exclusion_violation then v_ok:=true;end;
 if not v_ok then raise exception 'Cross-clinic staff allowed';end if;
 v_ok:=false;begin
 perform * from public.appointment_available_slots(v_b,v_sb,'Smoke consultation',v_date,null);
 exception when insufficient_privilege then v_ok:=true;end;
 if not v_ok then raise exception 'Cross-clinic RPC allowed';end if;
 v_checks:=v_checks||jsonb_build_object('clinic_isolation',true,'shared_availability',true,'dashboard_conflict',true);
 execute 'reset role';
 execute 'set local role service_role';
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 v_call:='apero-smoke-'||v_b;v_check:=gen_random_uuid();v_slot:=gen_random_uuid();
 insert into public.voice_call_state(call_id,clinic_id,current_check_id) values(v_call,v_b,v_check);
 insert into public.voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at) values(v_slot,v_check,v_call,v_b,v_sb,'Smoke consultation',v_start,v_end,now()+interval '5 minutes');
 v_result:=public.voice_apply_appointment('book',v_b,'apero-smoke-conflict-'||v_b,v_call,null,'APERO deployment smoke patient B','+96599000002',null,null,v_sb,'Smoke consultation',v_start,v_end,v_check,v_slot);
 if v_result->>'error_type'<>'slot_conflict' or (v_result->>'success')::boolean then raise exception 'Voice conflict contract failed: %',v_result;end if;
 v_slot:=gen_random_uuid();select start_time,end_time into v_start,v_end from public.appointment_available_slots(v_b,v_sb,'Smoke consultation',v_date,null) where start_time>=v_start+interval '2 hours' order by start_time limit 1;
 insert into public.voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at) values(v_slot,v_check,v_call,v_b,v_sb,'Smoke consultation',v_start,v_end,now()+interval '5 minutes');
 v_result:=public.voice_apply_appointment('book',v_b,'apero-smoke-book-'||v_b,v_call,null,'APERO deployment smoke patient B','+96599000002',null,null,v_sb,'Smoke consultation',v_start,v_end,v_check,v_slot);
 if coalesce((v_result->>'success')::boolean,false) is not true then raise exception 'Voice book failed: %',v_result;end if;
 v_ai:=(v_result->>'appointment_id')::uuid;
 if not exists(select 1 from public.appointments where id=v_ai and client_id=v_cb and source='Booked by Apero') then raise exception 'Voice linkage failed';end if;
 v_check:=gen_random_uuid();v_slot:=gen_random_uuid();select start_time,end_time into v_start,v_end from public.appointment_available_slots(v_b,v_sb,'Smoke consultation',v_date,v_ai) where start_time>=v_start+interval '1 hour' order by start_time limit 1;
 update public.voice_call_state set current_check_id=v_check where call_id=v_call;
 insert into public.voice_checked_slots(id,check_id,call_id,clinic_id,staff_id,service,start_time,end_time,expires_at) values(v_slot,v_check,v_call,v_b,v_sb,'Smoke consultation',v_start,v_end,now()+interval '5 minutes');
 v_result:=public.voice_apply_appointment('reschedule',v_b,'apero-smoke-reschedule-'||v_b,v_call,v_ai,'APERO deployment smoke patient B','+96599000002',null,null,v_sb,'Smoke consultation',v_start,v_end,v_check,v_slot);
 if coalesce((v_result->>'success')::boolean,false) is not true then raise exception 'Voice reschedule failed: %',v_result;end if;
 v_result:=public.voice_apply_appointment('cancel',v_b,'apero-smoke-cancel-'||v_b,v_call,v_ai,'APERO deployment smoke patient B','+96599000002',null,null,null,null,null,null,null,null);
 if coalesce((v_result->>'success')::boolean,false) is not true then raise exception 'Voice cancel failed: %',v_result;end if;
 if not exists(select 1 from public.appointment_available_slots(v_b,v_sb,'Smoke consultation',v_date,null) where start_time=v_start) then raise exception 'Voice cancel availability failed';end if;
 v_checks:=v_checks||jsonb_build_object('voice_contract',true,'voice_conflict',true,'voice_client_linkage',true,'cancel_reopens_availability',true);
 execute 'reset role';
 perform set_config('apero_smoke.results',v_checks::text,true);
end $$;
select current_setting('apero_smoke.results')::jsonb as smoke;
rollback;
