-- Bug #33B: authoritative GPS measurement time for passenger live location.
-- updated_at remains DB modification time (trigger). gps_recorded_at is the
-- phone fix time used for freshness and out-of-order rejection.
-- Backward compatible: older clients omit p_gps_recorded_at → fall back to
-- p_updated_at / now().

ALTER TABLE public.customer_live_locations
  ADD COLUMN IF NOT EXISTS gps_recorded_at timestamptz;

UPDATE public.customer_live_locations
SET gps_recorded_at = updated_at
WHERE gps_recorded_at IS NULL;

-- Replace upsert (add optional p_gps_recorded_at; drop prior 7-arg signature).
DROP FUNCTION IF EXISTS public.upsert_customer_live_location(
  uuid, double precision, double precision, double precision,
  double precision, double precision, timestamptz
);

CREATE OR REPLACE FUNCTION public.upsert_customer_live_location(
  p_trip_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy double precision DEFAULT NULL,
  p_heading double precision DEFAULT NULL,
  p_speed double precision DEFAULT NULL,
  p_updated_at timestamptz DEFAULT now(),
  p_gps_recorded_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_customer_id uuid;
  v_gps_at timestamptz;
BEGIN
  SELECT c.id INTO v_customer_id
  FROM public.customers c
  WHERE c.user_id = auth.uid()
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'not_a_customer';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.id = p_trip_id
      AND t.passenger_id = v_customer_id
      AND t.status IN (
        'accepted',
        'confirmed',
        'driver_assigned',
        'queued',
        'en_route',
        'en_route_to_pickup',
        'enroute_to_pickup',
        'driver_en_route',
        'driver_arriving',
        'arrived',
        'arrived_pickup',
        'arrived_at_pickup',
        'at_pickup',
        'pickup_waiting',
        'waiting'
      )
  ) THEN
    RAISE EXCEPTION 'trip_not_eligible_for_live_publish';
  END IF;

  -- Measurement time SSOT. Never invent from wall clock when a GPS stamp exists.
  v_gps_at := COALESCE(p_gps_recorded_at, p_updated_at, now());

  INSERT INTO public.customer_live_locations (
    trip_id,
    customer_id,
    latitude,
    longitude,
    accuracy,
    heading,
    speed,
    gps_recorded_at,
    updated_at
  ) VALUES (
    p_trip_id,
    v_customer_id,
    p_latitude,
    p_longitude,
    p_accuracy,
    p_heading,
    p_speed,
    v_gps_at,
    now()
  )
  ON CONFLICT (trip_id) DO UPDATE SET
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    accuracy = EXCLUDED.accuracy,
    heading = EXCLUDED.heading,
    speed = EXCLUDED.speed,
    gps_recorded_at = EXCLUDED.gps_recorded_at,
    updated_at = now()
  WHERE
    customer_live_locations.gps_recorded_at IS NULL
    OR EXCLUDED.gps_recorded_at >= customer_live_locations.gps_recorded_at;
END;
$function$;

-- Return type adds gps_recorded_at — must drop before recreate.
DROP FUNCTION IF EXISTS public.get_customer_live_for_driver(
  uuid, double precision, double precision
);

CREATE OR REPLACE FUNCTION public.get_customer_live_for_driver(
  p_trip_id uuid,
  p_driver_lat double precision,
  p_driver_lng double precision
)
RETURNS TABLE(
  latitude double precision,
  longitude double precision,
  accuracy double precision,
  heading double precision,
  speed double precision,
  updated_at timestamptz,
  gps_recorded_at timestamptz,
  is_fresh boolean,
  expires_at timestamptz,
  stale_after_seconds integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    cll.latitude,
    cll.longitude,
    cll.accuracy,
    cll.heading,
    cll.speed,
    cll.updated_at,
    cll.gps_recorded_at,
    (
      COALESCE(cll.gps_recorded_at, cll.updated_at)
        + make_interval(
            secs => COALESCE(sa.customer_location_stale_after_seconds, 90)
          )
    ) > now() AS is_fresh,
    (
      COALESCE(cll.gps_recorded_at, cll.updated_at)
        + make_interval(
            secs => COALESCE(sa.customer_location_stale_after_seconds, 90)
          )
    ) AS expires_at,
    COALESCE(sa.customer_location_stale_after_seconds, 90) AS stale_after_seconds
  FROM public.customer_live_locations cll
  INNER JOIN public.trips t ON t.id = cll.trip_id
  INNER JOIN public.drivers d ON (d.id = t.driver_id OR d.id = t.confirmed_driver_id)
  LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
  WHERE cll.trip_id = p_trip_id
    AND d.user_id = auth.uid()
    AND t.status IN (
      'accepted',
      'confirmed',
      'driver_assigned',
      'en_route',
      'driver_en_route',
      'en_route_to_pickup',
      'enroute_to_pickup',
      'driver_arriving',
      'queued',
      'arrived',
      'arrived_pickup',
      'arrived_at_pickup',
      'at_pickup',
      'pickup_waiting',
      'waiting'
    )
    AND p_driver_lat IS NOT NULL
    AND p_driver_lng IS NOT NULL
    AND t.pickup_latitude IS NOT NULL
    AND t.pickup_longitude IS NOT NULL
    AND public.haversine_meters(
          p_driver_lat, p_driver_lng,
          t.pickup_latitude, t.pickup_longitude
        ) <= 1127
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.upsert_customer_live_location(
  uuid, double precision, double precision, double precision,
  double precision, double precision, timestamptz, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_customer_live_location(
  uuid, double precision, double precision, double precision,
  double precision, double precision, timestamptz, timestamptz
) TO authenticated;

REVOKE ALL ON FUNCTION public.get_customer_live_for_driver(
  uuid, double precision, double precision
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_live_for_driver(
  uuid, double precision, double precision
) TO authenticated;
