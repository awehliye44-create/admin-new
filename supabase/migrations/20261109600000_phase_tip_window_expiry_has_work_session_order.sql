-- Expired tip windows whose only payment identity is payment_session_id
-- never woke the sweep. Capture needs the session's provider_order_id, and
-- the invoice stays blocked until the window closes.

CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.status = 'completed'
      AND t.tip_window_expires_at IS NOT NULL
      AND t.tip_window_expires_at < now()
      AND t.tip_window_closed_at IS NULL
      AND (
        (
          (
            t.provider_order_id IS NOT NULL
            OR t.payment_intent_id IS NOT NULL
            OR t.payment_session_id IS NOT NULL
          )
          AND t.payment_status IN (
            'preauth_created',
            'preauth_authorized',
            'preauth_authorised',
            'authorized',
            'authorised',
            'preauth_updated',
            'capture_requested',
            'capture_failed',
            'pending',
            'payment_shortfall',
            'recovery_required'
          )
        )
        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
        OR t.payment_status IN ('canceled', 'cancelled', 'released')
      )
    LIMIT 1
  );
$function$;
