
-- Schedule daily cleanup at 3 AM UTC
SELECT cron.schedule(
  'ops-cleanup-daily',
  '0 3 * * *',
  $$ SELECT public.ops_cleanup_old_data(); $$
);
