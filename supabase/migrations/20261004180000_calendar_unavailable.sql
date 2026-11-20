-- A failure ends schedule discovery for this call. Browser grants/RLS stay intact.
begin;
alter table public.voice_call_state add column if not exists calendar_unavailable boolean not null default false;
notify pgrst, 'reload schema';
commit;
