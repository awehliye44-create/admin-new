-- Schedule recovery of waiting-time shortfall markers.
-- Apply ONLY after reconcile-waiting-shortfall-markers is deployed.
-- The job calls that function. It does not capture, increment, or insert a receivable itself.
-- Bearer comes from Vault at call time. Idempotent if the job already exists.

DO $$
DECLARE
  v_job_name text := 'reconcile-waiting-shortfall-markers-every-5-min';
  v_existing bigint;
BEGIN
  SELECT jobid INTO v_existing FROM cron.job WHERE jobname = v_job_name LIMIT 1;
  IF FOUND THEN
    RAISE NOTICE 'pg_cron job % already exists (jobid=%), skipping.', v_job_name, v_existing;
    RETURN;
  END IF;

  PERFORM cron.schedule(
    v_job_name,
    '*/5 * * * *',
    $cron_cmd$
    SELECT net.http_post(
      url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/reconcile-waiting-shortfall-markers',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret FROM vault.decrypted_secrets
          WHERE name = 'service_role_key' LIMIT 1
        )
      ),
      body := '{"source":"pg_cron"}'::jsonb,
      timeout_milliseconds := 25000
    );
    $cron_cmd$
  );
END;
$$;
