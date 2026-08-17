-- Customer Rate Your Trip recovery SSOT.
-- Absence of rider_feedback on a completed owned trip is the durable pending
-- rating state. Ignore passenger_ratings. Payment/invoice is not a prerequisite.
-- Do not insert ratings. Oldest unrated completed trip first.

CREATE OR REPLACE FUNCTION public.get_customer_pending_trip_rating()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_row record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = 'P0001';
  END IF;

  SELECT c.id INTO v_customer_id
  FROM public.customers c
  WHERE c.user_id = v_uid
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RETURN jsonb_build_object('pending', false, 'reason', 'customer_not_found');
  END IF;

  SELECT
    t.id,
    t.trip_number,
    t.completed_at,
    t.updated_at,
    t.created_at,
    t.pickup_address,
    t.dropoff_address,
    t.final_customer_fare_pence,
    t.final_fare_pence,
    t.quoted_fare_pence,
    t.locked_base_fare_pence,
    t.currency_code,
    t.driver_id,
    t.confirmed_driver_id,
    d.id AS resolved_driver_id,
    d.first_name AS driver_first_name,
    d.last_name AS driver_last_name,
    d.profile_photo_url AS driver_photo_url,
    COALESCE(d.display_rating, d.rating) AS driver_rating,
    v.make AS vehicle_make,
    v.model AS vehicle_model,
    v.color AS vehicle_color,
    v.license_plate AS vehicle_registration,
    vt.slug AS vehicle_type_slug
  INTO v_row
  FROM public.trips t
  LEFT JOIN public.drivers d
    ON d.id = COALESCE(t.driver_id, t.confirmed_driver_id)
  LEFT JOIN LATERAL (
    SELECT vh.make, vh.model, vh.color, vh.license_plate, vh.vehicle_type_id
    FROM public.vehicles vh
    WHERE vh.driver_id = COALESCE(t.driver_id, t.confirmed_driver_id)
    ORDER BY vh.created_at DESC NULLS LAST
    LIMIT 1
  ) v ON true
  LEFT JOIN public.vehicle_types vt ON vt.id = v.vehicle_type_id
  WHERE t.passenger_id = v_customer_id
    AND lower(t.status::text) = 'completed'
    AND NOT EXISTS (
      SELECT 1
      FROM public.rider_feedback rf
      WHERE rf.trip_id = t.id
        AND rf.customer_id = v_customer_id
    )
  ORDER BY COALESCE(t.completed_at, t.updated_at, t.created_at) ASC NULLS LAST
  LIMIT 1;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('pending', false);
  END IF;

  RETURN jsonb_build_object(
    'pending', true,
    'trip_id', v_row.id,
    'public_trip_id', COALESCE(NULLIF(trim(v_row.trip_number::text), ''), substring(v_row.id::text, 1, 8)),
    'completed_at', v_row.completed_at,
    'pickup_address', left(COALESCE(v_row.pickup_address::text, ''), 160),
    'dropoff_address', left(COALESCE(v_row.dropoff_address::text, ''), 160),
    'fare_pence', COALESCE(
      v_row.final_customer_fare_pence,
      v_row.final_fare_pence,
      v_row.quoted_fare_pence,
      v_row.locked_base_fare_pence
    ),
    'currency_code', COALESCE(v_row.currency_code, 'GBP'),
    'driver_id', v_row.resolved_driver_id,
    'driver_first_name', v_row.driver_first_name,
    'driver_last_name', v_row.driver_last_name,
    'driver_photo_url', v_row.driver_photo_url,
    'driver_rating', v_row.driver_rating,
    'vehicle_make', v_row.vehicle_make,
    'vehicle_model', v_row.vehicle_model,
    'vehicle_color', v_row.vehicle_color,
    'vehicle_registration', v_row.vehicle_registration,
    'vehicle_type_slug', v_row.vehicle_type_slug
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_pending_trip_rating() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_pending_trip_rating() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
