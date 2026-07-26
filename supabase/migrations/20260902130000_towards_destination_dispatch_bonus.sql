-- Towards Destination soft priority bonus helper (Gap 1) — local snapshot of live production.
-- Already applied on remote; kept for checkout parity. Idempotent OR REPLACE.
-- ROLLBACK: DROP FUNCTION public.towards_destination_priority_bonus(...);

CREATE OR REPLACE FUNCTION public.towards_destination_priority_bonus(p_dropoff_lat double precision, p_dropoff_lng double precision, p_dest_lat double precision, p_dest_lng double precision, p_active boolean, p_expires_at timestamp with time zone, p_enabled boolean, p_tolerance_meters numeric, p_priority_weight numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dist numeric;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT COALESCE(p_enabled, true) THEN
    RETURN 0;
  END IF;
  IF NOT COALESCE(p_active, false) THEN
    RETURN 0;
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN
    RETURN 0;
  END IF;
  IF p_dropoff_lat IS NULL OR p_dropoff_lng IS NULL
     OR p_dest_lat IS NULL OR p_dest_lng IS NULL THEN
    RETURN 0;
  END IF;
  IF abs(p_dropoff_lat) > 90 OR abs(p_dropoff_lng) > 180
     OR abs(p_dest_lat) > 90 OR abs(p_dest_lng) > 180 THEN
    RETURN 0;
  END IF;
  IF (p_dest_lat = 0 AND p_dest_lng = 0) THEN
    RETURN 0;
  END IF;

  v_dist := public.haversine_meters(p_dropoff_lat, p_dropoff_lng, p_dest_lat, p_dest_lng);
  IF v_dist IS NULL OR v_dist > GREATEST(COALESCE(p_tolerance_meters, 3000), 0) THEN
    RETURN 0;
  END IF;

  RETURN GREATEST(LEAST(COALESCE(p_priority_weight, 12), 100), 0);
END;
$function$;
