-- After stacked accept stamps driver_net via snapshot_accepted_wave_commission,
-- expose accepted-offer metadata on driver snapshots (passthrough only).
-- Driver card SSOT remains driver_net_pence (609), never customer fare (716).
-- Does not recalculate commission or rewrite promote_stacked_trip.

CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_trip record;
  v_queued jsonb;
  v_server_now timestamptz := now();
  v_no_show_wait_min numeric := 4;
  v_no_show_apply_after_arrival boolean := true;
  v_arrived_at timestamptz;
  v_status text;
  v_eligible_at timestamptz;
  v_remaining_seconds integer := 0;
  v_can_mark boolean := false;
  v_actions jsonb := '[]'::jsonb;
  v_active jsonb;
  v_passenger_id uuid;
  v_passenger_first_name text;
  v_passenger_last_name text;
  v_passenger_rating numeric;
  v_passenger_trip_count integer;
  v_stops jsonb := '[]'::jsonb;
BEGIN
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT t.*
  INTO v_trip
  FROM public.trips t
  WHERE (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
    AND t.status IS DISTINCT FROM 'queued'
    AND t.status NOT IN (
      'completed', 'cancelled', 'canceled', 'customer_cancelled',
      'driver_cancelled', 'no_show', 'expired', 'declined', 'failed'
    )
  ORDER BY t.updated_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    v_status := lower(coalesce(v_trip.status, ''));
    v_arrived_at := coalesce(v_trip.pickup_arrived_at, v_trip.arrived_at);

    SELECT
      COALESCE(fps.no_show_wait_time_minutes, 4),
      COALESCE(fps.no_show_apply_after_arrival_only, true)
    INTO v_no_show_wait_min, v_no_show_apply_after_arrival
    FROM public.fare_pricing_settings fps
    WHERE fps.service_area_id = v_trip.service_area_id
      AND (v_trip.vehicle_type_id IS NULL OR fps.vehicle_type_id = v_trip.vehicle_type_id)
    ORDER BY fps.vehicle_type_id NULLS LAST
    LIMIT 1;

    IF v_arrived_at IS NOT NULL
       AND v_trip.started_at IS NULL
       AND v_status IN (
         'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
         'pickup_waiting', 'waiting', 'driver_arrived', 'waiting_at_pickup'
       )
    THEN
      v_eligible_at := v_arrived_at
        + make_interval(mins => GREATEST(0, ceil(v_no_show_wait_min)::int));
      v_remaining_seconds := GREATEST(
        0,
        floor(extract(epoch from (v_eligible_at - v_server_now)))::int
      );
      v_can_mark := (v_server_now >= v_eligible_at)
        AND (NOT v_no_show_apply_after_arrival OR v_arrived_at IS NOT NULL);
    END IF;

    IF v_status IN (
      'accepted', 'confirmed', 'driver_assigned', 'en_route', 'en_route_to_pickup',
      'driver_en_route', 'enroute_to_pickup', 'driver_arriving'
    ) THEN
      v_actions := '["arrive_pickup","driver_cancel"]'::jsonb;
    ELSIF v_status IN (
      'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
      'pickup_waiting', 'waiting', 'driver_arrived', 'waiting_at_pickup'
    ) THEN
      v_actions := jsonb_strip_nulls(jsonb_build_array(
        'start_trip',
        'driver_cancel',
        CASE WHEN v_can_mark THEN 'passenger_no_show' ELSE NULL END
      ));
    ELSIF v_status IN ('in_progress', 'started', 'on_trip', 'ongoing') THEN
      v_actions := '["arrive_stop","next_stop","complete_trip","driver_cancel"]'::jsonb;
    ELSE
      v_actions := '[]'::jsonb;
    END IF;

    v_passenger_id := v_trip.passenger_id;
    v_passenger_first_name := NULL;
    v_passenger_last_name := NULL;
    v_passenger_rating := NULL;
    v_passenger_trip_count := NULL;

    IF v_passenger_id IS NOT NULL THEN
      SELECT
        NULLIF(btrim(c.first_name), ''),
        NULLIF(btrim(c.last_name), '')
      INTO v_passenger_first_name, v_passenger_last_name
      FROM public.customers c
      WHERE c.id = v_passenger_id;

      SELECT s.avg_rating, s.total_trips
      INTO v_passenger_rating, v_passenger_trip_count
      FROM public.get_customer_trip_stats(v_passenger_id) s;
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', ts.id,
          'trip_id', ts.trip_id,
          'stop_index', ts.stop_index,
          'type', ts.type,
          'address', ts.address,
          'lat', ts.lat,
          'lng', ts.lng,
          'latitude', ts.lat,
          'longitude', ts.lng,
          'status', ts.status,
          'arrived_at', ts.arrived_at,
          'completed_at', ts.completed_at,
          'waiting_charge_active', ts.waiting_charge_active,
          'waiting_started_at', ts.waiting_started_at,
          'waiting_stopped_at', ts.waiting_stopped_at
        )
        ORDER BY ts.stop_index
      ),
      '[]'::jsonb
    )
    INTO v_stops
    FROM public.trip_stops ts
    WHERE ts.trip_id = v_trip.id;

    v_active := jsonb_build_object(
      'id', v_trip.id,
      'trip_id', v_trip.id,
      'public_trip_id', COALESCE(NULLIF(trim(v_trip.trip_number::text), ''), substring(v_trip.id::text, 1, 8)),
      'status', v_trip.status,
      'dispatch_status', v_trip.dispatch_status,
      'trip_version', v_trip.trip_version,
      'pricing_version', v_trip.pricing_version,
      'fare_revision_number', v_trip.fare_revision_number,
      'driver_id', v_trip.driver_id,
      'confirmed_driver_id', v_trip.confirmed_driver_id,
      'passenger_id', v_passenger_id,
      'passenger_first_name', v_passenger_first_name,
      'passenger_last_name', v_passenger_last_name,
      'passenger_name', NULLIF(btrim(COALESCE(v_trip.passenger_name, '')), ''),
      'passenger_rating', v_passenger_rating,
      'passenger_trip_count', v_passenger_trip_count,
      'arrived_at', v_trip.arrived_at,
      'pickup_arrived_at', v_trip.pickup_arrived_at,
      'started_at', v_trip.started_at,
      'completed_at', v_trip.completed_at,
      'current_stop_index', v_trip.current_stop_index,
      'pickup_waiting_started_at', v_trip.pickup_waiting_started_at,
      'pickup_paid_waiting_started_at', v_trip.pickup_paid_waiting_started_at,
      'free_wait_expires_at', v_trip.free_wait_expires_at,
      'pickup_waiting_admin_config', v_trip.pickup_waiting_admin_config,
      'admin_waiting_config_snapshot', v_trip.pickup_waiting_admin_config,
      'pickup_waiting_charge_pence', v_trip.pickup_waiting_charge_pence,
      'pickup_waiting_finalized_at', v_trip.pickup_waiting_finalized_at,
      'pickup_waiting_intervals_charged', v_trip.pickup_waiting_intervals_charged,
      'pickup_waiting_chargeable_seconds', v_trip.pickup_waiting_chargeable_seconds,
      'pickup_waiting_last_tick_at', v_trip.pickup_waiting_last_tick_at,
      'waiting_charge_pence', v_trip.waiting_charge_pence,
      'total_waiting_charge_pence', v_trip.total_waiting_charge_pence,
      'stop_waiting_charge_pence', v_trip.stop_waiting_charge_pence,
      'stop_charge_total_pence', v_trip.stop_charge_total_pence,
      'locked_base_fare_pence', v_trip.locked_base_fare_pence,
      'final_fare_pence', v_trip.final_fare_pence,
      'final_customer_fare_pence', v_trip.final_customer_fare_pence,
      'grace_period_expired_at', v_trip.grace_period_expired_at,
      'service_area_id', v_trip.service_area_id,
      'vehicle_type_id', v_trip.vehicle_type_id,
      'pickup_address', left(COALESCE(v_trip.pickup_address::text, ''), 160),
      'dropoff_address', left(COALESCE(v_trip.dropoff_address::text, ''), 160),
      'pickup_latitude', v_trip.pickup_latitude
    ) || jsonb_build_object(
      'pickup_longitude', v_trip.pickup_longitude,
      'dropoff_latitude', v_trip.dropoff_latitude,
      'dropoff_longitude', v_trip.dropoff_longitude,
      'payment_method', v_trip.payment_method,
      'payment_status', v_trip.payment_status,
      'driver_net_pence', COALESCE(
        NULLIF(v_trip.driver_net_pence, 0),
        NULLIF(v_trip.driver_net_before_tip_pence, 0),
        NULLIF(v_trip.accepted_driver_offer_fare_pence, 0)
      ),
      'currency_code', COALESCE(v_trip.currency_code, v_trip.offer_currency, 'GBP'),
      'stack_position', v_trip.stack_position,
      'is_queued', (v_trip.status = 'queued'),
      'customer_live_location_allowed', (
        v_status IN (
          'accepted', 'confirmed', 'en_route', 'en_route_to_pickup',
          'driver_en_route', 'driver_arriving', 'arrived', 'arrived_at_pickup',
          'at_pickup', 'pickup_waiting', 'waiting', 'driver_arrived'
        )
      ),
      'can_mark_no_show', v_can_mark,
      'no_show_eligible', v_can_mark,
      'no_show_eligible_at', v_eligible_at,
      'no_show_remaining_seconds', v_remaining_seconds,
      'permitted_actions', v_actions,
      'trip_stops', v_stops,
      'stops', v_stops
    ) || jsonb_build_object(
      -- Accepted-offer financial SSOT (MK-260817-008). Passthrough only.
      -- Never substitute final_fare_pence / customer fare.
      'accepted_ride_offer_id', v_trip.accepted_ride_offer_id,
      'accepted_commission_percent', v_trip.accepted_commission_percent,
      'accepted_dispatch_wave', v_trip.accepted_dispatch_wave,
      'accepted_dispatch_round', v_trip.accepted_dispatch_round
    );
  ELSE
    v_active := NULL;
  END IF;

  SELECT COALESCE(public.get_driver_queued_trips(), '[]'::jsonb)
  INTO v_queued;

  RETURN jsonb_build_object(
    'server_now', v_server_now,
    'driver_id', v_driver_id,
    'active_trip', v_active,
    'queued_trips', v_queued
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_queued_trips()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_can_cancel boolean := true;
BEGIN
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Driver cancellation of queued stacked trips is allowed via stop-workflow
  -- cancel_queued_stacked (existing). Expose can_cancel for UI gating.
  v_can_cancel := true;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(row_to_json(q)::jsonb ORDER BY q.queue_position, q.sort_at)
      FROM (
        SELECT
          t.id AS trip_id,
          t.id AS queue_entry_id,
          COALESCE(NULLIF(trim(t.trip_number::text), ''), substring(t.id::text, 1, 8)) AS public_trip_id,
          COALESCE(t.stack_position, 1) AS queue_position,
          t.status AS status,
          COALESCE(
            NULLIF(t.driver_net_pence, 0),
            NULLIF(t.driver_net_before_tip_pence, 0),
            NULLIF(t.accepted_driver_offer_fare_pence, 0)
          ) AS driver_net_pence,
          t.accepted_ride_offer_id AS accepted_ride_offer_id,
          t.accepted_commission_percent AS accepted_commission_percent,
          t.accepted_dispatch_wave AS accepted_dispatch_wave,
          t.accepted_dispatch_round AS accepted_dispatch_round,
          COALESCE(t.currency_code, t.offer_currency, 'GBP') AS currency_code,
          t.vehicle_type AS service_type,
          t.scheduled_at AS scheduled_pickup_at,
          left(COALESCE(NULLIF(btrim(t.pickup_address::text), ''), 'Pickup'), 160) AS pickup_summary,
          left(COALESCE(NULLIF(btrim(t.dropoff_address::text), ''), 'Drop-off'), 160) AS dropoff_summary,
          (COALESCE(t.total_stops, 0) > 2) AS has_multiple_stops,
          CASE
            WHEN lower(coalesce(t.payment_method, t.payment_type, '')) LIKE '%card%'
              OR lower(coalesce(t.payment_method, '')) IN ('card','revolut','apple_pay','google_pay','saved_card')
              THEN 'card'
            WHEN lower(coalesce(t.payment_method, t.payment_type, '')) LIKE '%cash%'
              THEN 'cash'
            ELSE 'unknown'
          END AS payment_method,
          t.created_at AS assigned_at,
          t.created_at AS sort_at,
          v_can_cancel AS can_cancel,
          CASE
            WHEN v_can_cancel THEN 'Queued trip will be released for rematch. Your active trip is unchanged.'
            ELSE NULL
          END AS cancellation_consequence,
          t.pickup_latitude AS pickup_lat,
          t.pickup_longitude AS pickup_lng,
          t.dropoff_latitude AS dropoff_lat,
          t.dropoff_longitude AS dropoff_lng
        FROM public.trips t
        WHERE t.status = 'queued'
          AND (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
        ORDER BY t.stack_position ASC NULLS LAST,
                 t.created_at ASC
      ) q
    ),
    '[]'::jsonb
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_driver_queued_trips() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_queued_trips() TO authenticated, service_role;
