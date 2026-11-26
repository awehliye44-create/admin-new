-- #100A — cron advances pickup waiting SSOT without Driver app dependency.
-- Apply AFTER advance-active-waiting-ssot is deployed.

DO $$
DECLARE
  v_job_name text := 'advance-active-waiting-ssot-every-1-min';
  v_existing bigint;
BEGIN
  SELECT jobid INTO v_existing FROM cron.job WHERE jobname = v_job_name LIMIT 1;
  IF FOUND THEN
    RAISE NOTICE 'pg_cron job % already exists (jobid=%), skipping.', v_job_name, v_existing;
    RETURN;
  END IF;

  PERFORM cron.schedule(
    v_job_name,
    '* * * * *',
    $cron_cmd$
    SELECT net.http_post(
      url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/advance-active-waiting-ssot',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret FROM vault.decrypted_secrets
          WHERE name = 'service_role_key' LIMIT 1
        )
      ),
      body := '{"source":"pg_cron","limit":20}'::jsonb,
      timeout_milliseconds := 25000
    );
    $cron_cmd$
  );
END;
$$;
