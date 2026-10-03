-- Proposed only: preserves Auth users, profile/history FKs and practitioners.
begin;

alter table public.profiles add column if not exists revoked_at timestamptz;

create or replace function public.current_clinic_id()
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$ select clinic_id from public.profiles
  where auth_user_id = auth.uid() and revoked_at is null limit 1 $$;
create or replace function public.current_profile_id()
returns uuid language sql stable security definer set search_path = public, pg_temp
as $$ select id from public.profiles
  where auth_user_id = auth.uid() and revoked_at is null limit 1 $$;
create or replace function public.current_profile_role()
returns public.profile_role language sql stable security definer set search_path = public, pg_temp
as $$ select role from public.profiles
  where auth_user_id = auth.uid() and revoked_at is null limit 1 $$;
revoke all on function public.current_clinic_id(), public.current_profile_id(),
  public.current_profile_role() from public, anon;
grant execute on function public.current_clinic_id(), public.current_profile_id(),
  public.current_profile_role() to authenticated, service_role;

create or replace function public.guard_profile_sensitive_fields()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then return new; end if;
  if new.clinic_id is distinct from old.clinic_id
     or new.auth_user_id is distinct from old.auth_user_id
     or new.email is distinct from old.email then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  if (new.role is distinct from old.role or new.revoked_at is distinct from old.revoked_at)
    and not coalesce((public.current_profile_role() = 'owner'
      and old.clinic_id = public.current_clinic_id()
      and old.auth_user_id <> auth.uid() and old.role <> 'owner'
      and old.revoked_at is null and new.role in ('manager','staff')
      and (new.revoked_at is null or new.role = old.role)), false) then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_profile_sensitive_fields() from public, anon, authenticated;
-- Existing browser grants stay limited to full_name/phone, with no direct
-- membership mutation. Explicitly defend against inherited column grants.
revoke update (revoked_at) on public.profiles from public, anon, authenticated;

create or replace function public.set_clinic_member_role(p_profile_id uuid, p_role public.profile_role)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare actor public.profiles%rowtype; target public.profiles%rowtype;
begin
  select * into actor from public.profiles where auth_user_id=auth.uid() for update;
  if actor.id is null or actor.role <> 'owner' or actor.revoked_at is not null
     or p_role is null or p_role not in ('manager','staff') then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  select * into target from public.profiles where id=p_profile_id and clinic_id=actor.clinic_id for update;
  if target.id is null or target.role='owner' or target.auth_user_id=actor.auth_user_id
     or target.revoked_at is not null then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  update public.profiles set role=p_role where id=target.id;
  return target.id;
end $$;
revoke all on function public.set_clinic_member_role(uuid,public.profile_role) from public, anon;
grant execute on function public.set_clinic_member_role(uuid,public.profile_role) to authenticated;

create or replace function public.revoke_clinic_member(p_profile_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare actor public.profiles%rowtype; target public.profiles%rowtype;
begin
  select * into actor from public.profiles where auth_user_id=auth.uid() for update;
  if actor.id is null or actor.role <> 'owner' or actor.revoked_at is not null then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  select * into target from public.profiles where id=p_profile_id and clinic_id=actor.clinic_id for update;
  if target.id is null or target.role='owner' or target.auth_user_id=actor.auth_user_id then
    raise exception 'Not authorized to change account access' using errcode='42501';
  end if;
  update public.profiles set revoked_at=coalesce(revoked_at,now()) where id=target.id;
  return target.id;
end $$;
revoke all on function public.revoke_clinic_member(uuid) from public, anon;
grant execute on function public.revoke_clinic_member(uuid) to authenticated;

-- Read only the current clinic's directory. No tokens, password hashes,
-- user metadata, global Auth directory or exact expiry claims are exposed.
create or replace function public.clinic_team_members()
returns table(id uuid, full_name text, email text, role public.profile_role,
  revoked_at timestamptz, invite_status text, invited_at timestamptz, invite_accepted_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if public.current_profile_role() is null
     or public.current_profile_role() not in ('owner','manager') then
    raise exception 'Not authorized to view clinic accounts' using errcode='42501';
  end if;
  return query select p.id,p.full_name,p.email,p.role,p.revoked_at,
    case when p.revoked_at is not null then 'revoked'
      when u.invited_at is not null and u.email_confirmed_at is null then 'pending'
      when u.invited_at is not null then 'accepted' else 'active' end,
    u.invited_at, case when u.invited_at is not null then u.email_confirmed_at else null end
    from public.profiles p join auth.users u on u.id=p.auth_user_id
    where p.clinic_id=public.current_clinic_id() order by p.full_name,p.id;
end $$;
revoke all on function public.clinic_team_members() from public, anon;
grant execute on function public.clinic_team_members() to authenticated;

-- Called only by the authenticated Edge boundary with its verified subject.
-- Actor/membership checks happen again inside the database, under row locks.
-- Reject existing linked/confirmed identities before Auth generates (and could
-- rotate) an invitation belonging to another clinic. Only a boolean is returned.
create or replace function public.owner_invite_email_available(p_actor_auth_id uuid, p_email text)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare actor public.profiles%rowtype;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  select * into actor from public.profiles where auth_user_id=p_actor_auth_id for update;
  if actor.id is null or actor.role <> 'owner' or actor.revoked_at is not null then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  return not exists (select 1 from public.profiles p left join auth.users u on u.id=p.auth_user_id
    where lower(p.email)=lower(trim(p_email)) or lower(u.email)=lower(trim(p_email)))
    and not exists (select 1 from auth.users u where lower(u.email)=lower(trim(p_email))
      and u.email_confirmed_at is not null);
end $$;
revoke all on function public.owner_invite_email_available(uuid,text) from public, anon, authenticated;
grant execute on function public.owner_invite_email_available(uuid,text) to service_role;

create or replace function public.owner_invite_clinic_member(
  p_actor_auth_id uuid, p_auth_user_id uuid, p_email text, p_full_name text,
  p_role public.profile_role
) returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare actor public.profiles%rowtype; target public.profiles%rowtype; result uuid;
begin
  if coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  select * into actor from public.profiles where auth_user_id=p_actor_auth_id for update;
  if actor.id is null or actor.role <> 'owner' or actor.revoked_at is not null
     or p_role is null or p_role not in ('manager','staff') then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  -- Lock before checking confirmation to avoid attaching a concurrently changed
  -- identity. No Auth-user row is updated by this RPC.
  perform 1 from auth.users where id=p_auth_user_id for update;
  if p_full_name is null or length(trim(p_full_name)) not between 1 and 200 or not exists (
    select 1 from auth.users u where u.id=p_auth_user_id
      and lower(u.email)=lower(trim(p_email)) and u.email_confirmed_at is null
  ) then raise exception 'Invitation unavailable' using errcode='42501'; end if;
  -- Serialize competing invitations to the same identity across clinics.
  select * into target from public.profiles where auth_user_id=p_auth_user_id for update;
  if target.id is not null then
    if target.clinic_id <> actor.clinic_id or target.revoked_at is not null
       or target.role='owner' then
      raise exception 'Invitation unavailable' using errcode='42501';
    end if;
    -- Retry/resend never overwrites existing membership, identity or role.
    return target.id;
  end if;
  insert into public.profiles(auth_user_id,clinic_id,email,full_name,role)
    values(p_auth_user_id,actor.clinic_id,lower(trim(p_email)),trim(p_full_name),p_role)
    returning profiles.id into result;
  return result;
end $$;
revoke all on function public.owner_invite_clinic_member(uuid,uuid,text,text,public.profile_role)
  from public, anon, authenticated;
grant execute on function public.owner_invite_clinic_member(uuid,uuid,text,text,public.profile_role)
  to service_role;

-- Shared admission and persistent email ownership. Claims never expire across
-- clinics: a timed-out Auth operation cannot later rotate another clinic's link.
-- Only the attempt lease expires, permitting bounded same-clinic recovery.
create table if not exists public.clinic_invitation_claims (
  email text primary key check (email=lower(trim(email)) and length(email) between 3 and 254),
  clinic_id uuid not null references public.clinics(id),
  attempt_token uuid,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  email_window timestamptz not null default now(),
  email_attempts integer not null default 0
);
create unique index if not exists clinic_invitation_attempt_token on public.clinic_invitation_claims(attempt_token) where attempt_token is not null;
create index if not exists profiles_invitation_email on public.profiles(lower(email));
create table if not exists public.clinic_invitation_budgets (
  scope text not null check(scope in ('clinic','owner')),
  scope_id uuid not null,
  window_start timestamptz not null default now(),
  attempts integer not null default 0,
  primary key(scope,scope_id)
);
alter table public.clinic_invitation_claims enable row level security;
alter table public.clinic_invitation_budgets enable row level security;
revoke all on public.clinic_invitation_claims,public.clinic_invitation_budgets from public,anon,authenticated;
grant select,insert,update,delete on public.clinic_invitation_claims,public.clinic_invitation_budgets to service_role;

create or replace function public.take_clinic_invitation_budget(p_scope text,p_id uuid,p_limit integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp
as $$ declare used integer; begin
  insert into public.clinic_invitation_budgets as b(scope,scope_id,window_start,attempts)
    values(p_scope,p_id,clock_timestamp(),1)
  on conflict(scope,scope_id) do update set
    window_start=case when b.window_start<=clock_timestamp()-interval '1 hour' then clock_timestamp() else b.window_start end,
    attempts=case when b.window_start<=clock_timestamp()-interval '1 hour' then 1 else least(b.attempts+1,p_limit+1) end
  returning attempts into used;
  return used<=p_limit;
end $$;
revoke all on function public.take_clinic_invitation_budget(text,uuid,integer) from public,anon,authenticated,service_role;

create or replace function public.reserve_clinic_invitation(
  p_actor_auth_id uuid,p_clinic_id uuid,p_email text,p_action text,p_profile_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp set lock_timeout='2s'
as $$
declare actor public.profiles%rowtype; target public.profiles%rowtype;
  claim public.clinic_invitation_claims%rowtype; mail text; clinic uuid; token uuid;
  uid uuid; confirmed timestamptz;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if p_actor_auth_id is not null then
    select * into actor from public.profiles where auth_user_id=p_actor_auth_id for update;
    if actor.id is null or actor.role<>'owner' or actor.revoked_at is not null
       or p_action not in ('invite','resend') or p_action is null
       or (p_clinic_id is not null and p_clinic_id<>actor.clinic_id) then
      return jsonb_build_object('code','not_authorized');
    end if;
    clinic:=actor.clinic_id;
  else
    -- Explicit operator provisioning only; no browser can execute this RPC.
    if p_action not in ('operator_invite','operator_associate') or p_action is null then
      return jsonb_build_object('code','not_authorized');
    end if;
    clinic:=p_clinic_id;
  end if;
  if not exists(select 1 from public.clinics where id=clinic) then
    return jsonb_build_object('code','invite_unavailable');
  end if;
  -- Atomic row UPSERTs serialize budgets across all function instances.
  if not public.take_clinic_invitation_budget('clinic',clinic,60) then
    return jsonb_build_object('code','rate_limited');
  end if;
  if p_actor_auth_id is not null and not public.take_clinic_invitation_budget('owner',p_actor_auth_id,30) then
    return jsonb_build_object('code','rate_limited');
  end if;
  if p_action='resend' then
    select * into target from public.profiles where id=p_profile_id and clinic_id=clinic;
    if target.id is null or target.role='owner' or target.revoked_at is not null then
      return jsonb_build_object('code','not_authorized');
    end if;
    mail:=lower(trim(target.email));
  else mail:=lower(trim(p_email)); end if;
  if mail is null or length(mail) not between 3 and 254 or mail !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    return jsonb_build_object('code','invalid_input');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('apero-invitation:'||mail,0));
  -- The insertion guard takes this same email lock, so a concurrent profile
  -- cannot claim an identity between this check and persistent reservation.
  select u.id,u.email_confirmed_at into uid,confirmed from auth.users u where lower(u.email)=mail;
  select * into target from public.profiles p where lower(p.email)=mail or p.auth_user_id=uid limit 1;
  if target.id is not null then
    if target.clinic_id<>clinic then return jsonb_build_object('code','invite_unavailable'); end if;
    if p_action='invite' then
      return jsonb_build_object('code',case when target.revoked_at is not null then 'access_revoked'
        when confirmed is null then 'invite_pending' else 'already_member' end);
    end if;
    if p_action='resend' and (target.id<>p_profile_id or target.role='owner' or target.revoked_at is not null) then
      return jsonb_build_object('code','not_authorized');
    end if;
  elsif p_action='resend' then return jsonb_build_object('code','not_authorized'); end if;
  if confirmed is not null and p_action<>'operator_associate' then
    return jsonb_build_object('code',case when p_action='resend' then 'already_member' else 'invite_unavailable' end);
  end if;
  insert into public.clinic_invitation_claims(email,clinic_id) values(mail,clinic) on conflict(email) do nothing;
  select * into claim from public.clinic_invitation_claims where email=mail for update;
  if claim.clinic_id<>clinic then return jsonb_build_object('code','invite_unavailable'); end if;
  -- Never reveal a foreign identity's cooldown or Auth state.
  if claim.lease_until>clock_timestamp() or
     (p_actor_auth_id is not null and claim.last_attempt_at>clock_timestamp()-interval '60 seconds') then
    return jsonb_build_object('code','invite_recent');
  end if;
  if claim.email_window<=clock_timestamp()-interval '1 hour' then
    claim.email_window:=clock_timestamp(); claim.email_attempts:=0;
  end if;
  if claim.email_attempts>=5 then return jsonb_build_object('code','rate_limited'); end if;
  token:=gen_random_uuid();
  update public.clinic_invitation_claims set attempt_token=token,
    lease_until=clock_timestamp()+interval '90 seconds',last_attempt_at=clock_timestamp(),
    email_window=claim.email_window,email_attempts=claim.email_attempts+1 where email=mail;
  return jsonb_build_object('code','ready','token',token,'clinic_id',clinic,'email',mail,
    'auth_user_id',case when p_action='resend' then target.auth_user_id else null end,
    'profile_id',case when p_action='resend' then target.id else null end,
    'full_name',case when p_action='resend' then target.full_name else null end,
    'role',case when p_action='resend' then target.role else null end);
end $$;
revoke all on function public.reserve_clinic_invitation(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.reserve_clinic_invitation(uuid,uuid,text,text,uuid) to service_role;

create or replace function public.finish_clinic_invitation(p_token uuid)
returns void language plpgsql security definer set search_path=public,pg_temp
as $$ begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Not authorized' using errcode='42501'; end if;
  update public.clinic_invitation_claims set attempt_token=null,lease_until=null where attempt_token=p_token;
end $$;
revoke all on function public.finish_clinic_invitation(uuid) from public,anon,authenticated;
grant execute on function public.finish_clinic_invitation(uuid) to service_role;

create or replace function public.guard_clinic_invitation_claim()
returns trigger language plpgsql security definer set search_path=public,pg_temp set lock_timeout='2s'
as $$ declare mail text; claimed uuid; begin
  -- Prefer authoritative Auth email; also defend the profile's stored email.
  select lower(trim(email)) into mail from auth.users where id=new.auth_user_id;
  perform pg_advisory_xact_lock(hashtextextended('apero-invitation:'||lower(trim(new.email)),0));
  select clinic_id into claimed from public.clinic_invitation_claims where email=lower(trim(new.email));
  if claimed is not null and claimed<>new.clinic_id then raise exception 'Invitation unavailable' using errcode='42501'; end if;
  if mail is not null and mail<>lower(trim(new.email)) then
    perform pg_advisory_xact_lock(hashtextextended('apero-invitation:'||mail,0));
    select clinic_id into claimed from public.clinic_invitation_claims where email=mail;
    if claimed is not null and claimed<>new.clinic_id then raise exception 'Invitation unavailable' using errcode='42501'; end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_clinic_invitation_claim() from public,anon,authenticated,service_role;
drop trigger if exists guard_clinic_invitation_claim on public.profiles;
create trigger guard_clinic_invitation_claim before insert or update of email,clinic_id,auth_user_id on public.profiles
  for each row execute function public.guard_clinic_invitation_claim();

notify pgrst, 'reload schema';
commit;
