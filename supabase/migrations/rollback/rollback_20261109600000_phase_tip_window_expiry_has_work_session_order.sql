-- Restore has_work without payment_session_id (20261109570000).

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
$function$;
