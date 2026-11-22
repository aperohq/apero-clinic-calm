-- RELEASE APPROVAL REQUIRED. This is an operator template, not a migration.
-- Prerequisites: integration-worker deployed and INTEGRATIONS_ENABLED=true;
-- vault entries named apero_integration_worker_url and apero_integration_worker_secret.
-- URL must be the reviewed project /functions/v1/integration-worker endpoint.
-- pg_net calls may consume billable Edge quota. Do not execute without release approval.
begin;
create extension if not exists pg_net with schema extensions;
select cron.schedule('apero-integrations-worker','* * * * *', $job$
 select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name='apero_integration_worker_url'),
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='apero_integration_worker_secret')),
  body := '{}'::jsonb,
  timeout_milliseconds := 55000
 );
$job$);
commit;
-- Stop scheduling first during rollback:
-- select cron.unschedule('apero-integrations-worker');
