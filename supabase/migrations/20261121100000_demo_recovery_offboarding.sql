begin;
-- Enrollment is revocable authorization, not clinical/audit history. Removing
-- its principal or clinic must remove that permission, never preserve an orphan.
alter table public.demo_recovery_operators drop constraint demo_recovery_operators_auth_user_id_fkey;
alter table public.demo_recovery_operators add constraint demo_recovery_operators_auth_user_id_fkey
  foreign key(auth_user_id) references auth.users(id) on delete cascade;
alter table public.demo_recovery_operators drop constraint demo_recovery_operators_clinic_id_fkey;
alter table public.demo_recovery_operators add constraint demo_recovery_operators_clinic_id_fkey
  foreign key(clinic_id) references public.clinics(id) on delete cascade;

-- Recovery audit survives both principal deletion and approved clinic cleanup.
-- Preserve its original clinic UUID as the immutable history scope, just as the
-- retention ledger does; no browser role gains access to this historical table.
alter table public.demo_call_recovery_audit alter column actor_user_id drop not null;
alter table public.demo_call_recovery_audit drop constraint demo_call_recovery_audit_actor_user_id_fkey;
alter table public.demo_call_recovery_audit add constraint demo_call_recovery_audit_actor_user_id_fkey
  foreign key(actor_user_id) references auth.users(id) on delete set null;
alter table public.demo_call_recovery_audit drop constraint demo_call_recovery_audit_clinic_id_fkey;
revoke all on public.demo_recovery_operators, public.demo_call_recovery_audit from public,anon,authenticated;
commit;
