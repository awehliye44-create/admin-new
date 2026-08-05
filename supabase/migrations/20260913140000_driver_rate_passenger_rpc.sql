-- Driver → passenger rating SSOT.
-- App contract: RPC public.driver_rate_passenger
-- Writes passenger_ratings + denormalised trips.driver_passenger_* columns.

CREATE OR REPLACE FUNCTION public.driver_rate_passenger(
  p_trip_id uuid,
  p_stars integer DEFAULT NULL,
  p_tags text[] DEFAULT NULL,
  p_comment text DEFAULT NULL,
  p_skipped boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_trip record;
  v_existing_id uuid;
  v_tags text[] := COALESCE(p_tags, ARRAY[]::text[]);
  v_comment text := NULLIF(btrim(COALESCE(p_comment, '')), '');
  v_skipped boolean := COALESCE(p_skipped, false);
  v_now timestamptz := now();
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'unauthorized');
  END IF;

  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_trip');
  END IF;

  SELECT
    t.id,
    t.driver_id,
    t.passenger_id,
    t.status,
    COALESCE(t.driver_passenger_rating_submitted, false) AS rating_submitted,
    COALESCE(t.driver_passenger_rating_skipped, false) AS rating_skipped
  INTO v_trip
  FROM public.trips t
  WHERE t.id = p_trip_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF v_trip.driver_id IS DISTINCT FROM v_driver_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  IF v_trip.status IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'trip_not_completed');
  END IF;

  SELECT pr.id
  INTO v_existing_id
  FROM public.passenger_ratings pr
  WHERE pr.trip_id = p_trip_id
    AND pr.driver_id = v_driver_id
  LIMIT 1;

  IF v_existing_id IS NOT NULL
     OR v_trip.rating_submitted
     OR v_trip.rating_skipped THEN
    RETURN jsonb_build_object('ok', true, 'code', 'already_recorded');
  END IF;

  IF v_skipped THEN
    INSERT INTO public.passenger_ratings (
      trip_id,
      driver_id,
      passenger_id,
      skipped,
      stars,
      tags,
      comment
    ) VALUES (
      p_trip_id,
      v_driver_id,
      v_trip.passenger_id,
      true,
      NULL,
      NULL,
      NULL
    );

    UPDATE public.trips
    SET
      driver_passenger_rating_skipped = true,
      driver_passenger_rating_submitted = false,
      driver_passenger_rating_at = v_now,
      driver_passenger_rating = NULL,
      driver_passenger_feedback = NULL,
      driver_passenger_compliments = NULL,
      driver_passenger_low_rating_reasons = NULL
    WHERE id = p_trip_id;

    RETURN jsonb_build_object('ok', true, 'code', 'skipped');
  END IF;

  IF p_stars IS NULL OR p_stars < 1 OR p_stars > 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_stars');
  END IF;

  IF v_comment IS NOT NULL AND char_length(v_comment) > 500 THEN
    v_comment := left(v_comment, 500);
  END IF;

  INSERT INTO public.passenger_ratings (
    trip_id,
    driver_id,
    passenger_id,
    skipped,
    stars,
    tags,
    comment
  ) VALUES (
    p_trip_id,
    v_driver_id,
    v_trip.passenger_id,
    false,
    p_stars,
    CASE WHEN cardinality(v_tags) > 0 THEN v_tags ELSE NULL END,
    v_comment
  );

  UPDATE public.trips
  SET
    driver_passenger_rating = p_stars::smallint,
    driver_passenger_rating_submitted = true,
    driver_passenger_rating_skipped = false,
    driver_passenger_rating_at = v_now,
    driver_passenger_feedback = v_comment,
    driver_passenger_compliments = CASE
      WHEN p_stars >= 3 AND cardinality(v_tags) > 0 THEN v_tags
      ELSE NULL
    END,
    driver_passenger_low_rating_reasons = CASE
      WHEN p_stars <= 2 AND cardinality(v_tags) > 0 THEN v_tags
      ELSE NULL
    END
  WHERE id = p_trip_id;

  RETURN jsonb_build_object('ok', true, 'code', 'submitted', 'stars', p_stars);
END;
$function$;

COMMENT ON FUNCTION public.driver_rate_passenger(uuid, integer, text[], text, boolean) IS
  'Authenticated driver submits or skips passenger rating for a completed trip they drove. Idempotent.';

REVOKE ALL ON FUNCTION public.driver_rate_passenger(uuid, integer, text[], text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_rate_passenger(uuid, integer, text[], text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_rate_passenger(uuid, integer, text[], text, boolean) TO service_role;
