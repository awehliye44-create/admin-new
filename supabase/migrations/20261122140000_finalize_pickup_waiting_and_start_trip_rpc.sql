-- Phase 5 Start Trip: one transactional pickup-waiting finalize (+ start transition).
-- Replaces Edge sequential geofence/close/sum/pickup-update/start round-trips.
-- Money SSOT unchanged: counted in-radius pickup seconds − free wait × rate (completed intervals).
-- Pickup only: location_type='pickup', stop_id NULL. Never touch intermediate stop segments.
-- Chronological timestamp AFTER applied 20261122130000 (do not rename prior migrations).

CREATE OR REPLACE FUNCTION public.finalize_pickup_waiting_charge(
  p_trip_id uuid,
  p_driver_id uuid,
  p_now timestamptz DEFAULT now(),
  p_body_lat double precision DEFAULT NULL,
  p_body_lng double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_free int := 0;
  v_rate int := 0;
  v_interval int := 60;
  v_max_minutes int := 0;
  v_enabled boolean := false;
  v_config_available boolean := true;
  v_radius_enabled boolean := true;
  v_radius_m int := 100;
  v_pickup_lat double precision := NULL;
  v_pickup_lng double precision := NULL;
  v_trusted_lat double precision := NULL;
  v_trusted_lng double precision := NULL;
  v_trusted_at timestamptz := NULL;
  v_trusted_source text := NULL;
  v_age_ms numeric := NULL;
  v_inside boolean := false;
  v_distance_m double precision := NULL;
  v_used_source text := 'no_trusted_location';
  v_open_id uuid := NULL;
  v_counted int := 0;
  v_paid int := 0;
  v_charge int := 0;
  v_intervals int := 0;
  v_pence_per_interval int := 0;
  v_cfg jsonb := NULL;
  v_stop_waiting int := 0;
  v_free_expires timestamptz := NULL;
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'args_required');
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trip_not_found');
  END IF;

  IF v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'driver_mismatch');
  END IF;

  -- Idempotent: already finalized
  IF v_trip.pickup_waiting_finalized_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_finalized', true,
      'charge_pence', COALESCE(v_trip.pickup_waiting_charge_pence, 0),
      'intervals_charged', COALESCE(v_trip.pickup_waiting_intervals_charged, 0),
      'counted_seconds', COALESCE(v_trip.pickup_waiting_counted_seconds, 0)
    );
  END IF;

  -- No waiting clock → finalize zero (matches Edge)
  IF v_trip.pickup_waiting_started_at IS NULL THEN
    UPDATE public.trips
    SET
      pickup_waiting_finalized_at = p_now,
      pickup_waiting_charge_pence = COALESCE(pickup_waiting_charge_pence, 0),
      pickup_waiting_intervals_charged = 0,
      pickup_waiting_counted_seconds = 0,
      updated_at = p_now
    WHERE id = p_trip_id;

    RETURN jsonb_build_object(
      'ok', true,
      'already_finalized', false,
      'charge_pence', COALESCE(v_trip.pickup_waiting_charge_pence, 0),
      'intervals_charged', 0,
      'counted_seconds', 0,
      'skipped', 'no_waiting_started'
    );
  END IF;

  -- Prefer frozen trip snapshot (money knobs)
  IF v_trip.pickup_waiting_admin_config IS NOT NULL THEN
    BEGIN
      v_cfg := v_trip.pickup_waiting_admin_config::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_cfg := NULL;
    END;
  END IF;

  IF v_cfg IS NOT NULL AND (v_cfg ? 'free_pickup_waiting_seconds') THEN
    v_free := GREATEST(0, COALESCE((v_cfg->>'free_pickup_waiting_seconds')::int, 0));
    v_rate := GREATEST(0, COALESCE((v_cfg->>'pickup_paid_waiting_rate_pence_per_minute')::int, 0));
    v_interval := GREATEST(0, COALESCE((v_cfg->>'waiting_charge_interval_seconds')::int, 60));
    v_max_minutes := GREATEST(0, COALESCE((v_cfg->>'pickup_waiting_max_minutes')::int, 0));
    v_enabled := COALESCE((v_cfg->>'pickup_paid_waiting_enabled')::boolean, false);
    v_config_available := COALESCE((v_cfg->>'config_available')::boolean, true);
    v_radius_enabled := COALESCE((v_cfg->>'pickup_radius_enabled')::boolean, true);
    v_radius_m := GREATEST(1, COALESCE(NULLIF((v_cfg->>'pickup_radius_meters')::int, 0), 100));
  ELSE
    -- Live Admin SSOT: fare_pricing + dispatch (same knobs Edge loadAdminWaitingConfig uses)
    SELECT
      COALESCE(
        NULLIF((ds.pickup_waiting_grace_period_seconds)::int, 0),
        GREATEST(0, ROUND(COALESCE(fps.free_waiting_minutes, 0) * 60)::int),
        0
      ),
      COALESCE(
        NULLIF(fps.waiting_per_minute_pence, 0),
        NULLIF(ds.pickup_paid_waiting_rate_pence_per_minute, 0),
        0
      ),
      COALESCE(NULLIF(ds.stop_waiting_charge_interval_seconds, 0), 60),
      COALESCE(ds.pickup_waiting_max_minutes, 0),
      COALESCE(
        fps.pickup_paid_waiting_enabled,
        fps.recalculate_on_waiting,
        ds.pickup_paid_waiting_enabled,
        false
      ),
      COALESCE(ds.pickup_radius_enabled, true),
      COALESCE(NULLIF(ds.pickup_radius_meters, 0), 100)
    INTO v_free, v_rate, v_interval, v_max_minutes, v_enabled, v_radius_enabled, v_radius_m
    FROM (SELECT 1) AS _
    LEFT JOIN LATERAL (
      SELECT *
      FROM public.fare_pricing_settings fps
      WHERE fps.service_area_id IS NOT DISTINCT FROM v_trip.service_area_id
      ORDER BY fps.updated_at DESC NULLS LAST
      LIMIT 1
    ) fps ON true
    LEFT JOIN public.dispatch_settings ds
      ON ds.service_area_id IS NOT DISTINCT FROM v_trip.service_area_id
    LIMIT 1;

    v_free := GREATEST(0, COALESCE(v_free, 0));
    v_rate := GREATEST(0, COALESCE(v_rate, 0));
    v_interval := GREATEST(0, COALESCE(v_interval, 60));
    v_max_minutes := GREATEST(0, COALESCE(v_max_minutes, 0));
    v_enabled := COALESCE(v_enabled, false);
    v_radius_enabled := COALESCE(v_radius_enabled, true);
    v_radius_m := GREATEST(1, COALESCE(v_radius_m, 100));
    v_config_available := true;
  END IF;

  v_pickup_lat := v_trip.pickup_latitude;
  v_pickup_lng := v_trip.pickup_longitude;

  -- Trusted GPS ladder (fail closed for money). Max age 45s. Body never invents money.
  SELECT p.lat, p.lng,
    COALESCE(p.last_gps_sample_at, p.last_location_at, p.last_heartbeat_at, p.updated_at)
  INTO v_trusted_lat, v_trusted_lng, v_trusted_at
  FROM public.driver_presence p
  WHERE p.driver_id = p_driver_id;

  IF v_trusted_lat IS NOT NULL AND v_trusted_lng IS NOT NULL AND v_trusted_at IS NOT NULL THEN
    v_age_ms := EXTRACT(EPOCH FROM (p_now - v_trusted_at)) * 1000;
    IF v_age_ms <= 45000 AND v_age_ms >= -5000 THEN
      v_trusted_source := 'driver_presence';
    ELSE
      v_trusted_lat := NULL;
      v_trusted_lng := NULL;
      v_trusted_at := NULL;
    END IF;
  END IF;

  IF v_trusted_source IS NULL THEN
    SELECT l.lat, l.lng, l.updated_at
    INTO v_trusted_lat, v_trusted_lng, v_trusted_at
    FROM public.driver_live_locations l
    WHERE l.driver_id = p_driver_id;
    IF v_trusted_lat IS NOT NULL AND v_trusted_lng IS NOT NULL AND v_trusted_at IS NOT NULL THEN
      v_age_ms := EXTRACT(EPOCH FROM (p_now - v_trusted_at)) * 1000;
      IF v_age_ms <= 45000 AND v_age_ms >= -5000 THEN
        v_trusted_source := 'driver_live_locations';
      ELSE
        v_trusted_lat := NULL;
        v_trusted_lng := NULL;
      END IF;
    END IF;
  END IF;

  IF v_trusted_source IS NULL THEN
    SELECT d.current_lat, d.current_lng,
      COALESCE(d.last_location_updated_at, d.last_seen_at)
    INTO v_trusted_lat, v_trusted_lng, v_trusted_at
    FROM public.drivers d
    WHERE d.id = p_driver_id;
    IF v_trusted_lat IS NOT NULL AND v_trusted_lng IS NOT NULL AND v_trusted_at IS NOT NULL THEN
      v_age_ms := EXTRACT(EPOCH FROM (p_now - v_trusted_at)) * 1000;
      IF v_age_ms <= 45000 AND v_age_ms >= -5000 THEN
        v_trusted_source := 'drivers_current';
      ELSE
        v_trusted_lat := NULL;
        v_trusted_lng := NULL;
        v_trusted_source := NULL;
      END IF;
    END IF;
  END IF;

  IF v_pickup_lat IS NULL OR v_pickup_lng IS NULL THEN
    v_inside := false;
    v_used_source := 'no_pickup_coords';
  ELSIF NOT v_radius_enabled THEN
    v_inside := true;
    v_used_source := 'radius_disabled';
    v_distance_m := NULL;
  ELSIF v_trusted_source IS NULL OR v_trusted_lat IS NULL OR v_trusted_lng IS NULL THEN
    v_inside := false;
    v_used_source := 'no_trusted_location';
    v_distance_m := NULL;
  ELSE
    v_distance_m := public.haversine_meters(
      v_trusted_lat, v_trusted_lng, v_pickup_lat, v_pickup_lng
    );
    v_inside := v_distance_m <= v_radius_m;
    v_used_source := v_trusted_source;
  END IF;

  -- Open pickup segment only (never stop-scoped)
  SELECT s.id INTO v_open_id
  FROM public.trip_waiting_segments s
  WHERE s.trip_id = p_trip_id
    AND s.location_type = 'pickup'
    AND s.ended_at IS NULL
  ORDER BY s.started_at DESC NULLS LAST
  LIMIT 1
  FOR UPDATE;

  IF NOT v_inside AND v_open_id IS NOT NULL THEN
    UPDATE public.trip_waiting_segments
    SET
      ended_at = p_now,
      distance_meters = v_distance_m,
      source_location = v_used_source
    WHERE id = v_open_id;
    v_open_id := NULL;
  END IF;

  -- Close all remaining open pickup segments
  UPDATE public.trip_waiting_segments
  SET ended_at = p_now
  WHERE trip_id = p_trip_id
    AND location_type = 'pickup'
    AND ended_at IS NULL;

  -- Sum counted in-radius seconds for pickup only
  SELECT COALESCE(SUM(
    GREATEST(
      0,
      FLOOR(
        EXTRACT(EPOCH FROM (COALESCE(s.ended_at, p_now) - s.started_at))
      )::int
    )
  ), 0)
  INTO v_counted
  FROM public.trip_waiting_segments s
  WHERE s.trip_id = p_trip_id
    AND s.location_type = 'pickup';

  v_free_expires := COALESCE(
    v_trip.free_wait_expires_at,
    v_trip.pickup_waiting_started_at + make_interval(secs => v_free)
  );

  IF NOT v_enabled OR NOT v_config_available THEN
    UPDATE public.trips
    SET
      pickup_waiting_finalized_at = p_now,
      pickup_waiting_charge_pence = 0,
      pickup_waiting_intervals_charged = 0,
      pickup_waiting_counted_seconds = v_counted,
      free_wait_expires_at = v_free_expires,
      waiting_geofence_status = 'not_started',
      waiting_geofence_checked_at = p_now,
      waiting_geofence_distance_m = v_distance_m,
      updated_at = p_now
    WHERE id = p_trip_id;

    RETURN jsonb_build_object(
      'ok', true,
      'already_finalized', false,
      'charge_pence', 0,
      'intervals_charged', 0,
      'counted_seconds', v_counted,
      'paid_seconds', 0,
      'free_seconds', v_free,
      'skipped', CASE WHEN NOT v_enabled THEN 'pickup_waiting_disabled' ELSE 'config_unavailable' END,
      'inside_at_finalize', v_inside,
      'distance_meters', v_distance_m,
      'used_source', v_used_source
    );
  END IF;

  -- Completed-intervals charge (matches computePickupWaitingChargePence)
  v_paid := GREATEST(0, v_counted - v_free);
  IF v_max_minutes > 0 THEN
    v_paid := LEAST(v_paid, v_max_minutes * 60);
  END IF;
  IF v_interval <= 0 OR v_rate <= 0 OR v_paid <= 0 THEN
    v_charge := 0;
    v_intervals := 0;
    v_pence_per_interval := 0;
  ELSE
    v_pence_per_interval := ROUND((v_rate::numeric * v_interval) / 60.0)::int;
    v_intervals := FLOOR(v_paid::numeric / v_interval)::int;
    v_charge := v_intervals * v_pence_per_interval;
  END IF;

  v_stop_waiting := COALESCE(v_trip.stop_waiting_charge_pence, 0);

  UPDATE public.trips
  SET
    pickup_waiting_finalized_at = p_now,
    pickup_waiting_charge_pence = v_charge,
    pickup_waiting_intervals_charged = v_intervals,
    pickup_waiting_chargeable_seconds = v_paid,
    pickup_waiting_counted_seconds = v_counted,
    pickup_waiting_last_tick_at = p_now,
    pickup_paid_waiting_started_at = CASE
      WHEN pickup_paid_waiting_started_at IS NULL AND v_charge > 0 THEN p_now
      ELSE pickup_paid_waiting_started_at
    END,
    grace_period_expired_at = CASE
      WHEN grace_period_expired_at IS NULL AND v_paid > 0 THEN p_now
      ELSE grace_period_expired_at
    END,
    total_waiting_charge_pence = v_charge + v_stop_waiting,
    waiting_charge_pence = v_charge + v_stop_waiting,
    free_wait_expires_at = v_free_expires,
    waiting_geofence_status = 'not_started',
    waiting_geofence_checked_at = p_now,
    waiting_geofence_distance_m = v_distance_m,
    updated_at = p_now
  WHERE id = p_trip_id;

  RETURN jsonb_build_object(
    'ok', true,
    'already_finalized', false,
    'charge_pence', v_charge,
    'intervals_charged', v_intervals,
    'counted_seconds', v_counted,
    'paid_seconds', v_paid,
    'free_seconds', v_free,
    'rate_pence_per_minute', v_rate,
    'interval_seconds', v_interval,
    'pence_per_interval', v_pence_per_interval,
    'inside_at_finalize', v_inside,
    'distance_meters', v_distance_m,
    'used_source', v_used_source
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_pickup_waiting_and_start_trip(
  p_trip_id uuid,
  p_driver_id uuid,
  p_now timestamptz DEFAULT now(),
  p_body_lat double precision DEFAULT NULL,
  p_body_lng double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_pickup public.trip_stops%ROWTYPE;
  v_next public.trip_stops%ROWTYPE;
  v_money jsonb;
  v_already boolean := false;
  v_has_next boolean := false;
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'args_required');
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trip_not_found');
  END IF;

  IF v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'driver_mismatch');
  END IF;

  IF v_trip.status IN ('completed', 'cancelled', 'canceled', 'no_show', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trip_terminal', 'trip_status', v_trip.status);
  END IF;

  -- Idempotent already started
  IF v_trip.started_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'already_started', true,
      'already_finalized', v_trip.pickup_waiting_finalized_at IS NOT NULL,
      'charge_pence', COALESCE(v_trip.pickup_waiting_charge_pence, 0),
      'intervals_charged', COALESCE(v_trip.pickup_waiting_intervals_charged, 0),
      'counted_seconds', COALESCE(v_trip.pickup_waiting_counted_seconds, 0),
      'started_at', v_trip.started_at,
      'status', v_trip.status,
      'current_stop_index', v_trip.current_stop_index,
      'current_stop_id', v_trip.current_stop_id
    );
  END IF;

  SELECT * INTO v_pickup
  FROM public.trip_stops
  WHERE trip_id = p_trip_id
    AND stop_index = 0
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'pickup_stop_not_found');
  END IF;

  -- Require arrived (Edge may auto-arrive before calling; RPC does not invent arrival)
  IF v_pickup.arrived_at IS NULL AND v_trip.arrived_at IS NULL AND v_trip.pickup_arrived_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'must_arrive_pickup');
  END IF;

  -- Money finalize (same transaction)
  v_money := public.finalize_pickup_waiting_charge(
    p_trip_id, p_driver_id, p_now, p_body_lat, p_body_lng
  );
  IF COALESCE((v_money->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_money;
  END IF;
  v_already := COALESCE((v_money->>'already_finalized')::boolean, false);

  UPDATE public.trip_stops
  SET
    status = 'completed',
    arrived_at = COALESCE(arrived_at, p_now),
    completed_at = COALESCE(completed_at, p_now),
    updated_at = p_now
  WHERE id = v_pickup.id;

  SELECT * INTO v_next
  FROM public.trip_stops
  WHERE trip_id = p_trip_id
    AND stop_index > 0
    AND status IS DISTINCT FROM 'skipped'
  ORDER BY stop_index ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_has_next := true;
    UPDATE public.trip_stops
    SET status = 'current', updated_at = p_now
    WHERE id = v_next.id;

    UPDATE public.trips
    SET
      started_at = p_now,
      status = 'in_progress',
      current_stop_index = v_next.stop_index,
      current_destination_index = v_next.stop_index,
      current_destination_type = v_next.type,
      current_stop_id = v_next.id,
      -- Reset trip-level stop waiting mirrors for next leg (do NOT touch stop segment money)
      stop_waiting_status = CASE WHEN v_next.type = 'stop' THEN 'none' ELSE NULL END,
      stop_arrived_at = NULL,
      stop_waiting_started_at = NULL,
      stop_waiting_paid_started_at = NULL,
      stop_waiting_finalized_at = NULL,
      stop_waiting_charge_amount = 0,
      updated_at = p_now
    WHERE id = p_trip_id;
  ELSE
    UPDATE public.trips
    SET
      started_at = p_now,
      status = 'in_progress',
      updated_at = p_now
    WHERE id = p_trip_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'already_finalized', v_already,
    'charge_pence', COALESCE((v_money->>'charge_pence')::int, 0),
    'intervals_charged', COALESCE((v_money->>'intervals_charged')::int, 0),
    'counted_seconds', COALESCE((v_money->>'counted_seconds')::int, 0),
    'paid_seconds', COALESCE((v_money->>'paid_seconds')::int, 0),
    'free_seconds', COALESCE((v_money->>'free_seconds')::int, 0),
    'inside_at_finalize', (v_money->>'inside_at_finalize')::boolean,
    'distance_meters', (v_money->>'distance_meters')::double precision,
    'used_source', v_money->>'used_source',
    'started_at', p_now,
    'status', 'in_progress',
    'pickup_stop_id', v_pickup.id,
    'next_stop_index', CASE WHEN v_has_next THEN v_next.stop_index ELSE NULL END,
    'next_stop_id', CASE WHEN v_has_next THEN v_next.id ELSE NULL END,
    'next_stop_type', CASE WHEN v_has_next THEN v_next.type ELSE NULL END,
    'is_final_next', CASE WHEN v_has_next THEN v_next.type = 'dropoff' ELSE NULL END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_pickup_waiting_charge(uuid, uuid, timestamptz, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_pickup_waiting_charge(uuid, uuid, timestamptz, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_pickup_waiting_charge(uuid, uuid, timestamptz, double precision, double precision) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_pickup_waiting_charge(uuid, uuid, timestamptz, double precision, double precision) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_pickup_waiting_and_start_trip(uuid, uuid, timestamptz, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_pickup_waiting_and_start_trip(uuid, uuid, timestamptz, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_pickup_waiting_and_start_trip(uuid, uuid, timestamptz, double precision, double precision) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_pickup_waiting_and_start_trip(uuid, uuid, timestamptz, double precision, double precision) TO service_role;
