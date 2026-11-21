begin;
create function public.normalize_clinic_phone(p_phone text,p_prefix text default '+965',p_length integer default 8)
returns text language sql immutable strict set search_path=pg_catalog as $$
 select case
  when p_length not between 6 and 14 or p_prefix !~ '^\+[0-9]{1,4}$' then null
  when digits ~ ('^[0-9]{'||p_length||'}$') then p_prefix||digits
  when digits ~ ('^'||substring(p_prefix from 2)||'[0-9]{'||p_length||'}$') then '+'||digits
  when digits ~ ('^00'||substring(p_prefix from 2)||'[0-9]{'||p_length||'}$') then '+'||substring(digits from 3)
  else null end
 from (select regexp_replace(p_phone,'[^0-9]','','g') digits) x
$$;
create index clients_clinic_normalized_phone_idx on public.clients(clinic_id,public.normalize_clinic_phone(phone));
-- Service-only lookup. Never accept a clinic from an unsigned provider payload.
create function public.clinic_clients_by_phone(p_clinic_id uuid,p_phone text,p_prefix text default '+965',p_length integer default 8)
returns table(id uuid,phone text) language sql stable security invoker set search_path=public,pg_temp as $$
 select c.id,c.phone from public.clients c
 where c.clinic_id=p_clinic_id and public.normalize_clinic_phone(c.phone,p_prefix,p_length)=public.normalize_clinic_phone(p_phone,p_prefix,p_length)
 order by c.id limit 2
$$;
revoke all on function public.clinic_clients_by_phone(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.clinic_clients_by_phone(uuid,text,text,integer) to service_role;
commit;
