-- Schedule provider-neutral trip communication timeout sweep (VoIP + MSG91).
-- Authoritative max duration is 240s in Edge code; this job reconciles expired sessions.

BEGIN;

CREATE OR REPLACE FUNCTION public.invoke_trip_communication_timeout_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_trip_communication_timeout_sweep_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/trip-communication-timeout-sweep'
  );
  v_token text := public.cron_edge_auth_token();
  v_cron_secret text := coalesce(
    nullif(trim(current_setting('app.settings.cron_secret', true)), ''),
    nullif(trim(current_setting('app.settings.onecab_internal_finalize_secret', true)), '')
  );
BEGIN
  IF v_url IS NULL OR length(trim(v_url)) < 20 OR v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[trip-communication-timeout-sweep] aborted reason=bad_url_or_token';
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
        'source', 'pg_cron',
        'cron_secret', CASE
          WHEN v_cron_secret IS NOT NULL AND length(trim(v_cron_secret)) >= 20 THEN v_cron_secret
          ELSE NULL
        END
      ))
    );
    RAISE LOG '[trip-communication-timeout-sweep] edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[trip-communication-timeout-sweep] edge_invoke_failed url=% sqlerrm=% sqlstate=%',
      v_url, SQLERRM, SQLSTATE;
  END;
END;
$fn$;

COMMENT ON FUNCTION public.invoke_trip_communication_timeout_sweep() IS
  'pg_cron: invoke trip-communication-timeout-sweep for VoIP + call-masking 240s expiry.';

DO $$
BEGIN
  PERFORM cron.unschedule('trip-communication-timeout-sweep');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'trip-communication-timeout-sweep',
  '* * * * *',
  $$SELECT public.invoke_trip_communication_timeout_sweep();$$
);

COMMIT;
