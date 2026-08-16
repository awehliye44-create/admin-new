-- Signed trip-modification fold (MK-260816-003).
--
-- Before: customer_modification_charge_pence := GREATEST(0, prior + delta)
--         → shorter-route reductions were discarded on fare-locked trips.
-- After:  signed cumulative adjustment; floor only the final payable;
--         p_new_fare_pence is already net of the existing offer discount.

CREATE OR REPLACE FUNCTION public.apply_trip_modification_to_trip(
  p_trip_id uuid,
  p_change_type text,
  p_fare_delta_pence integer,
  p_new_fare_pence integer,
  p_new_distance_meters integer,
  p_new_duration_seconds integer,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb,
  p_fare_preview jsonb DEFAULT NULL::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip record;
  v_dropoff_rec jsonb;
  v_stops_json jsonb;
  v_distance_km numeric;
  v_duration_minutes numeric;
  v_fare_major numeric;
  v_final_pence int;
  v_offer_discount int;
  v_fare_breakdown jsonb;
  v_pricing_mode text;
  v_base_fare_pence int;
  v_modification_delta int;
  v_locked_base int;
  v_discount int;
  v_prior_modification int;
  v_new_customer_modification int;
  v_new_dropoff_address text;
  v_new_dropoff_lat double precision;
  v_new_dropoff_lng double precision;
  v_preview jsonb;
  v_gross_pence int;
  v_pct numeric;
  v_airport_pence int;
  v_pass_through_pence int;
  v_commissionable_pence int;
  v_commission_pence int;
  v_driver_net_pence int;
BEGIN
  SELECT * INTO v_trip FROM trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_dropoff_rec := NULL;
  IF p_after_snapshot->'dropoff' IS NOT NULL THEN
    v_dropoff_rec := p_after_snapshot->'dropoff';
  ELSIF p_after_snapshot->'stops' IS NOT NULL THEN
    SELECT s INTO v_dropoff_rec
    FROM jsonb_array_elements(p_after_snapshot->'stops') AS s
    WHERE s->>'type' = 'dropoff'
    LIMIT 1;
  END IF;

  v_new_dropoff_address := COALESCE(v_dropoff_rec->>'address', v_trip.dropoff_address);
  v_new_dropoff_lat := COALESCE((v_dropoff_rec->>'lat')::double precision, v_trip.dropoff_latitude);
  v_new_dropoff_lng := COALESCE((v_dropoff_rec->>'lng')::double precision, v_trip.dropoff_longitude);

  v_stops_json := '[]'::jsonb;
  IF p_after_snapshot->'stops' IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'address', s->>'address',
        'lat', (s->>'lat')::numeric,
        'lng', (s->>'lng')::numeric
      )
    ), '[]'::jsonb)
    INTO v_stops_json
    FROM jsonb_array_elements(p_after_snapshot->'stops') AS s
    WHERE s->>'type' = 'stop';
  END IF;

  v_distance_km := v_trip.estimated_distance_km;
  v_duration_minutes := v_trip.estimated_duration_minutes;
  IF p_new_distance_meters IS NOT NULL AND p_new_distance_meters > 0 THEN
    v_distance_km := p_new_distance_meters::numeric / 1000.0;
  ELSIF p_after_snapshot->>'estimated_distance_km' IS NOT NULL THEN
    v_distance_km := (p_after_snapshot->>'estimated_distance_km')::numeric;
  END IF;
  IF p_new_duration_seconds IS NOT NULL AND p_new_duration_seconds > 0 THEN
    v_duration_minutes := p_new_duration_seconds::numeric / 60.0;
  ELSIF p_after_snapshot->>'estimated_duration_minutes' IS NOT NULL THEN
    v_duration_minutes := (p_after_snapshot->>'estimated_duration_minutes')::numeric;
  END IF;

  IF p_new_fare_pence IS NULL OR p_new_fare_pence <= 0 THEN
    RETURN;
  END IF;

  v_modification_delta := COALESCE(p_fare_delta_pence, 0);
  v_preview := COALESCE(p_fare_preview, p_after_snapshot->'fare_preview');
  v_fare_breakdown := COALESCE(
    v_preview->'fare_breakdown_json',
    v_preview->'fare_breakdown'
  );
  v_pricing_mode := COALESCE(
    v_preview->>'pricing_mode',
    v_fare_breakdown->>'pricing_mode',
    v_fare_breakdown->>'tripPricingMode'
  );
  v_base_fare_pence := COALESCE(
    (v_preview->>'base_fare_pence')::int,
    (v_fare_breakdown->>'trip_fare_pence')::int,
    CASE
      WHEN v_fare_breakdown->>'tripFare' IS NOT NULL
        THEN ROUND((v_fare_breakdown->>'tripFare')::numeric * 100)::int
      ELSE NULL
    END
  );

  v_offer_discount := COALESCE(v_trip.offer_discount_pence, v_trip.discount_pence, 0);
  v_discount := COALESCE(v_trip.discount_pence, v_offer_discount, 0);
  v_locked_base := COALESCE(
    NULLIF(v_trip.locked_base_fare_pence, 0),
    CASE WHEN v_trip.fare_locked THEN NULLIF(v_trip.gross_fare_pence, 0) END,
    NULLIF(v_trip.estimated_total_pence, 0)
  );

  v_prior_modification := COALESCE(v_trip.customer_modification_charge_pence, 0);
  -- Signed cumulative adjustment. Do NOT clamp at zero — shorter routes must
  -- reduce the payable. Floor only the final total below.
  v_new_customer_modification := v_prior_modification + v_modification_delta;

  v_pct := LEAST(15, GREATEST(0, COALESCE(v_trip.driver_tier_commission_percent::numeric, 15)));
  v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
  v_pass_through_pence := COALESCE(v_trip.other_pass_through_charges_pence, 0);

  -- p_new_fare_pence from Edge is already net of the existing offer discount.
  -- Prefer it as the committed payable SSOT; never subtract the discount again.
  -- Gross reconstructs pre-discount so promotion stays applied exactly once.
  v_final_pence := GREATEST(1, p_new_fare_pence);
  v_fare_major := v_final_pence::numeric / 100.0;
  IF v_trip.fare_locked OR v_locked_base IS NOT NULL THEN
    v_gross_pence := v_final_pence + COALESCE(v_discount, 0);
  ELSE
    v_gross_pence := v_final_pence + COALESCE(v_offer_discount, 0);
  END IF;

  v_commissionable_pence := GREATEST(0, v_gross_pence - v_airport_pence - v_pass_through_pence);
  v_commission_pence := ROUND(v_commissionable_pence * v_pct / 100.0)::int;
  v_driver_net_pence := GREATEST(0, v_gross_pence - v_commission_pence);

  IF v_trip.fare_locked OR v_locked_base IS NOT NULL THEN
    UPDATE trips SET
      dropoff_address = v_new_dropoff_address,
      dropoff_latitude = v_new_dropoff_lat,
      dropoff_longitude = v_new_dropoff_lng,
      stops = v_stops_json,
      estimated_distance_km = COALESCE(v_distance_km, estimated_distance_km),
      estimated_duration_minutes = COALESCE(v_duration_minutes, estimated_duration_minutes),
      original_dropoff_address = COALESCE(original_dropoff_address, v_trip.dropoff_address),
      original_dropoff_latitude = COALESCE(original_dropoff_latitude, v_trip.dropoff_latitude),
      original_dropoff_longitude = COALESCE(original_dropoff_longitude, v_trip.dropoff_longitude),
      modified_dropoff_address = v_new_dropoff_address,
      modified_dropoff_latitude = v_new_dropoff_lat,
      modified_dropoff_longitude = v_new_dropoff_lng,
      modification_delta_pence = v_modification_delta,
      customer_modification_charge_pence = v_new_customer_modification,
      modification_status = 'confirmed',
      modification_confirmed_at = now(),
      estimated_fare = (p_new_fare_pence::numeric / 100.0),
      estimated_total_pence = p_new_fare_pence,
      gross_fare_pence = v_gross_pence,
      final_fare_pence = v_final_pence,
      final_customer_fare_pence = v_final_pence,
      fare = v_fare_major,
      capture_amount_pence = v_final_pence,
      quoted_fare_pence = p_new_fare_pence,
      base_fare_pence = COALESCE(v_base_fare_pence, base_fare_pence),
      fare_breakdown = COALESCE(v_fare_breakdown, fare_breakdown),
      pricing_mode = COALESCE(v_pricing_mode, pricing_mode),
      commissionable_fare_pence = v_commissionable_pence,
      commission_pence = v_commission_pence,
      commission_pct = v_pct,
      driver_net_pence = v_driver_net_pence,
      destination_change_adjustment_pence = CASE
        WHEN p_change_type = 'change_dropoff' THEN v_modification_delta
        ELSE destination_change_adjustment_pence
      END,
      updated_at = now()
    WHERE id = p_trip_id;
  ELSE
    UPDATE trips SET
      dropoff_address = v_new_dropoff_address,
      dropoff_latitude = v_new_dropoff_lat,
      dropoff_longitude = v_new_dropoff_lng,
      stops = v_stops_json,
      estimated_distance_km = COALESCE(v_distance_km, estimated_distance_km),
      estimated_duration_minutes = COALESCE(v_duration_minutes, estimated_duration_minutes),
      original_dropoff_address = COALESCE(original_dropoff_address, v_trip.dropoff_address),
      original_dropoff_latitude = COALESCE(original_dropoff_latitude, v_trip.dropoff_latitude),
      original_dropoff_longitude = COALESCE(original_dropoff_longitude, v_trip.dropoff_longitude),
      modified_dropoff_address = v_new_dropoff_address,
      modified_dropoff_latitude = v_new_dropoff_lat,
      modified_dropoff_longitude = v_new_dropoff_lng,
      modification_delta_pence = v_modification_delta,
      customer_modification_charge_pence = v_new_customer_modification,
      modification_status = 'confirmed',
      modification_confirmed_at = now(),
      fare = v_fare_major,
      estimated_fare = (p_new_fare_pence::numeric / 100.0),
      estimated_total_pence = p_new_fare_pence,
      gross_fare_pence = v_gross_pence,
      final_fare_pence = v_final_pence,
      final_customer_fare_pence = v_final_pence,
      capture_amount_pence = v_final_pence,
      quoted_fare_pence = p_new_fare_pence,
      base_fare_pence = COALESCE(v_base_fare_pence, base_fare_pence),
      fare_breakdown = COALESCE(v_fare_breakdown, fare_breakdown),
      pricing_mode = COALESCE(v_pricing_mode, pricing_mode),
      commissionable_fare_pence = v_commissionable_pence,
      commission_pence = v_commission_pence,
      commission_pct = v_pct,
      driver_net_pence = v_driver_net_pence,
      destination_change_adjustment_pence = CASE
        WHEN p_change_type = 'change_dropoff' THEN v_modification_delta
        ELSE destination_change_adjustment_pence
      END,
      updated_at = now()
    WHERE id = p_trip_id;
  END IF;
END;
$function$;
