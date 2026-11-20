-- MANUAL ONLY: verify the intended APERO project before running in SQL Editor.
-- One SELECT statement, one consolidated result set. Catalog metadata only:
-- no product-row reads, writes, DDL, temporary objects, or helper execution.
-- Grants below are EFFECTIVE privileges, including PUBLIC/role inheritance;
-- they do not imply access through RLS. Empty grants mean none (not missing).
-- Column privileges are listed separately when the table privilege is absent.
-- Read TABLE rows first, then POLICY and prerequisite rows. Missing expected
-- objects have object_exists=false. Details include definitions and raw ACLs.
with
required_tables(table_name) as (values
  ('clinics'), ('profiles'), ('clients'), ('staff'), ('staff_availability'),
  ('staff_time_off'), ('appointments'), ('conversations'), ('client_notes'),
  ('notifications'), ('voice_requests'), ('voice_operations'), ('voice_call_state'),
  ('voice_checked_slots'), ('voice_integrations'), ('clinic_service_aliases')
),
relations as (
  select r.table_name, c.oid, c.relrowsecurity, c.relforcerowsecurity,
         c.relowner, c.relkind, c.reloptions, c.relacl
  from required_tables r left join pg_class c
    on c.oid = to_regclass(format('public.%I', r.table_name))
),
roles as (
  select wanted.role_name, r.oid, r.rolsuper, r.rolbypassrls, r.rolinherit
  from (values ('authenticated'), ('anon'), ('service_role')) wanted(role_name)
  left join pg_roles r on r.rolname = wanted.role_name
),
privileges(privilege, position) as (values
  ('SELECT',1), ('INSERT',2), ('UPDATE',3), ('DELETE',4),
  ('TRUNCATE',5), ('REFERENCES',6), ('TRIGGER',7)
),
effective_grants as (
  select c.table_name, r.role_name,
    case when c.oid is null or r.oid is null then 'OBJECT OR ROLE MISSING'
    else concat_ws(E'\n',
      (select string_agg(p.privilege, ', ' order by p.position)
       from privileges p where has_table_privilege(r.oid, c.oid, p.privilege)),
      (select string_agg(p.privilege || ' (' || a.attname || ')', ', '
                        order by p.position, a.attnum)
       from pg_attribute a cross join privileges p
       where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
         and p.privilege in ('SELECT','INSERT','UPDATE','REFERENCES')
         and not has_table_privilege(r.oid, c.oid, p.privilege)
         and has_column_privilege(r.oid, c.oid, a.attnum, p.privilege))
    ) end as grants
  from relations c cross join roles r
),
grant_summary as (
  select table_name,
    max(grants) filter (where role_name = 'authenticated') as authenticated_grants,
    max(grants) filter (where role_name = 'anon') as anon_grants,
    max(grants) filter (where role_name = 'service_role') as service_role_grants
  from effective_grants group by table_name
),
required_columns(table_name, column_name) as (values
  ('clinics','name'), ('clinics','logo_url'), ('clinics','phone'),
  ('clinics','email'), ('clinics','timezone'), ('profiles','full_name'),
  ('profiles','phone'), ('notifications','read'), ('voice_requests','status'),
  ('profiles','auth_user_id'), ('profiles','clinic_id'), ('profiles','role')
),
required_functions(signature) as (values
  ('public.current_clinic_id()'), ('public.current_profile_id()'),
  ('public.current_profile_role()'),
  ('public.create_staff_with_schedule(text,text,text,text,text[],jsonb)'),
  ('public.voice_apply_appointment(text,uuid,text,text,uuid,text,text,text,text,uuid,text,timestamptz,timestamptz,uuid,uuid)')
),
functions as (
  select signature, to_regprocedure(signature)::oid as oid from required_functions
  union
  select p.oid::regprocedure::text, p.oid
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and (p.prosecdef or p.prorettype = 'trigger'::regtype)
    and not exists (select 1 from required_functions r
                    where to_regprocedure(r.signature)::oid = p.oid)
),
required_triggers(table_name, trigger_name) as (values
  ('profiles','guard_profile_sensitive_fields'),
  ('notifications','guard_notifications_read_only'),
  ('client_notes','guard_client_notes_immutable'),
  ('staff_availability','guard_clinic_refs_staff_availability'),
  ('appointments','guard_clinic_refs_appointments'),
  ('conversations','guard_clinic_refs_conversations'),
  ('client_notes','guard_clinic_refs_client_notes'),
  ('notifications','guard_clinic_refs_notifications'),
  ('voice_call_state','voice_call_state_clinic_guard'),
  ('conversations','conversations_voice_clinic_guard')
),
triggers as (
  select r.table_name, r.trigger_name, t.oid
  from required_triggers r left join pg_trigger t
    on t.tgrelid = to_regclass(format('public.%I', r.table_name))
    and t.tgname = r.trigger_name and not t.tgisinternal
  union
  select c.relname::text, t.tgname::text, t.oid
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
),
required_constraints(table_name, constraint_name) as (values
  ('profiles','profiles_auth_user_id_key'),
  ('profiles','profiles_auth_user_id_fkey'),
  ('profiles','profiles_clinic_id_fkey'),
  ('staff_availability','staff_availability_same_clinic_fkey'),
  ('staff_time_off','staff_time_off_same_clinic_fkey'),
  ('voice_checked_slots','voice_checked_slots_staff_clinic_fkey'),
  ('voice_checked_slots','voice_checked_slots_call_clinic_fkey')
),
constraints as (
  select r.table_name, r.constraint_name, con.oid
  from required_constraints r left join pg_constraint con
    on con.conrelid = to_regclass(format('public.%I', r.table_name))
    and con.conname = r.constraint_name
  union
  select c.relname::text, con.conname::text, con.oid
  from pg_constraint con join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and con.contype in ('p','u','f','c')
),
report as (
  select 1 as sort_order, 'TABLE'::text as section, c.table_name,
    format('public.%I', c.table_name) as object_name,
    c.oid is not null as object_exists, c.relrowsecurity as rls_enabled,
    g.authenticated_grants, g.anon_grants, g.service_role_grants,
    (select string_agg(policyname, E'\n' order by policyname) from pg_policies
     where schemaname = 'public' and tablename = c.table_name) as policy_name,
    null::text as policy_command, null::text as policy_using,
    null::text as policy_with_check,
    jsonb_build_object('owner', pg_get_userbyid(c.relowner),
      'relation_kind', c.relkind, 'rls_forced', c.relforcerowsecurity,
      'options', c.reloptions, 'table_acl', c.relacl,
      'column_acls', (select jsonb_agg(jsonb_build_object('column', a.attname,
                       'acl', a.attacl) order by a.attnum)
        from pg_attribute a where a.attrelid = c.oid and a.attnum > 0
          and not a.attisdropped and a.attacl is not null)) as details
  from relations c join grant_summary g using (table_name)
  union all
  select 2, 'POLICY', p.tablename, p.policyname, true, c.relrowsecurity,
    null, null, null, p.policyname, p.cmd, p.qual, p.with_check,
    jsonb_build_object('roles', p.roles, 'permissive', p.permissive)
  from pg_policies p join pg_class c
    on c.oid = to_regclass(format('%I.%I', p.schemaname, p.tablename))
  where p.schemaname = 'public'
  union all
  select 3, 'REQUIRED COLUMN', r.table_name, r.column_name,
    a.attname is not null, null, null, null, null, null, null, null, null,
    jsonb_build_object('type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull,
      'purpose', case when r.table_name = 'profiles'
        and r.column_name in ('auth_user_id','clinic_id','role')
        then 'Trusted membership' else 'Required UPDATE grant column' end)
  from required_columns r left join pg_attribute a
    on a.attrelid = to_regclass(format('public.%I', r.table_name))
    and a.attname = r.column_name and a.attnum > 0 and not a.attisdropped
  union all
  select 4, 'FUNCTION', null, f.signature, p.oid is not null, null,
    case when p.oid is not null and a.oid is not null
      then has_function_privilege(a.oid, p.oid, 'EXECUTE')::text end,
    case when p.oid is not null and b.oid is not null
      then has_function_privilege(b.oid, p.oid, 'EXECUTE')::text end,
    case when p.oid is not null and s.oid is not null
      then has_function_privilege(s.oid, p.oid, 'EXECUTE')::text end,
    null, null, null, null,
    jsonb_build_object('grant_columns_mean', 'Effective EXECUTE: true/false',
      'required', exists (select 1 from required_functions r where r.signature = f.signature),
      'owner', pg_get_userbyid(p.proowner), 'security_definer', p.prosecdef,
      'config', p.proconfig, 'acl', p.proacl,
      'definition', case when p.oid is not null then pg_get_functiondef(p.oid) end)
  from functions f left join pg_proc p on p.oid = f.oid
  cross join (select oid from roles where role_name = 'authenticated') a
  cross join (select oid from roles where role_name = 'anon') b
  cross join (select oid from roles where role_name = 'service_role') s
  union all
  select 5, 'TRIGGER', r.table_name, r.trigger_name, t.oid is not null,
    null, null, null, null, null, null, null, null,
    jsonb_build_object('enabled', t.tgenabled,
      'required', exists (select 1 from required_triggers x
        where x.table_name = r.table_name and x.trigger_name = r.trigger_name),
      'definition', case when t.oid is not null then pg_get_triggerdef(t.oid) end)
  from triggers r left join pg_trigger t on t.oid = r.oid
  union all
  select 6, 'CONSTRAINT', r.table_name, r.constraint_name, con.oid is not null,
    null, null, null, null, null, null, null, null,
    jsonb_build_object('validated', con.convalidated,
      'required', exists (select 1 from required_constraints x
        where x.table_name = r.table_name and x.constraint_name = r.constraint_name),
      'definition', case when con.oid is not null then pg_get_constraintdef(con.oid) end)
  from constraints r left join pg_constraint con on con.oid = r.oid
  union all
  select 7, 'ROLE', null, r.role_name, r.oid is not null,
    null, null, null, null, null, null, null, null,
    jsonb_build_object('superuser', r.rolsuper, 'bypass_rls', r.rolbypassrls,
      'inherit', r.rolinherit, 'memberships',
      (select jsonb_agg(pg_get_userbyid(m.roleid) order by m.roleid)
       from pg_auth_members m where m.member = r.oid))
  from roles r
  union all
  select 8, 'ADDITIONAL RELATION', c.relname, format('public.%I', c.relname),
    true, c.relrowsecurity, null, null, null, null, null, null, null,
    jsonb_build_object('owner', pg_get_userbyid(c.relowner), 'kind', c.relkind,
      'options', c.reloptions, 'acl', c.relacl)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
    and not exists (select 1 from required_tables r where r.table_name = c.relname)
  union all
  select 9, 'DEFAULT PRIVILEGES', null,
    pg_get_userbyid(d.defaclrole) || ' / ' || coalesce(n.nspname, '(all schemas)')
      || ' / ' || d.defaclobjtype::text, true,
    null, null, null, null, null, null, null, null,
    jsonb_build_object('owner', pg_get_userbyid(d.defaclrole),
      'schema', n.nspname, 'object_type', d.defaclobjtype, 'acl', d.defaclacl)
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all
  select 10, 'CLI HISTORY', null, 'supabase_migrations.schema_migrations',
    to_regclass('supabase_migrations.schema_migrations') is not null,
    null, null, null, null, null, null, null, null,
    jsonb_build_object('note', 'Presence only; no migration history rows read')
)
select section, table_name, object_name, object_exists, rls_enabled,
       authenticated_grants, anon_grants, service_role_grants,
       policy_name, policy_command, policy_using, policy_with_check, details
from report order by sort_order, table_name nulls last, object_name;
