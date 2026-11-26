-- #110 P4C: version live tip-expiry sweep + has_work into migrations (DR / drift).
-- Behaviour unchanged: has_work EXISTS gate before Edge invoke; 5s cron remains
-- in 20261126160000_tip_expiry_sweep_5s_immediate_credit_110.sql.
-- Partial index idx_trips_tip_window_expiry_open already exists in production.

CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.status = 'completed'
      AND t.tip_window_expires_at IS NOT NULL
      AND t.tip_window_expires_at < now()
      AND t.tip_window_closed_at IS NULL
      AND (
        (
          (t.provider_order_id IS NOT NULL OR t.payment_intent_id IS NOT NULL)
          AND t.payment_status IN (
            'preauth_created',
            'preauth_authorized',
            'preauth_authorised',
            'authorized',
            'authorised',
            'preauth_updated',
            'capture_requested',
            'capture_failed',
            'payment_shortfall',
            'recovery_required'
          )
        )
        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
      )
    LIMIT 1
  );
$$;

CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_capture_expired_tip_windows_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/capture-expired-tip-windows'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF NOT public.capture_expired_tip_windows_sweep_has_work() THEN
    RETURN;
  END IF;

  IF v_url IS NULL OR length(trim(v_url)) < 20 OR v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[capture-expired-tip-windows] sweep aborted reason=bad_url_or_token';
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
      body := jsonb_build_object('source', 'pg_cron', 'sweep_at', now()::text)
    );
    RAISE LOG '[capture-expired-tip-windows] edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[capture-expired-tip-windows] edge_invoke_failed url=% sqlerrm=% sqlstate=%',
      v_url, SQLERRM, SQLSTATE;
  END;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_trips_tip_window_expiry_open
  ON public.trips (tip_window_expires_at)
  WHERE tip_window_status = 'open'
    AND tip_window_closed_at IS NULL
    AND status = 'completed';

REVOKE ALL ON FUNCTION public.capture_expired_tip_windows_sweep_has_work() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capture_expired_tip_windows_sweep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capture_expired_tip_windows_sweep_has_work() TO service_role;
GRANT EXECUTE ON FUNCTION public.capture_expired_tip_windows_sweep() TO service_role;
