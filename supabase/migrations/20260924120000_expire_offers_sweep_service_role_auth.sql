-- expire_offers_sweep must authenticate expire-offers with the vault service-role
-- token (cron_edge_auth_token), never a hardcoded anon/fallback JWT.
-- Sequencing / wave SQL is unchanged. Work-gate and 10s cadence are unchanged.

CREATE OR REPLACE FUNCTION public.expire_offers_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_expire_offers_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/expire-offers'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  -- Work-gate: only invoke Edge when there is something to expire or advance.
  IF NOT EXISTS (
    SELECT 1
    FROM public.ride_offers ro
    WHERE ro.status = 'pending'
      AND ro.expires_at IS NOT NULL
      AND ro.expires_at <= now()
    LIMIT 1
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.status IN ('searching', 'offered', 'searching_new_driver', 'pending')
      AND t.dispatch_status = 'broadcasting'
      AND COALESCE(t.driver_id, t.confirmed_driver_id) IS NULL
      AND t.searching_expires_at IS NOT NULL
      AND t.searching_expires_at > now()
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = t.id AND ro.status IN ('pending', 'countered')
      )
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

  IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RAISE LOG '[delivery] expire_offers_sweep aborted reason=bad_url';
    RETURN;
  END IF;

  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[delivery] expire_offers_sweep aborted reason=bad_token';
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
      body := '{}'::jsonb
    );
    RAISE LOG '[delivery] expire_offers_sweep edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[delivery] expire_offers_sweep edge_invoke_failed url=% sqlerrm=% sqlstate=%', v_url, SQLERRM, SQLSTATE;
  END;
END;
$function$;
