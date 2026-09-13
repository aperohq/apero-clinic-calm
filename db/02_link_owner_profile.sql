-- Run this AFTER creating the Auth user apero.hq@gmail.com in the Supabase
-- dashboard (Authentication -> Users -> Add user -> Create new user).
-- It links that account to the Dental Zone Clinic development clinic as owner.

insert into public.profiles (auth_user_id, clinic_id, full_name, email, phone, role)
select u.id,
       '11111111-1111-4111-8111-111111111111',
       'Dr. Ahmed Qandil',
       u.email,
       '+965 2225 4100',
       'owner'
from auth.users u
where u.email = 'apero.hq@gmail.com'
on conflict (auth_user_id) do update
  set clinic_id = excluded.clinic_id,
      role = excluded.role;
