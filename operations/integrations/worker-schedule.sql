-- Operator template: release authorization and successful synthetic acceptance required.
-- Replace CONNECTION_UUID and SYNTHETIC_CALENDAR_ID with the approved mapping.
-- Never include a bearer token in cron.command. Vault holds the existing worker URL/secret.
-- Free included invocation quota and Google daily request threshold must be checked first.
begin;
create extension if not exists pg_net with schema extensions;
select cron.schedule('apero-integrations-worker','* * * * *', $job$select public.integration_scheduled_sync('CONNECTION_UUID','SYNTHETIC_CALENDAR_ID')$job$);
commit;
-- Pause first during rollback: select cron.unschedule('apero-integrations-worker');
-- Encrypted recovery requires INTEGRATION_RECOVERY_CONFIG pointing to the verified
-- age-encrypted integration settings; Vault/net transient queues are reconstructed,
-- never silently omitted. See CALENDAR_CONNECTION_FIX.md.
