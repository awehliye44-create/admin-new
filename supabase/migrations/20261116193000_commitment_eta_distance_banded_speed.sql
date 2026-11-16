-- ============================================================
-- Commitment ETA: distance-banded average speed (MK-261116-009)
--
-- Flat 20 km/h + 1.45 road factor made ~21 km Westcroft→Aylesbury ≈ 91 min,
-- so accept-offer falsely returned SCHEDULED_COMMITMENT_INFEASIBLE ~60 min
-- before a confirmed scheduled pickup while the driver was offered a 6 min
-- local instant trip.
--
-- Mirrors Edge scheduledDispatchConfig.commitmentEtaAverageSpeedKmh /
-- estimateEtaMinutes. Does not change JIT activation flags.
-- ============================================================

CREATE OR REPLACE FUNCTION public.scheduled_commitment_estimate_eta_minutes(
  p_from_lat double precision,
  p_from_lng double precision,
  p_to_lat double precision,
  p_to_lng double precision
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_dlat double precision;
  v_dlng double precision;
  v_a double precision;
  v_km double precision;
  v_speed double precision;
BEGIN
  IF p_from_lat IS NULL OR p_from_lng IS NULL OR p_to_lat IS NULL OR p_to_lng IS NULL THEN
    RETURN NULL;
  END IF;
  v_dlat := radians(p_to_lat - p_from_lat);
  v_dlng := radians(p_to_lng - p_from_lng);
  v_a := power(sin(v_dlat / 2), 2)
    + cos(radians(p_from_lat)) * cos(radians(p_to_lat)) * power(sin(v_dlng / 2), 2);
  v_a := LEAST(1, GREATEST(0, v_a));
  v_km := 6371 * 2 * atan2(sqrt(v_a), sqrt(1 - v_a));
  -- Distance-banded average speed (km/h) — mirrors Edge commitmentEtaAverageSpeedKmh.
  IF v_km < 5 THEN
    v_speed := 20;
  ELSIF v_km < 15 THEN
    v_speed := 32;
  ELSIF v_km < 40 THEN
    v_speed := 45;
  ELSE
    v_speed := 55;
  END IF;
  -- road factor 1.45, min 3 minutes.
  RETURN GREATEST(3, CEIL((v_km * 1.45 / v_speed) * 60.0))::integer;
END;
$function$;

COMMENT ON FUNCTION public.scheduled_commitment_estimate_eta_minutes(double precision, double precision, double precision, double precision) IS
  'Haversine commitment ETA minutes; distance-banded speed (20/32/45/55 km/h) + 1.45 road factor. Mirrors Edge estimateEtaMinutes.';
