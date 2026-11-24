-- Local proposal: no provider calls, account creation, email or automatic activation.
begin;
create table public.clinic_onboarding (
 clinic_id uuid primary key references public.clinics(id) on delete cascade,
 submission_key text not null unique check(length(submission_key) between 8 and 200),
 payload jsonb not null,
 synthetic boolean not null default true,
 lifecycle text not null default 'configuration' check(lifecycle in ('configuration','activated','suspended','closed')),
 consent_revision text,
 review_fingerprint text,
 external_review_started_at timestamptz,
 data_reviewed_at timestamptz,
 data_review_fingerprint text,
 external_approved_at timestamptz,
 activated_at timestamptz,
 created_at timestamptz not null default now()
);
create table public.clinic_onboarding_audit (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null, -- survives clinic erasure; contains no patient/contact data
 actor_id uuid,
 event text not null check(event in ('provisioned','intake_registered','activated','suspended','reactivated','closed','data_reviewed','technical_reviewed','external_review_requested')),
 reason text not null check(length(reason) between 1 and 1000),
 occurred_at timestamptz not null default now()
);
alter table public.clinic_onboarding enable row level security;
alter table public.clinic_onboarding_audit enable row level security;
revoke all on public.clinic_onboarding,public.clinic_onboarding_audit from public,anon,authenticated,service_role;
grant select on public.clinic_onboarding to authenticated,service_role;
grant select on public.clinic_onboarding_audit to service_role;
create policy "owner reads own onboarding" on public.clinic_onboarding for select to authenticated
 using(clinic_id=public.current_clinic_id() and public.current_profile_role()='owner');

-- Existing retention/offboarding remains authoritative even for legacy clinics
-- with no intake record. The optional lookup supports independent schema tests.
create function public.clinic_lifecycle_allows_access(p_clinic uuid) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare old_state text;
begin
 if exists(select 1 from public.clinic_onboarding where clinic_id=p_clinic and lifecycle in ('suspended','closed')) then return false;end if;
 if to_regclass('public.clinic_offboarding') is not null then
 execute 'select state from public.clinic_offboarding where clinic_id=$1' into old_state using p_clinic;
 if old_state is not null and old_state<>'disabled' then return false;end if;end if;
 return true;
end $$;
revoke all on function public.clinic_lifecycle_allows_access(uuid) from public,anon,authenticated,service_role;

create function public.validate_clinic_intake(p jsonb) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare k text; s jsonb; person jsonb; names text[]:='{}'; staff_names text[]:='{}'; v text; day jsonb; period jsonb; seen int[]:='{}'; previous_end text; dow int; schedule jsonb;
begin
 if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>262144
 or not p ?& array['clinic','owner_auth_id','owner_name','services','practitioners','closures','faqs','synthetic']
 or p-array['clinic','owner_auth_id','owner_name','services','practitioners','closures','faqs','synthetic']<>'{}'::jsonb then
 raise exception 'Intake: invalid fields or size' using errcode='22023'; end if;
 if jsonb_typeof(p->'clinic') is distinct from 'object' then raise exception 'Intake: clinic required' using errcode='22023';end if;
 if (p->'clinic')-array['name','localized_name','clinic_type','phone','email','address','city','country','timezone','opening_hours','receptionist_name','receptionist_localized_name']<>'{}'::jsonb then raise exception 'Intake: unsupported clinic fields' using errcode='22023';end if;
 foreach k in array array['name','localized_name','clinic_type','phone','email','address','country','timezone','receptionist_name'] loop
 if jsonb_typeof(p->'clinic'->k) is distinct from 'string' or length(btrim(p->'clinic'->>k))=0 then
 raise exception 'Intake: clinic.% required',k using errcode='22023';end if;end loop;
 for k in select jsonb_object_keys(p->'clinic') loop
 if k<>'opening_hours' and (jsonb_typeof(p->'clinic'->k) not in ('string','null')
 or length(p->'clinic'->>k)>case when k='address' then 1000 when k='email' then 254 when k in ('name','localized_name') then 200 else 100 end) then raise exception 'Intake: invalid clinic.%',k using errcode='22023';end if;end loop;
 if p->'clinic'->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 or not exists(select 1 from pg_catalog.pg_timezone_names where name=p->'clinic'->>'timezone') then raise exception 'Intake: valid email and IANA timezone required' using errcode='22023';end if;
 if jsonb_typeof(p->'clinic'->'opening_hours') is distinct from 'object'
 or (p->'clinic'->'opening_hours')-'days'<>'{}'::jsonb
 or jsonb_typeof(p->'clinic'->'opening_hours'->'days') is distinct from 'array'
 then raise exception 'Intake: seven-day operating hours required' using errcode='22023';end if;
 if jsonb_array_length(p->'clinic'->'opening_hours'->'days')<>7 then raise exception 'Intake: seven-day operating hours required' using errcode='22023';end if;
 for day in select value from jsonb_array_elements(p->'clinic'->'opening_hours'->'days') loop
 if jsonb_typeof(day)<>'object' or day-array['day','periods']<>'{}'::jsonb
 or jsonb_typeof(day->'day') is distinct from 'number' or coalesce(day->>'day','')!~'^[0-6]$'
 or jsonb_typeof(day->'periods') is distinct from 'array' then raise exception 'Intake: invalid weekday' using errcode='22023';end if;
 dow:=(day->>'day')::int;
 if dow=any(seen) or jsonb_array_length(day->'periods')>4 then raise exception 'Intake: unique weekdays and up to four periods required' using errcode='22023';end if;
 seen:=array_append(seen,dow);previous_end:=null;
 for period in select value from jsonb_array_elements(day->'periods') order by value->>'start' loop
 if jsonb_typeof(period)<>'object' or period-array['start','end']<>'{}'::jsonb
 or jsonb_typeof(period->'start') is distinct from 'string' or jsonb_typeof(period->'end') is distinct from 'string'
 or coalesce(period->>'start','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
 or coalesce(period->>'end','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
 or period->>'start'>=period->>'end' or (previous_end is not null and period->>'start'<previous_end) then raise exception 'Intake: invalid operating interval' using errcode='22023';end if;previous_end:=period->>'end';end loop;
 end loop;
 if p->'clinic'->>'phone' !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Intake: use international E.164 phone' using errcode='22023';end if;
 if jsonb_typeof(p->'synthetic') is distinct from 'boolean'
 or jsonb_typeof(p->'owner_name') is distinct from 'string' or length(btrim(p->>'owner_name')) not between 1 and 200
 or coalesce(p->>'owner_auth_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
 raise exception 'Intake: owner and synthetic classification required' using errcode='22023';end if;
 if jsonb_typeof(p->'clinic'->'opening_hours'->'days') is distinct from 'array' then raise exception 'Intake: operating hours required' using errcode='22023';end if;
 if not exists(select 1 from jsonb_array_elements(p->'clinic'->'opening_hours'->'days') d where jsonb_array_length(d->'periods')>0) then raise exception 'Intake: at least one open period required' using errcode='22023';end if;
 if jsonb_typeof(p->'services') is distinct from 'array' or jsonb_array_length(p->'services') not between 1 and 100 then raise exception 'Intake: services required' using errcode='22023';end if;
 for s in select value from jsonb_array_elements(p->'services') loop
 if jsonb_typeof(s)<>'object' or s-array['name','duration_minutes']<>'{}'::jsonb
 or jsonb_typeof(s->'name') is distinct from 'string' or length(btrim(s->>'name')) not between 1 and 200
 or (s->>'name')<>btrim(s->>'name') or lower(s->>'name')=any(names)
 or jsonb_typeof(s->'duration_minutes') is distinct from 'number' or coalesce(s->>'duration_minutes','') !~ '^[0-9]{1,3}$'
 or (s->>'duration_minutes')::int not between 5 and 480 then raise exception 'Intake: unique services and durations 5–480 required' using errcode='22023';end if;
 names:=array_append(names,lower(s->>'name'));end loop;
 if jsonb_typeof(p->'practitioners') is distinct from 'array' or jsonb_array_length(p->'practitioners') not between 1 and 100 then raise exception 'Intake: practitioners required' using errcode='22023';end if;
 for person in select value from jsonb_array_elements(p->'practitioners') loop
 if jsonb_typeof(person)<>'object' or person-array['name','specialty','services','availability']<>'{}'::jsonb
 or jsonb_typeof(person->'name') is distinct from 'string' or length(btrim(person->>'name')) not between 1 and 200
 or (person->>'name')<>btrim(person->>'name') or lower(person->>'name')=any(staff_names)
 or jsonb_typeof(person->'specialty') is distinct from 'string' or length(btrim(person->>'specialty')) not between 1 and 200
 or jsonb_typeof(person->'services') is distinct from 'array' or jsonb_array_length(person->'services')=0 then raise exception 'Intake: practitioner identity and eligibility required' using errcode='22023';end if;
 if jsonb_typeof(person->'availability') is distinct from 'array' or jsonb_array_length(person->'availability') not between 1 and 7 then raise exception 'Intake: explicit practitioner availability required' using errcode='22023';end if;
 seen:='{}';
 for schedule in select value from jsonb_array_elements(person->'availability') loop
 if jsonb_typeof(schedule)<>'object' or schedule-array['day','start','end']<>'{}'::jsonb
 or jsonb_typeof(schedule->'day') is distinct from 'number' or coalesce(schedule->>'day','')!~'^[0-6]$'
 or jsonb_typeof(schedule->'start') is distinct from 'string' or jsonb_typeof(schedule->'end') is distinct from 'string'
 or coalesce(schedule->>'start','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
 or coalesce(schedule->>'end','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
 or schedule->>'start'>=schedule->>'end' then raise exception 'Intake: invalid practitioner availability' using errcode='22023';end if;
 dow:=(schedule->>'day')::int;
 if dow=any(seen) or not exists(select 1 from jsonb_array_elements(p->'clinic'->'opening_hours'->'days') d,
 jsonb_array_elements(d->'periods') slot where (d->>'day')::int=dow and slot->>'start'<=schedule->>'start' and slot->>'end'>=schedule->>'end') then
 raise exception 'Intake: practitioner schedule must fit within clinic hours with one interval per weekday' using errcode='22023';end if;
 seen:=array_append(seen,dow);end loop;
 staff_names:=array_append(staff_names,lower(person->>'name'));
 for s in select value from jsonb_array_elements(person->'services') loop
 if jsonb_typeof(s)<>'string' or not exists(select 1 from jsonb_array_elements(p->'services') c where c->>'name'=s#>>'{}') then raise exception 'Intake: unknown practitioner service' using errcode='22023';end if;end loop;
 if (select count(*) from jsonb_array_elements(person->'services'))<>(select count(distinct value) from jsonb_array_elements(person->'services')) then raise exception 'Intake: duplicate eligibility' using errcode='22023';end if;
 end loop;
 for s in select value from jsonb_array_elements(p->'services') loop
 if not exists(select 1 from jsonb_array_elements(p->'practitioners') x where x->'services' ? (s->>'name')) then raise exception 'Intake: service has no practitioner' using errcode='22023';end if;end loop;
 if jsonb_typeof(p->'closures') is distinct from 'array' or jsonb_array_length(p->'closures')>366 then raise exception 'Intake: closures must be an array' using errcode='22023';end if;
 for s in select value from jsonb_array_elements(p->'closures') loop
 if jsonb_typeof(s)<>'string' or s#>>'{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Intake: closure date required' using errcode='22023';end if;
 perform (s#>>'{}')::date;end loop;
 if (select count(*) from jsonb_array_elements(p->'closures'))<>(select count(distinct value) from jsonb_array_elements(p->'closures')) then raise exception 'Intake: duplicate closure' using errcode='22023';end if;
 if jsonb_typeof(p->'faqs') is distinct from 'array' or jsonb_array_length(p->'faqs')>100 then raise exception 'Intake: FAQs must be an array' using errcode='22023';end if;
 for s in select value from jsonb_array_elements(p->'faqs') loop
 if jsonb_typeof(s)<>'object' or s-array['question','answer']<>'{}'::jsonb
 or jsonb_typeof(s->'question') is distinct from 'string' or length(btrim(s->>'question')) not between 1 and 500
 or jsonb_typeof(s->'answer') is distinct from 'string' or length(btrim(s->>'answer')) not between 1 and 4000 then raise exception 'Intake: FAQ question and answer required' using errcode='22023';end if;end loop;
end $$;
revoke all on function public.validate_clinic_intake(jsonb) from public,anon,authenticated,service_role;

create function public.provision_clinic(p_submission_key text,p_payload jsonb) returns uuid
language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare prior public.clinic_onboarding; c public.clinics; u auth.users; person jsonb; day jsonb; sid uuid; result uuid; closure jsonb;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Trusted provisioning required' using errcode='42501';end if;
 if p_submission_key is null or length(p_submission_key) not between 8 and 200 then raise exception 'Submission key required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('clinic-intake:'||p_submission_key,0));
 select * into prior from public.clinic_onboarding where submission_key=p_submission_key;
 if found then
 if prior.payload is distinct from p_payload then raise exception 'Submission key conflicts with saved intake' using errcode='22023';end if;
 return prior.clinic_id;end if;
 perform public.validate_clinic_intake(p_payload);
 select * into u from auth.users where id=(p_payload->>'owner_auth_id')::uuid for update;
 if u.id is null or u.email_confirmed_at is null or (to_jsonb(u)->>'deleted_at') is not null
 or coalesce((to_jsonb(u)->>'banned_until')::timestamptz,'-infinity'::timestamptz)>now() then raise exception 'Verified existing owner account required' using errcode='22023';end if;
 if exists(select 1 from public.profiles where auth_user_id=u.id) then raise exception 'Owner already has a clinic membership' using errcode='23505';end if;
 -- Same clinic contact is serialized even under different submission keys.
 perform pg_advisory_xact_lock(hashtextextended('clinic-contact:'||(p_payload->'clinic'->>'phone'),0));
 if exists(select 1 from public.clinics where (case
 when regexp_replace(phone,'[^0-9]','','g') like '00%' then '+'||substr(regexp_replace(phone,'[^0-9]','','g'),3)
 when length(regexp_replace(phone,'[^0-9]','','g'))=8 and timezone='Asia/Kuwait' then '+965'||regexp_replace(phone,'[^0-9]','','g')
 else '+'||regexp_replace(phone,'[^0-9]','','g') end)=p_payload->'clinic'->>'phone') then raise exception 'Clinic contact already exists; review before retry' using errcode='23505';end if;
 select * into c from jsonb_populate_record(null::public.clinics,p_payload->'clinic');
 insert into public.clinics(name,localized_name,clinic_type,phone,email,address,city,country,timezone,opening_hours,receptionist_name,receptionist_localized_name)
 values(c.name,c.localized_name,c.clinic_type,c.phone,c.email,c.address,c.city,c.country,c.timezone,c.opening_hours,c.receptionist_name,c.receptionist_localized_name) returning id into result;
 insert into public.profiles(auth_user_id,clinic_id,full_name,email,role) values(u.id,result,btrim(p_payload->>'owner_name'),lower(u.email),'owner');
 for person in select value from jsonb_array_elements(p_payload->'practitioners') loop
 insert into public.staff(clinic_id,full_name,specialty,services) values(result,person->>'name',person->>'specialty',array(select jsonb_array_elements_text(person->'services'))) returning id into sid;
 -- Never infer practitioner eligibility/availability from public opening hours.
 for day in select value from jsonb_array_elements(person->'availability') loop
 insert into public.staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time,is_available)
 values(result,sid,(day->>'day')::smallint,(day->>'start')::time,(day->>'end')::time,true);end loop;
 for closure in select value from jsonb_array_elements(p_payload->'closures') loop
 insert into public.staff_time_off(clinic_id,staff_id,start_time,end_time,reason) values(result,sid,
 (closure#>>'{}')::date::timestamp at time zone c.timezone,((closure#>>'{}')::date+1)::timestamp at time zone c.timezone,'Clinic closure');end loop;
 end loop;
 insert into public.clinic_onboarding(clinic_id,submission_key,payload,synthetic) values(result,p_submission_key,p_payload,(p_payload->>'synthetic')::boolean);
 insert into public.clinic_onboarding_audit(clinic_id,actor_id,event,reason) values(result,null,'provisioned','Trusted administrative intake; owner is beneficiary, not actor');
 return result;
end $$;
revoke all on function public.provision_clinic(text,jsonb) from public,anon,authenticated;
grant execute on function public.provision_clinic(text,jsonb) to service_role;
-- Explicitly register reviewed intake for an existing clinic without creating,
-- replacing or moving any clinic, practitioner, membership or scheduling rows.
create function public.register_existing_clinic_intake(p_clinic_id uuid,p_submission_key text,p_payload jsonb,p_reason text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public set lock_timeout='5s' as $$
declare c public.clinics; owner_profile public.profiles; prior public.clinic_onboarding; field text; person jsonb;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Trusted intake registration required' using errcode='42501';end if;
 if p_submission_key is null or length(p_submission_key) not between 8 and 200 or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'Stable submission key and review reason required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('clinic-intake:'||p_submission_key,0));
 perform 1 from public.profiles where clinic_id=p_clinic_id order by (role<>'owner'),id for update;
 select * into c from public.clinics where id=p_clinic_id for update;
 if c.id is null or not public.clinic_lifecycle_allows_access(c.id) then raise exception 'Existing clinic is unavailable or offboarding' using errcode='42501';end if;
 select * into prior from public.clinic_onboarding where clinic_id=c.id or submission_key=p_submission_key;
 if found then
 if prior.clinic_id=c.id and prior.submission_key=p_submission_key and prior.payload=p_payload then return c.id;end if;
 raise exception 'Existing intake conflicts; review instead of overwriting' using errcode='23505';end if;
 perform public.validate_clinic_intake(p_payload);
 select p.* into owner_profile from public.profiles p join auth.users u on u.id=p.auth_user_id
 where p.clinic_id=c.id and p.auth_user_id=(p_payload->>'owner_auth_id')::uuid and p.role='owner' and p.revoked_at is null
 and u.email_confirmed_at is not null and lower(p.email)=lower(u.email) and (to_jsonb(u)->>'deleted_at') is null
 and coalesce((to_jsonb(u)->>'banned_until')::timestamptz,'-infinity'::timestamptz)<=now();
 if owner_profile.id is null or btrim(owner_profile.full_name)<>btrim(p_payload->>'owner_name') then raise exception 'Existing owner identity does not match intake' using errcode='22023';end if;
 for field in select jsonb_object_keys(p_payload->'clinic') loop
 if to_jsonb(c)->field is distinct from p_payload->'clinic'->field then raise exception 'Existing clinic.% differs from intake; review saved configuration first',field using errcode='22023';end if;end loop;
 for person in select value from jsonb_array_elements(p_payload->'practitioners') loop
 if (select count(*) from public.staff st where st.clinic_id=c.id and st.active and st.full_name=person->>'name' and st.specialty=person->>'specialty'
 and (select array_agg(v order by v) from unnest(st.services) v)=(select array_agg(v order by v) from jsonb_array_elements_text(person->'services') v)
 and (select count(*) from public.staff_availability a where a.clinic_id=c.id and a.staff_id=st.id and a.is_available)=jsonb_array_length(person->'availability')
 and not exists(select 1 from jsonb_array_elements(person->'availability') expected where not exists(select 1 from public.staff_availability a
 where a.clinic_id=c.id and a.staff_id=st.id and a.is_available and a.day_of_week=(expected->>'day')::int and a.start_time=(expected->>'start')::time and a.end_time=(expected->>'end')::time)))<>1 then
 raise exception 'Existing practitioner or schedule differs from intake' using errcode='22023';end if;end loop;
 if exists(select 1 from public.staff st where st.clinic_id=c.id and st.active and not exists(select 1 from jsonb_array_elements(p_payload->'practitioners') p where p->>'name'=st.full_name)) then raise exception 'Include every active existing practitioner' using errcode='22023';end if;
 if exists(select 1 from public.staff st,jsonb_array_elements_text(p_payload->'closures') d where st.clinic_id=c.id and st.active and not exists(
 select 1 from public.staff_time_off t where t.clinic_id=c.id and t.staff_id=st.id and t.start_time<=d::date::timestamp at time zone c.timezone and t.end_time>=(d::date+1)::timestamp at time zone c.timezone)) then raise exception 'Existing closure time off differs from intake' using errcode='22023';end if;
 insert into public.clinic_onboarding(clinic_id,submission_key,payload,synthetic) values(c.id,p_submission_key,p_payload,(p_payload->>'synthetic')::boolean);
 insert into public.clinic_onboarding_audit(clinic_id,event,reason) values(c.id,'intake_registered',btrim(p_reason));
 return c.id;
end $$;
revoke all on function public.register_existing_clinic_intake(uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.register_existing_clinic_intake(uuid,text,jsonb,text) to service_role;
commit;
