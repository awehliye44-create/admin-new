-- #54D: pg_cron → reconcile-stranded-stacked-promotions every 2 minutes.
-- Apply AFTER the Edge function is deployed. Idempotent if job already exists.
-- Bearer from Vault at call time. Bounded batch inside the Edge function.
-- Safe where pg_cron is absent (local / CI Postgres harness): no-op unless cron schema exists.

DO $$
DECLARE
  v_job_name text := 'reconcile-stranded-stacked-promotions-every-2-min';
  v_existing bigint;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed — skip scheduling %', v_job_name;
    RETURN;
  END IF;

  SELECT jobid INTO v_existing FROM cron.job WHERE jobname = v_job_name LIMIT 1;
  IF FOUND THEN
    RAISE NOTICE 'pg_cron job % already exists (jobid=%), skipping.', v_job_name, v_existing;
    RETURN;
  END IF;

  PERFORM cron.schedule(
    v_job_name,
    '*/2 * * * *',
    $cron_cmd$
    SELECT net.http_post(
      url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/reconcile-stranded-stacked-promotions',
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
