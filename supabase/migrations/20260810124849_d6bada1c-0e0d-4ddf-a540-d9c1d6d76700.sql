CREATE OR REPLACE FUNCTION public.get_trip_passenger_details(p_trip_id uuid)
RETURNS TABLE (
  trip_id uuid,
  passenger_id uuid,
  display_name text,
  first_name text,
  customer_code text,
  rating numeric,
  ratings_count integer,
  completed_trips integer,
  phone_verified boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id uuid;
  v_passenger uuid;
BEGIN
  v_driver_id := public.current_driver_profile_id();
  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;

  SELECT t.passenger_id INTO v_passenger
  FROM public.trips t
  WHERE t.id = p_trip_id
    AND (
      t.driver_id = v_driver_id
      OR t.confirmed_driver_id = v_driver_id
      OR public.driver_can_view_trip_via_offer(t.id)
    );

  IF v_passenger IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p_trip_id,
    c.id,
    TRIM(COALESCE(c.first_name, '') || CASE
      WHEN COALESCE(c.last_name, '') <> '' THEN ' ' || UPPER(LEFT(c.last_name, 1)) || '.'
      ELSE '' END),
    c.first_name,
    c.customer_code,
    ROUND(COALESCE(r.avg_stars, 5.0)::numeric, 2),
    COALESCE(r.cnt, 0)::integer,
    COALESCE(tc.cnt, 0)::integer,
    COALESCE(c.phone_verified, false)
  FROM public.customers c
  LEFT JOIN LATERAL (
    SELECT AVG(pr.stars)::numeric AS avg_stars, COUNT(*)::int AS cnt
    FROM public.passenger_ratings pr
    WHERE pr.passenger_id = c.id AND COALESCE(pr.skipped, false) = false AND pr.stars IS NOT NULL
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS cnt
    FROM public.trips t2
    WHERE t2.passenger_id = c.id AND t2.status = 'completed'
  ) tc ON true
  WHERE c.id = v_passenger;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_trip_passenger_details(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trip_passenger_details(uuid) TO authenticated, service_role;