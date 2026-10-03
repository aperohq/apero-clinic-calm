-- Test-only snapshot of the already-deployed prerequisite schema.
-- Allow clinic owners and managers to close Sara requests from the dashboard.
-- Apply manually after review. No existing request rows are changed.
begin;

grant update (status) on public.voice_requests to authenticated;

drop policy if exists "voice requests clinic update status" on public.voice_requests;
create policy "voice requests clinic update status" on public.voice_requests
  for update to authenticated
  using (clinic_id = public.current_clinic_id()
         and public.current_profile_role() in ('owner', 'manager'))
  with check (clinic_id = public.current_clinic_id()
              and public.current_profile_role() in ('owner', 'manager'));

notify pgrst, 'reload schema';
commit;
