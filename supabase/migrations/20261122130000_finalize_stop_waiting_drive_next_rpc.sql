-- Phase 4 Drive Next: one transactional stop-waiting finalize (+ optional leg advance).
-- Replaces Edge sequential geofence/close/sum/stop-update/rollup round-trips.
-- Money SSOT unchanged: counted in-radius seconds − grace × rate; fail-closed without trusted GPS.
-- Chronological timestamp AFTER applied 20261122120000 (do not rename that migration).

CREATE OR REPLACE FUNCTION public.finalize_stop_waiting_charge(
  p_trip_id uuid,
  p_stop_id uuid,
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
  v_stop public.trip_stops%ROWTYPE;
  v_grace int := 0;
  v_rate int := 0;
  v_max_minutes int := NULL;
  v_radius_enabled boolean := true;
  v_radius_m int := 100;
  v_enable boolean := true;
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
  v_total_roll int := 0;
BEGIN
  IF p_trip_id IS NULL OR p_stop_id IS NULL OR p_driver_id IS NULL THEN
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

  SELECT * INTO v_stop
  FROM public.trip_stops
  WHERE id = p_stop_id
  FOR UPDATE;

  IF NOT FOUND OR v_stop.trip_id IS DISTINCT FROM p_trip_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'stop_not_found');
  END IF;

  IF v_stop.type IS DISTINCT FROM 'stop' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_finalized', true,
      'charge_pence', 0,
      'counted_seconds', 0,
      'skipped', 'not_intermediate_stop'
    );
  END IF;

  -- Idempotent: already finalized
  IF v_stop.waiting_stopped_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_finalized', true,
      'charge_pence', COALESCE(v_stop.waiting_total_amount_pence, 0),
      'counted_seconds', COALESCE(v_stop.waiting_total_seconds, 0),
      'stop_id', v_stop.id
    );
  END IF;

  IF v_stop.waiting_charge_active IS NOT TRUE OR v_stop.waiting_started_at IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_finalized', false,
      'charge_pence', 0,
      'counted_seconds', 0,
      'skipped', 'waiting_not_active',
      'stop_id', v_stop.id
    );
  END IF;

  -- Admin SSOT: stop_waiting_settings > dispatch_settings (enable on dispatch).
  SELECT
    COALESCE(sws.stop_waiting_grace_period_seconds, ds.stop_waiting_grace_period_seconds, 0),
    COALESCE(sws.stop_waiting_rate_pence_per_minute, ds.stop_waiting_rate_pence_per_minute, 0),
    COALESCE(sws.stop_waiting_max_minutes, ds.stop_waiting_max_minutes),
    COALESCE(sws.stop_radius_enabled, ds.stop_radius_enabled, true),
    COALESCE(NULLIF(sws.stop_radius_meters, 0), NULLIF(ds.stop_radius_meters, 0), 100),
    COALESCE(ds.enable_stop_waiting_charge, true)
  INTO v_grace, v_rate, v_max_minutes, v_radius_enabled, v_radius_m, v_enable
  FROM (SELECT 1) AS _
  LEFT JOIN public.stop_waiting_settings sws
    ON sws.service_area_id IS NOT DISTINCT FROM v_trip.service_area_id
  LEFT JOIN public.dispatch_settings ds
    ON ds.service_area_id IS NOT DISTINCT FROM v_trip.service_area_id
  LIMIT 1;

  v_grace := GREATEST(0, COALESCE(v_grace, 0));
  v_rate := GREATEST(0, COALESCE(v_rate, 0));
  v_radius_m := GREATEST(1, COALESCE(v_radius_m, 100));

  IF v_enable IS FALSE THEN
    UPDATE public.trip_stops
    SET
      waiting_charge_active = false,
      waiting_stopped_at = p_now,
      waiting_total_amount_pence = 0,
      waiting_total_seconds = 0,
      last_waiting_charge_update_at = p_now,
      updated_at = p_now
    WHERE id = v_stop.id;

    RETURN jsonb_build_object(
      'ok', true,
      'already_finalized', false,
      'charge_pence', 0,
      'counted_seconds', 0,
      'skipped', 'stop_waiting_disabled',
      'stop_id', v_stop.id
    );
  END IF;

  -- Trusted GPS ladder (fail closed for money when missing/stale). Max age 45s.
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

  IF v_stop.lat IS NULL OR v_stop.lng IS NULL THEN
    v_inside := false;
    v_used_source := 'no_stop_coords';
  ELSIF NOT v_radius_enabled THEN
    v_inside := true;
    v_used_source := 'radius_disabled';
    v_distance_m := NULL;
  ELSIF v_trusted_source IS NULL OR v_trusted_lat IS NULL OR v_trusted_lng IS NULL THEN
    -- Fail closed: no trusted fix → no chargeable open accrual; body cannot invent money.
    v_inside := false;
    v_used_source := 'no_trusted_location';
    v_distance_m := NULL;
  ELSE
    v_distance_m := public.haversine_meters(
      v_trusted_lat, v_trusted_lng, v_stop.lat, v_stop.lng
    );
    v_inside := v_distance_m <= v_radius_m;
    v_used_source := v_trusted_source;
  END IF;

  -- Open segment for THIS stop only
  SELECT s.id INTO v_open_id
  FROM public.trip_waiting_segments s
  WHERE s.trip_id = p_trip_id
    AND s.location_type = 'stop'
    AND s.stop_id = p_stop_id
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

  -- Close any remaining open segments for this stop (inside or after outside close)
  UPDATE public.trip_waiting_segments
  SET ended_at = p_now
  WHERE trip_id = p_trip_id
    AND location_type = 'stop'
    AND stop_id = p_stop_id
    AND ended_at IS NULL;

  -- Sum counted in-radius seconds for this stop only
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
    AND s.location_type = 'stop'
    AND s.stop_id = p_stop_id;

  v_paid := GREATEST(0, v_counted - v_grace);
  IF v_max_minutes IS NOT NULL AND v_max_minutes > 0 THEN
    v_paid := LEAST(v_paid, v_max_minutes * 60);
  END IF;
  IF v_paid <= 0 OR v_rate <= 0 THEN
    v_charge := 0;
  ELSE
    v_charge := ROUND((v_paid::numeric / 60.0) * v_rate)::int;
  END IF;

  UPDATE public.trip_stops
  SET
    waiting_charge_active = false,
    waiting_stopped_at = p_now,
    waiting_total_amount_pence = v_charge,
    waiting_total_seconds = v_counted,
    last_waiting_charge_update_at = p_now,
    updated_at = p_now
  WHERE id = v_stop.id;

  SELECT COALESCE(SUM(COALESCE(ts.waiting_total_amount_pence, 0)), 0)
  INTO v_total_roll
  FROM public.trip_stops ts
  WHERE ts.trip_id = p_trip_id;

  UPDATE public.trips
  SET
    total_waiting_charge_pence = v_total_roll,
    stop_waiting_charge_pence = v_total_roll,
    stop_charge_total_pence = v_total_roll,
    stop_waiting_counted_seconds = v_counted,
    waiting_geofence_status = 'not_started',
    waiting_geofence_checked_at = p_now,
    waiting_geofence_distance_m = v_distance_m,
    updated_at = p_now
  WHERE id = p_trip_id;

  RETURN jsonb_build_object(
    'ok', true,
    'already_finalized', false,
    'charge_pence', v_charge,
    'counted_seconds', v_counted,
    'paid_seconds', v_paid,
    'grace_seconds', v_grace,
    'rate_pence_per_minute', v_rate,
    'inside_at_finalize', v_inside,
    'distance_meters', v_distance_m,
    'used_source', v_used_source,
    'stop_id', v_stop.id,
    'rollup_pence', v_total_roll
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_stop_waiting_and_drive_to_next(
  p_trip_id uuid,
  p_stop_id uuid,
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
  v_stop public.trip_stops%ROWTYPE;
  v_next public.trip_stops%ROWTYPE;
  v_money jsonb;
  v_already boolean := false;
BEGIN
  IF p_trip_id IS NULL OR p_stop_id IS NULL OR p_driver_id IS NULL THEN
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

  IF v_trip.started_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_started');
  END IF;

  SELECT * INTO v_stop
  FROM public.trip_stops
  WHERE id = p_stop_id
  FOR UPDATE;

  IF NOT FOUND OR v_stop.trip_id IS DISTINCT FROM p_trip_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'stop_not_found');
  END IF;

  -- Idempotent: already advanced past this stop
  IF v_stop.status = 'completed' THEN
    SELECT * INTO v_next
    FROM public.trip_stops
    WHERE trip_id = p_trip_id
      AND stop_index > v_stop.stop_index
      AND status = 'current'
    ORDER BY stop_index ASC
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'already_finalized', true,
        'charge_pence', COALESCE(v_stop.waiting_total_amount_pence, 0),
        'counted_seconds', COALESCE(v_stop.waiting_total_seconds, 0),
        'previous_index', v_stop.stop_index,
        'new_index', v_next.stop_index,
        'new_stop_id', v_next.id,
        'new_stop_type', v_next.type,
        'is_final', v_next.type = 'dropoff',
        'stop_id', v_stop.id
      );
    END IF;
  END IF;

  IF v_stop.type = 'dropoff' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'use_complete_trip');
  END IF;

  IF v_stop.type = 'stop' AND v_stop.arrived_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'must_arrive_at_stop');
  END IF;

  -- Money finalize (same transaction — nested call shares txn in plpgsql)
  v_money := public.finalize_stop_waiting_charge(
    p_trip_id, p_stop_id, p_driver_id, p_now, p_body_lat, p_body_lng
  );
  IF COALESCE((v_money->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_money;
  END IF;
  v_already := COALESCE((v_money->>'already_finalized')::boolean, false);

  -- Re-read stop after money write
  SELECT * INTO v_stop FROM public.trip_stops WHERE id = p_stop_id;

  UPDATE public.trip_stops
  SET
    status = 'completed',
    arrived_at = COALESCE(arrived_at, p_now),
    completed_at = COALESCE(completed_at, p_now),
    updated_at = p_now
  WHERE id = p_stop_id;

  SELECT * INTO v_next
  FROM public.trip_stops
  WHERE trip_id = p_trip_id
    AND stop_index > v_stop.stop_index
    AND status IS DISTINCT FROM 'skipped'
  ORDER BY stop_index ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_next_stop') || v_money;
  END IF;

  UPDATE public.trip_stops
  SET status = 'current', updated_at = p_now
  WHERE id = v_next.id;

  -- Advance next leg. Waiting money persists on trip_stops + trip rollup columns
  -- from finalize_stop_waiting_charge; trip-level stop_waiting_* mirrors reset for next stop.
  UPDATE public.trips
  SET
    current_stop_index = v_next.stop_index,
    current_destination_index = v_next.stop_index,
    current_destination_type = v_next.type,
    current_stop_id = v_next.id,
    stop_arrived_at = NULL,
    stop_waiting_started_at = NULL,
    stop_waiting_paid_started_at = NULL,
    stop_waiting_finalized_at = NULL,
    stop_waiting_status = CASE WHEN v_next.type = 'stop' THEN 'none' ELSE NULL END,
    stop_waiting_charge_amount = 0,
    updated_at = p_now
  WHERE id = p_trip_id;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'already_finalized', v_already,
    'charge_pence', COALESCE((v_money->>'charge_pence')::int, 0),
    'counted_seconds', COALESCE((v_money->>'counted_seconds')::int, 0),
    'paid_seconds', COALESCE((v_money->>'paid_seconds')::int, 0),
    'grace_seconds', COALESCE((v_money->>'grace_seconds')::int, 0),
    'inside_at_finalize', (v_money->>'inside_at_finalize')::boolean,
    'distance_meters', (v_money->>'distance_meters')::double precision,
    'used_source', v_money->>'used_source',
    'previous_index', v_stop.stop_index,
    'previous_stop_id', v_stop.id,
    'new_index', v_next.stop_index,
    'new_stop_id', v_next.id,
    'new_stop_type', v_next.type,
    'is_final', v_next.type = 'dropoff',
    'stop_id', v_stop.id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_stop_waiting_charge(uuid, uuid, uuid, timestamptz, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_stop_waiting_charge(uuid, uuid, uuid, timestamptz, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_stop_waiting_charge(uuid, uuid, uuid, timestamptz, double precision, double precision) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_stop_waiting_charge(uuid, uuid, uuid, timestamptz, double precision, double precision) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_stop_waiting_and_drive_to_next(uuid, uuid, uuid, timestamptz, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_stop_waiting_and_drive_to_next(uuid, uuid, uuid, timestamptz, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_stop_waiting_and_drive_to_next(uuid, uuid, uuid, timestamptz, double precision, double precision) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_stop_waiting_and_drive_to_next(uuid, uuid, uuid, timestamptz, double precision, double precision) TO service_role;
