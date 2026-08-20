-- Migration: 20260929160000_reconcile_poller_cron_schedule.sql
-- Purpose: Create exactly one pg_cron job that invokes the reconcile-submitted-driver-withdrawals
--          Edge function every 2 minutes via net.http_post. The bearer credential is pulled
--          from Vault at call-time — no plaintext secret in this file or in cron.job.command.
--
-- Idempotent: aborts gracefully if the named job already exists.
-- Safe: does not unschedule any other cron jobs.
-- Scope: scheduling only — no financial rows, no payout/reservation/wallet changes.

DO $$
DECLARE
  v_job_name  TEXT  := 'reconcile-submitted-driver-withdrawals-every-2-min';
  v_existing  BIGINT;
BEGIN
  -- Guard: abort silently if the job already exists (idempotent re-runs).
  SELECT jobid INTO v_existing
  FROM cron.job
  WHERE jobname = v_job_name
  LIMIT 1;

  IF FOUND THEN
    RAISE NOTICE 'pg_cron job % already exists (jobid=%), skipping creation.', v_job_name, v_existing;
    RETURN;
  END IF;

  -- Schedule the job.  The command uses vault.decrypted_secrets at call-time so the
  -- bearer token is NEVER embedded in the cron command text itself.
  PERFORM cron.schedule(
    v_job_name,
    '*/2 * * * *',
    $cron_cmd$
    SELECT net.http_post(
      url     := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/reconcile-submitted-driver-withdrawals',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'Authorization', 'Bearer ' || (
                     SELECT decrypted_secret
                     FROM   vault.decrypted_secrets
                     WHERE  name = 'service_role_key'
                     LIMIT  1
                   )
                 ),
      body    := '{"dry_run":false,"source":"pg_cron"}'::jsonb,
      timeout_milliseconds := 25000
    );
    $cron_cmd$
  );

  RAISE NOTICE 'pg_cron job % created successfully.', v_job_name;
END;
$$;

-- Register in migration history
INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260929160000')
ON CONFLICT DO NOTHING;

-- Verify: exactly one active job with expected name
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM cron.job
  WHERE jobname = 'reconcile-submitted-driver-withdrawals-every-2-min'
    AND active = true;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Post-migration check failed: expected 1 active cron job, found %', v_count;
  END IF;
  RAISE NOTICE 'Post-migration verification PASSED: 1 active cron job confirmed.';
END;
$$;
