-- Run after the two additive migrations pass isolated validation.
begin;
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('apero-retention-daily', '23 2 * * *', 'select public.retention_daily()');
commit;
-- Global dry_run gate prevents patient deletion. Monitor cron.job_run_details.
