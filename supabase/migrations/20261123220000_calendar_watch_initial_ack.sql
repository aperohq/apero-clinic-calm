begin;
-- Google sync/1 acknowledges a new watch; it is not an event change. It can
-- arrive before OR after events.watch returns. Keep token/resource/sequence
-- verification, but invalidate availability only for actual change messages.
create or replace function public.integration_notify(p_channel uuid,p_hash text,p_resource text,p_number numeric,p_state text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; begin
 select * into c from public.calendar_connections where channel_id=p_channel and channel_hash=p_hash and status<>'disconnected' and channel_expires_at>now() for update;
 if c.id is null or p_state not in ('sync','exists','not_exists') or (p_number<=0 or (p_state='sync' and p_number<>1)) then return false; end if;
 -- Initial sync may arrive while events.watch is still returning the resource ID.
 if c.resource_id is null and p_state='sync' then return true; end if;
 if c.resource_id is distinct from p_resource then return false; end if;
 if p_number<=c.message_number then return true; end if;
 update public.calendar_connections set message_number=p_number,last_synced_at=case when p_state='sync' then last_synced_at else null end where id=c.id;
 if p_state<>'sync' then perform public.integration_enqueue(c.id,'pull','calendar'); end if; return true;
end $$;
commit;
