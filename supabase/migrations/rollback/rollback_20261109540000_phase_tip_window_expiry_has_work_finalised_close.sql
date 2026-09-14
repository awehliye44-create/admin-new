-- Restore has_work to uncapped-only (20261109530000).

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
      AND t.provider_order_id IS NOT NULL
      AND t.tip_window_expires_at IS NOT NULL
      AND t.tip_window_expires_at < now()
      AND t.tip_window_closed_at IS NULL
      AND t.payment_status IN (
        'preauth_created',
        'preauth_authorized',
        'preauth_authorised',
        'authorized',
        'authorised',
        'preauth_updated',
        'capture_requested',
        'capture_failed'
      )
    LIMIT 1
  );
$function$;
