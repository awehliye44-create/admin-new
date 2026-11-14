-- Customer Live Trip — platform gates, APNs environment, ETA refresh cron.
-- Presentation only. Does not mutate trip lifecycle, dispatch, fare, or payment.

ALTER TABLE public.customer_live_trip_settings
  ADD COLUMN IF NOT EXISTS android_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ios_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.customer_live_trip_settings.android_enabled IS
  'Android Live Updates fanout when global enabled. Independent of iOS APNs readiness.';
COMMENT ON COLUMN public.customer_live_trip_settings.ios_enabled IS
  'iOS ActivityKit APNs fanout when global enabled AND APNs credentials are configured.';

ALTER TABLE public.customer_live_activity_tokens
  ADD COLUMN IF NOT EXISTS apns_environment text NULL;

COMMENT ON COLUMN public.customer_live_activity_tokens.apns_environment IS
  'Optional APNs environment hint: production | sandbox. Server may fall back across hosts.';

-- ETA refresh sweep — reuses existing route cache via Edge; no Google/Mapbox from SQL.
CREATE OR REPLACE FUNCTION public.customer_live_trip_eta_refresh_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_customer_live_trip_eta_refresh_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/refresh-customer-live-trip-etas'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[customer-live-trip-eta] sweep aborted reason=bad_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token
      ),
      body := jsonb_build_object('source', 'pg_cron'),
      timeout_milliseconds := 60000
    );
    RAISE LOG '[customer-live-trip-eta] sweep enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[customer-live-trip-eta] sweep failed sqlerrm=%', SQLERRM;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.customer_live_trip_eta_refresh_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_live_trip_eta_refresh_sweep() TO service_role;

DO $schedule$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed - customer live trip ETA refresh schedule skipped';
    RETURN;
  END IF;

  BEGIN
    PERFORM cron.unschedule('customer-live-trip-eta-refresh');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- Every minute; publish coalesces routine updates to ~35s.
  PERFORM cron.schedule(
    'customer-live-trip-eta-refresh',
    '* * * * *',
    'SELECT public.customer_live_trip_eta_refresh_sweep();'
  );
END
$schedule$;
