begin;
create or replace function public.integration_notify(p_channel uuid,p_hash text,p_resource text,p_number numeric,p_state text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.calendar_connections%rowtype; begin
 select * into c from public.calendar_connections where channel_id=p_channel and channel_hash=p_hash and status<>'disconnected' and channel_expires_at>now() for update;
 if c.id is null or p_state not in ('sync','exists','not_exists') or p_number<=0 then return false; end if;
 -- Initial sync may arrive while events.watch is still returning the resource ID.
 if c.resource_id is null and p_state='sync' then return true; end if;
 if c.resource_id is distinct from p_resource then return false; end if;
 if p_number<=c.message_number then return true; end if;
 update public.calendar_connections set message_number=p_number,last_synced_at=null where id=c.id;
 perform public.integration_enqueue(c.id,'pull','calendar'); return true;
end $$;
commit;
