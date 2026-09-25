-- The clinic dashboard can add client notes but cannot edit them. Keep existing
-- notes readable, but prevent authenticated browser clients from rewriting them.
-- Review and apply separately; this file does not alter existing rows.
begin;

revoke update on public.client_notes from authenticated;
drop policy if exists "client notes update" on public.client_notes;

notify pgrst, 'reload schema';
commit;
