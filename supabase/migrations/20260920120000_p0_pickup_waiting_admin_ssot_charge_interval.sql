-- P0 #2: Pickup waiting Admin SSOT + charge-interval freeze columns.
-- Forward-only. Does NOT re-apply 20260808210000 / 20260808211000.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS pickup_waiting_finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_waiting_intervals_charged integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pickup_waiting_chargeable_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pickup_waiting_last_tick_at timestamptz;

COMMENT ON COLUMN public.trips.pickup_waiting_finalized_at IS
  'Set on Start Trip (or terminal close). Tick must no-op after this.';
COMMENT ON COLUMN public.trips.pickup_waiting_intervals_charged IS
  'Completed charge intervals only (floor(paid_seconds / interval)).';
COMMENT ON COLUMN public.trips.pickup_waiting_chargeable_seconds IS
  'Elapsed paid seconds capped by max minutes (server time).';
COMMENT ON COLUMN public.trips.pickup_waiting_last_tick_at IS
  'Last successful tick that wrote a new intervals_charged value.';

CREATE OR REPLACE FUNCTION public.persist_pickup_waiting_admin_ssot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_free_minutes numeric := NULL;
  v_free_seconds integer := 0;
  v_paid_enabled boolean := false;
  v_fare_paid boolean := NULL;
  v_fare_rate integer := NULL;
  v_dispatch_rate integer := NULL;
  v_rate integer := 0;
  v_interval integer := NULL;
  v_max_minutes integer := 15;
  v_grace_source text := 'fare_pricing';
  v_no_show_minutes numeric := NULL;
  v_cfg jsonb;
  v_existing_source text;
  v_config_available boolean := false;
BEGIN
  IF NEW.pickup_waiting_started_at IS NULL OR NEW.service_area_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Never reset started_at on repeated Arrived / updates.
  IF TG_OP = 'UPDATE'
     AND OLD.pickup_waiting_started_at IS NOT NULL
     AND NEW.pickup_waiting_started_at IS DISTINCT FROM OLD.pickup_waiting_started_at
  THEN
    NEW.pickup_waiting_started_at := OLD.pickup_waiting_started_at;
  END IF;

  v_existing_source := COALESCE(NEW.pickup_waiting_admin_config->>'pickup_grace_source', '');

  -- Skip when already frozen from fare_pricing with expires_at present.
  IF NEW.free_wait_expires_at IS NOT NULL
     AND NEW.pickup_waiting_admin_config IS NOT NULL
     AND v_existing_source = 'fare_pricing'
     AND (
       TG_OP = 'INSERT'
       OR OLD.pickup_waiting_started_at IS NOT DISTINCT FROM NEW.pickup_waiting_started_at
     )
  THEN
    RETURN NEW;
  END IF;

  SELECT fps.free_waiting_minutes,
         COALESCE(fps.pickup_paid_waiting_enabled, fps.recalculate_on_waiting),
         fps.waiting_per_minute_pence,
         fps.no_show_wait_time_minutes
  INTO v_free_minutes, v_fare_paid, v_fare_rate, v_no_show_minutes
  FROM public.fare_pricing_settings fps
  WHERE fps.service_area_id = NEW.service_area_id
    AND (fps.vehicle_type_id = NEW.vehicle_type_id OR fps.vehicle_type_id IS NULL)
  ORDER BY CASE WHEN fps.vehicle_type_id IS NOT DISTINCT FROM NEW.vehicle_type_id THEN 0 ELSE 1 END,
           fps.updated_at DESC NULLS LAST
  LIMIT 1;

  SELECT ds.pickup_waiting_grace_period_seconds,
         ds.pickup_paid_waiting_enabled,
         ds.pickup_paid_waiting_rate_pence_per_minute,
         ds.pickup_waiting_max_minutes,
         ds.stop_waiting_charge_interval_seconds
  INTO v_free_seconds, v_paid_enabled, v_dispatch_rate, v_max_minutes, v_interval
  FROM public.dispatch_settings ds
  WHERE ds.service_area_id = NEW.service_area_id
  LIMIT 1;
  -- Intentionally no global dispatch fallback when SA known.

  IF v_free_minutes IS NOT NULL THEN
    v_grace_source := 'fare_pricing';
    v_free_seconds := GREATEST(0, ROUND(v_free_minutes * 60)::int);
    v_paid_enabled := COALESCE(v_fare_paid, v_paid_enabled, false);
    v_config_available := true;
  ELSIF v_free_seconds IS NOT NULL THEN
    v_grace_source := 'dispatch';
    v_free_seconds := GREATEST(0, COALESCE(v_free_seconds, 0));
    v_free_minutes := v_free_seconds / 60.0;
    v_paid_enabled := COALESCE(v_paid_enabled, false);
    v_config_available := true;
  ELSE
    v_grace_source := 'unavailable';
    v_free_seconds := 0;
    v_free_minutes := 0;
    v_paid_enabled := false;
    v_config_available := false;
  END IF;

  -- Fare vehicle-specific rate wins; dispatch is fallback only.
  v_rate := COALESCE(v_fare_rate, v_dispatch_rate, 0);
  v_max_minutes := COALESCE(v_max_minutes, 15);
  v_no_show_minutes := COALESCE(v_no_show_minutes, v_free_minutes, 0);
  v_interval := COALESCE(v_interval, 0);

  v_cfg := jsonb_build_object(
    'free_pickup_waiting_minutes', COALESCE(v_free_minutes, 0),
    'free_pickup_waiting_seconds', v_free_seconds,
    'pickup_grace_source', v_grace_source,
    'no_show_waiting_minutes', v_no_show_minutes,
    'no_show_waiting_seconds', GREATEST(0, ROUND(v_no_show_minutes * 60)::int),
    'pickup_paid_waiting_enabled', COALESCE(v_paid_enabled, false),
    'pickup_paid_waiting_rate_pence_per_minute', v_rate,
    'pickup_waiting_max_minutes', v_max_minutes,
    'waiting_charge_interval_seconds', v_interval,
    'waiting_charge_interval_source', CASE WHEN v_interval > 0 THEN 'dispatch_settings' ELSE 'unavailable' END,
    'waiting_charge_rounding', 'completed_intervals',
    'config_available', v_config_available,
    'service_area_id', NEW.service_area_id,
    'vehicle_type_id', NEW.vehicle_type_id,
    'waiting_context', 'pickup'
  );

  NEW.pickup_waiting_admin_config := COALESCE(NEW.pickup_waiting_admin_config, '{}'::jsonb) || v_cfg;
  NEW.free_wait_expires_at := NEW.pickup_waiting_started_at + make_interval(secs => v_free_seconds);

  RETURN NEW;
END;
$$;

-- Driver hydrate: expose finalize / interval proof fields (live function + keys).
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
$function$


