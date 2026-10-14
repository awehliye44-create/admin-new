-- Health watch for reconcile-waiting-shortfall-markers.
-- NOT applied. Do not db push until this branch is approved.
-- Reads the latest recovery HTTP result. Inserts one open ops alert if that
-- result is missing, stale, or not ok. Does not capture, increment, or write
-- a receivable, a wallet row, or a payout.

DO $$
DECLARE
  v_job_name text := 'shortfall-recovery-job-health-every-5-min';
  v_existing bigint;
BEGIN
  SELECT jobid INTO v_existing FROM cron.job WHERE jobname = v_job_name LIMIT 1;
  IF FOUND THEN
    RAISE NOTICE 'pg_cron job % already exists (jobid=%), skipping.', v_job_name, v_existing;
    RETURN;
  END IF;

  PERFORM cron.schedule(
    v_job_name,
    '2-59/5 * * * *',
    $cron_cmd$
    INSERT INTO public.ops_alerts (
      fingerprint, category, severity, status, source, title, description, metadata
    )
    SELECT
      'finance:shortfall_recovery_job_unhealthy',
      'payment',
      'critical',
      'open',
      'system',
      'Waiting shortfall recovery job needs attention',
      'The five-minute recovery call did not return ok within 12 minutes.',
      jsonb_build_object('money_moved', false, 'provider_called', false)
    WHERE NOT EXISTS (
      SELECT 1
      FROM net._http_response
      WHERE content LIKE '%"money_moved":false%'
        AND content LIKE '%"provider_called":false%'
        AND content LIKE '%"examined":%'
        AND status_code = 200
        AND created >= now() - interval '12 minutes'
        AND coalesce(content::jsonb->>'ok', '') = 'true'
    )
    ON CONFLICT DO NOTHING;
    $cron_cmd$
  );
END;
$$;
