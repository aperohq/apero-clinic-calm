-- Only the four synthetic clinics from the 2026-10-07 authorization audit.
-- Run in Supabase SQL Editor with a write-enabled database administrator.
-- No Auth users, profiles, patients, calls or appointments remain in these clinics.
begin;
do $$
declare
  ids uuid[] := array[
    'eb00e889-0083-42b8-92b3-e799e20ba13a'::uuid,
    'ca39b607-9ad5-4ff4-b9e4-b51c6a837cf0'::uuid,
    '34dbc13a-7ba2-4566-bcda-d2ea8d823f67'::uuid,
    '52547fb1-f1e4-4a20-b0eb-f8cdfb4c9243'::uuid
  ];
begin
  if exists(select 1 from public.clinics where id=any(ids) and name not in (
    'Auth audit A abbc72cc-4f85-4271-b6cd-ecbdc100e2b4',
    'Auth audit B abbc72cc-4f85-4271-b6cd-ecbdc100e2b4',
    'Auth audit A fcb5ee8c-55ac-4433-a4d2-af348b698b47',
    'Auth audit B fcb5ee8c-55ac-4433-a4d2-af348b698b47'
  )) then raise exception 'Synthetic clinic identity mismatch'; end if;
  if exists(select 1 from public.profiles where clinic_id=any(ids))
    or exists(select 1 from public.clients where clinic_id=any(ids))
    or exists(select 1 from public.appointments where clinic_id=any(ids))
    or exists(select 1 from public.conversations where clinic_id=any(ids))
    or exists(select 1 from public.voice_integrations where clinic_id=any(ids))
    then raise exception 'Unexpected remaining fixture dependencies; stop and inspect'; end if;
  if exists(select 1 from public.voice_requests where clinic_id=any(ids)
    and (status <> 'Closed' or reason <> 'Synthetic audit'))
    then raise exception 'Unexpected request content; stop and inspect'; end if;
  delete from public.voice_requests where clinic_id=any(ids);
  delete from public.clinic_invitation_budgets where scope_id=any(ids);
  delete from public.clinics where id=any(ids);
end $$;
commit;

select count(*) as remaining_synthetic_clinics from public.clinics
where id in ('eb00e889-0083-42b8-92b3-e799e20ba13a',
  'ca39b607-9ad5-4ff4-b9e4-b51c6a837cf0',
  '34dbc13a-7ba2-4566-bcda-d2ea8d823f67',
  '52547fb1-f1e4-4a20-b0eb-f8cdfb4c9243');
-- Expected: 0. Re-running is harmless after successful cleanup.
