-- P0 Finance SSOT: automatic weekly payout scheduler.
-- Invokes admin-weekly-monday-settlement every 15 minutes.
-- Edge function soft-skips when paused, wrong day/time, manual_only, or batch already exists.

BEGIN;

CREATE OR REPLACE FUNCTION public.invoke_weekly_payout_scheduler()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_weekly_payout_scheduler_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/admin-weekly-monday-settlement'
  );
  v_token text := public.cron_edge_auth_token();
  v_cron_secret text := coalesce(
    nullif(trim(current_setting('app.settings.cron_secret', true)), ''),
    nullif(trim(current_setting('app.settings.onecab_internal_finalize_secret', true)), '')
  );
BEGIN
  IF v_url IS NULL OR length(trim(v_url)) < 20 OR v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[weekly-payout-scheduler] aborted reason=bad_url_or_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_strip_nulls(jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token,
        'x-onecab-cron-secret', CASE
          WHEN v_cron_secret IS NOT NULL AND length(trim(v_cron_secret)) >= 20 THEN v_cron_secret
          ELSE NULL
        END
      )),
      body := jsonb_strip_nulls(jsonb_build_object(
        'scheduled', true,
        'source', 'pg_cron',
        'cron_secret', CASE
          WHEN v_cron_secret IS NOT NULL AND length(trim(v_cron_secret)) >= 20 THEN v_cron_secret
          ELSE NULL
        END
      ))
    );
    RAISE LOG '[weekly-payout-scheduler] edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[weekly-payout-scheduler] edge_invoke_failed url=% sqlerrm=% sqlstate=%', v_url, SQLERRM, SQLSTATE;
  END;
END;
$fn$;

COMMENT ON FUNCTION public.invoke_weekly_payout_scheduler() IS
  'pg_cron: invoke admin-weekly-monday-settlement (scheduled=true). Edge soft-skips off-schedule.';

SELECT cron.schedule(
  'weekly-payout-scheduler',
  '*/15 * * * *',
  $$SELECT public.invoke_weekly_payout_scheduler();$$
);

COMMIT;
