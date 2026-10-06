"""Value-free structure fingerprints shared by snapshot capture and drill."""
STRUCTURE_SQL = """
select json_build_object(
'columns', (select coalesce(json_agg(x order by x.table_schema,x.table_name,x.ordinal_position),'[]') from
 (select table_schema,table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,is_nullable,column_default
  from information_schema.columns where table_schema in ('public','auth','storage','supabase_migrations','extensions')) x),
'constraints', (select coalesce(json_agg(x order by x.schema,x.tablename,x.name),'[]') from
 (select n.nspname as schema,c.relname as tablename,k.conname as name,pg_get_constraintdef(k.oid) as definition
  from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','auth','storage','supabase_migrations','extensions')) x),
'policies', (select coalesce(json_agg(x order by x.schemaname,x.tablename,x.policyname),'[]') from
 (select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies
  where schemaname in ('public','auth','storage','supabase_migrations','extensions')) x),
'app_functions', (select coalesce(json_agg(x order by x.schema,x.name,x.arguments),'[]') from
 (select n.nspname as schema,p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
   md5(pg_get_functiondef(p.oid)) as definition_hash,p.proacl::text as acl,pg_get_userbyid(p.proowner) as owner
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prokind in ('f','p')
  and n.nspname in ('public','auth','storage','supabase_migrations')
  and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')) x),
'table_acl', (select coalesce(json_agg(x order by x.schema,x.name),'[]') from
 (select n.nspname as schema,c.relname as name,c.relacl::text as acl,pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in ('r','p') and n.nspname in ('public','auth','storage','supabase_migrations','extensions')) x)
)
"""
