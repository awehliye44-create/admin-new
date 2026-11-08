CREATE OR REPLACE FUNCTION public.start_stop_waiting(p_trip_id uuid, p_stop_id uuid, p_driver_id uuid, p_grace_period_seconds integer DEFAULT 0, p_charge_interval_seconds integer DEFAULT 10, p_rate_pence_per_minute integer DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id UUID;
  v_new_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM trips t
    WHERE t.id = p_trip_id AND t.driver_id = p_driver_id
  ) THEN
    RAISE EXCEPTION 'Trip not found for this driver';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM trip_stops s
    WHERE s.id = p_stop_id AND s.trip_id = p_trip_id
  ) THEN
    RAISE EXCEPTION 'Stop not found for this trip';
  END IF;

  SELECT id INTO v_existing_id
  FROM trip_stop_waiting
  WHERE trip_id = p_trip_id AND status = 'active';

  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION 'Active waiting session already exists for this trip';
  END IF;

  INSERT INTO trip_stop_waiting (
    trip_id, stop_id, driver_id,
    grace_period_seconds, charge_interval_seconds, rate_pence_per_minute
  ) VALUES (
    p_trip_id, p_stop_id, p_driver_id,
    p_grace_period_seconds, p_charge_interval_seconds, p_rate_pence_per_minute
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.lost_property_get_cases_for_photo_cleanup()
 RETURNS TABLE(case_id uuid, customer_photos text[], found_item_photos text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    c.id,
    COALESCE(ARRAY(
      SELECT p FROM unnest(c.photos) AS p
      WHERE left(p, length(c.id::text) + 1) = c.id::text || '/'
        AND position('..' IN p) = 0
    ), '{}'::text[]),
    COALESCE(ARRAY(
      SELECT p FROM unnest(c.found_item_photos) AS p
      WHERE left(p, length(c.id::text) + 1) = c.id::text || '/'
        AND position('..' IN p) = 0
    ), '{}'::text[])
  FROM public.lost_property_cases c
  WHERE c.photos_delete_at IS NOT NULL
    AND c.photos_delete_at <= now()
    AND (c.photos != '{}' OR c.found_item_photos != '{}');
$function$;