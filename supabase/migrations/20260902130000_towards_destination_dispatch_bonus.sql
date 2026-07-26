-- Towards Destination — dispatch priority bonus helper (Gap 1)
-- Soft scoring: compatible dropoffs get a bounded bonus; incompatible stay eligible.
-- Does not change fare / commission / earnings.
--
-- ROLLBACK: DROP FUNCTION public.towards_destination_priority_bonus(...);

CREATE OR REPLACE FUNCTION public.towards_destination_priority_bonus(
  p_dropoff_lat double precision,
  p_dropoff_lng double precision,
  p_dest_lat double precision,
  p_dest_lng double precision,
  p_active boolean,
  p_expires_at timestamptz,
  p_enabled boolean,
  p_tolerance_meters numeric,
  p_priority_weight numeric
)
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

REVOKE ALL ON FUNCTION public.towards_destination_priority_bonus(
  double precision, double precision, double precision, double precision,
  boolean, timestamptz, boolean, numeric, numeric
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.towards_destination_priority_bonus(
  double precision, double precision, double precision, double precision,
  boolean, timestamptz, boolean, numeric, numeric
) TO authenticated, service_role;

COMMENT ON FUNCTION public.towards_destination_priority_bonus(
  double precision, double precision, double precision, double precision,
  boolean, timestamptz, boolean, numeric, numeric
) IS
  'Bounded dispatch score bonus when trip dropoff is within tolerance of an active unexpired towards destination. Returns 0 (never hard-excludes).';
