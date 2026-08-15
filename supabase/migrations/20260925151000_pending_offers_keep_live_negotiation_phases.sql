-- Keep live negotiation retrievable after the previous deadline even when
-- the offer row is still pending (not only countered). Idle pending NROs
-- still require expires_at > now().

CREATE OR REPLACE FUNCTION public.get_driver_pending_ride_offers()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'offer', row_to_json(ro)::jsonb,
      'trip', row_to_json(t)::jsonb
    )
    ORDER BY ro.created_at DESC
  ), '[]'::jsonb)
  FROM public.ride_offers ro
  INNER JOIN public.trips t ON t.id = ro.trip_id
  WHERE ro.driver_id = (SELECT d.id FROM public.drivers d WHERE d.user_id = auth.uid() LIMIT 1)
    AND ro.status IN ('pending', 'countered')
    AND (
      ro.expires_at > now()
      OR ro.negotiation_status IN (
        'waiting_customer',
        'waiting_driver',
        'waiting_driver_final',
        'declined_customer_awaiting_driver'
      )
    );
$function$;
