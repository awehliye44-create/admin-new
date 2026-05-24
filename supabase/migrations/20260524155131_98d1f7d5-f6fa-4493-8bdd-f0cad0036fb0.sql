-- =========================================================
-- Phase 1: Production dispatcher hardening
-- =========================================================

-- 1. Wave snapshot table
CREATE TABLE IF NOT EXISTS public.dispatch_wave_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  dispatch_round integer NOT NULL,
  trigger_reason text NOT NULL DEFAULT 'auto',
  wave_cap integer NOT NULL DEFAULT 0,
  search_radius_meters integer NOT NULL DEFAULT 0,
  candidate_count integer NOT NULL DEFAULT 0,
  eligible_count integer NOT NULL DEFAULT 0,
  degraded_count integer NOT NULL DEFAULT 0,
  hard_excluded_count integer NOT NULL DEFAULT 0,
  selected_count integer NOT NULL DEFAULT 0,
  offer_created_count integer NOT NULL DEFAULT 0,
  selected_drivers jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_round_drivers jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason_for_next_wave text,
  errors jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wave_snapshots_trip_created
  ON public.dispatch_wave_snapshots(trip_id, created_at DESC);
ALTER TABLE public.dispatch_wave_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wave_snapshots_deny_all" ON public.dispatch_wave_snapshots;
CREATE POLICY "wave_snapshots_deny_all"
  ON public.dispatch_wave_snapshots FOR ALL
  USING (false) WITH CHECK (false);

-- 2. Round-advance idempotency table
CREATE TABLE IF NOT EXISTS public.dispatch_round_advance_log (
  trip_id uuid NOT NULL,
  previous_round integer NOT NULL,
  trigger_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, previous_round, trigger_reason)
);
ALTER TABLE public.dispatch_round_advance_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "round_advance_log_deny_all" ON public.dispatch_round_advance_log;
CREATE POLICY "round_advance_log_deny_all"
  ON public.dispatch_round_advance_log FOR ALL
  USING (false) WITH CHECK (false);

-- 3. dispatch_trip_offers — full rewrite using global_dispatch_settings
CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(
  p_trip_id uuid,
  p_trigger_reason text DEFAULT 'auto'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip            public.trips%ROWTYPE;
  v_g               public.global_dispatch_settings%ROWTYPE;
  v_now             timestamptz := now();
  v_round           integer;
  v_max_rounds      integer := 3;
  v_wave_cap        integer;
  v_radius          integer;
  v_max_radius      integer;
  v_expiry_secs     integer;
  v_expires_at      timestamptz;
  v_presence_max_age int := 60;
  v_inserted        integer := 0;
  v_candidate_count int := 0;
  v_eligible_count  int := 0;
  v_degraded_count  int := 0;
  v_hard_excl_count int := 0;
  v_selected_count  int := 0;
  v_selected_json   jsonb := '[]'::jsonb;
  v_previous_json   jsonb := '[]'::jsonb;
  v_advance_id      text;
  v_prev_round      integer;
  v_locked_driver   record;
BEGIN
  -- Lock trip row & basic existence
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  v_prev_round := COALESCE(v_trip.current_broadcast_round, 0);

  -- Idempotent round-advance guard: (trip_id, previous_round, trigger_reason)
  BEGIN
    INSERT INTO public.dispatch_round_advance_log(trip_id, previous_round, trigger_reason)
    VALUES (p_trip_id, v_prev_round, COALESCE(p_trigger_reason, 'auto'));
  EXCEPTION WHEN unique_violation THEN
    -- Already handled by another caller
    RETURN;
  END;

  -- =====================================================
  -- Scan & Go (locked driver) branch — preserve behaviour
  -- =====================================================
  IF v_trip.scan_go = true OR COALESCE(v_trip.broadcast_enabled, true) = false THEN
    IF v_trip.locked_driver_id IS NULL THEN
      RAISE EXCEPTION 'Scan & Go trip % missing locked_driver_id', p_trip_id;
    END IF;

    IF EXISTS (SELECT 1 FROM public.ride_offers ro WHERE ro.trip_id = p_trip_id) THEN
      RETURN;
    END IF;

    IF v_trip.locked_driver_id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])) THEN
      UPDATE public.trips
        SET status = 'expired', dispatch_status = 'expired', updated_at = v_now
        WHERE id = p_trip_id AND status NOT IN ('completed', 'cancelled', 'expired');
      RETURN;
    END IF;

    SELECT d.id, d.is_online, d.approval_status, d.current_trip_id, dp.status AS presence_status,
           dp.push_token, dp.last_heartbeat_at, COALESCE(dp.lat, d.current_lat) AS lat,
           COALESCE(dp.lng, d.current_lng) AS lng
      INTO v_locked_driver
      FROM public.drivers d
      LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
     WHERE d.id = v_trip.locked_driver_id;

    IF NOT FOUND
       OR v_locked_driver.approval_status <> 'approved'
       OR v_locked_driver.is_online IS NOT TRUE
       OR v_locked_driver.current_trip_id IS NOT NULL
       OR v_locked_driver.push_token IS NULL
       OR v_locked_driver.push_token = ''
       OR v_locked_driver.last_heartbeat_at IS NULL
       OR v_locked_driver.last_heartbeat_at <= v_now - make_interval(secs => v_presence_max_age)
    THEN
      UPDATE public.trips
        SET status = 'expired', dispatch_status = 'expired',
            cancel_reason = 'scan_go_driver_unavailable', updated_at = v_now
        WHERE id = p_trip_id AND status NOT IN ('completed', 'cancelled', 'expired');
      RETURN;
    END IF;

    SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
    v_expires_at := v_now + make_interval(secs => COALESCE(
      v_g.locked_driver_response_minutes * 60, v_g.offer_expiry_seconds, 30
    ));

    INSERT INTO public.ride_offers (
      trip_id, driver_id, status, expires_at, distance_meters, broadcast_round, offered_at,
      is_urgent_dispatch, delivery_phase, offer_snapshot
    )
    VALUES (
      p_trip_id,
      v_trip.locked_driver_id,
      'pending',
      v_expires_at,
      round(public.haversine_meters(
        v_trip.pickup_latitude, v_trip.pickup_longitude,
        v_locked_driver.lat, v_locked_driver.lng
      ))::int,
      1,
      v_now,
      true,
      'scan_and_go',
      jsonb_build_object('scan_and_go', true, 'locked_driver', true, 'trigger_reason', p_trigger_reason)
    );

    UPDATE public.trips
      SET status = 'offered',
          dispatch_status = 'locked_driver_offered',
          dispatch_mode = 'locked_driver',
          broadcast_enabled = false,
          current_offer_driver_id = v_trip.locked_driver_id,
          negotiation_owner_driver_id = v_trip.locked_driver_id,
          current_broadcast_round = 1,
          broadcast_started_at = COALESCE(v_trip.broadcast_started_at, v_now),
          last_broadcast_at = v_now,
          updated_at = v_now
      WHERE id = p_trip_id;
    RETURN;
  END IF;

  -- =====================================================
  -- Standard broadcast branch
  -- =====================================================
  IF v_trip.negotiation_owner_driver_id IS NOT NULL OR v_trip.status = 'negotiating' THEN
    RETURN;
  END IF;
  IF v_trip.driver_id IS NOT NULL THEN RETURN; END IF;
  IF v_trip.status IS NULL OR v_trip.status NOT IN (
    'pending', 'searching', 'broadcasting', 'offered', 'offering', 'searching_new_driver'
  ) THEN RETURN; END IF;
  IF v_trip.status IN ('completed', 'cancelled', 'expired', 'declined') THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM public.ride_offers ro
    WHERE ro.trip_id = p_trip_id
      AND ro.status IN ('pending', 'accepted', 'countered')
      AND (
        ro.negotiation_status IN ('waiting_customer', 'waiting_driver', 'waiting_driver_final')
        OR ro.expires_at > v_now
      )
  ) THEN
    RETURN;
  END IF;

  -- Single source of truth
  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'global_dispatch_settings singleton missing';
  END IF;

  v_round      := v_prev_round + 1;
  v_max_radius := v_g.max_radius_meters;

  -- Wave-specific settings (NO hardcoded fallback values — settings must exist)
  CASE
    WHEN v_round = 1 THEN
      v_wave_cap    := v_g.wave1_size;
      v_radius      := v_g.start_radius_meters;
      v_expiry_secs := v_g.wave1_offer_expiry_seconds;
    WHEN v_round = 2 THEN
      v_wave_cap    := v_g.wave2_size;
      v_radius      := v_g.expand_radius_meters;
      v_expiry_secs := v_g.wave2_offer_expiry_seconds;
    ELSE
      v_wave_cap    := v_g.wave3_size;
      v_radius      := v_g.max_radius_meters;
      v_expiry_secs := v_g.wave3_offer_expiry_seconds;
  END CASE;

  IF v_radius IS NULL OR v_wave_cap IS NULL OR v_expiry_secs IS NULL THEN
    RAISE EXCEPTION 'global_dispatch_settings missing wave configuration for round %', v_round;
  END IF;

  v_radius := LEAST(v_radius, COALESCE(v_max_radius, v_radius));

  IF v_round > v_max_rounds THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN;
  END IF;

  v_expires_at := v_now + make_interval(secs => v_expiry_secs);

  -- Snapshot of previous-round drivers (for trace)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'ride_offer_id', id, 'driver_id', driver_id, 'status', status,
           'broadcast_round', broadcast_round
         )), '[]'::jsonb)
    INTO v_previous_json
    FROM public.ride_offers
   WHERE trip_id = p_trip_id;

  -- Build candidate set in temp table (for logging + selection)
  DROP TABLE IF EXISTS _disp_candidates;
  CREATE TEMP TABLE _disp_candidates ON COMMIT DROP AS
  WITH base AS (
    SELECT
      d.id              AS driver_id,
      d.driver_code,
      d.service_area_id,
      d.region_id,
      d.category_id,
      d.current_trip_id,
      d.last_offer_at,
      d.last_trip_end_at,
      dp.status         AS presence_status,
      dp.presence_health,
      dp.push_token,
      dp.socket_connected,
      dp.last_heartbeat_at,
      dp.offline_reason,
      COALESCE(dp.lat, d.current_lat) AS lat,
      COALESCE(dp.lng, d.current_lng) AS lng
    FROM public.drivers d
    LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
    WHERE d.approval_status = 'approved'
      AND d.documents_approved = true
      AND d.is_online = true
      AND COALESCE(d.driver_online_intent, false) = true
      AND NOT public.is_explicit_offline_reason(dp.offline_reason)
      AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
      AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
      AND NOT (COALESCE(dp.lat, d.current_lat) = 0 AND COALESCE(dp.lng, d.current_lng) = 0)
      AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
      AND NOT (d.id = ANY (COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[])))
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id
          AND ro.driver_id = d.id
          AND ro.status IN ('pending','declined','accepted','revoked','countered','expired')
      )
  ),
  active_counts AS (
    SELECT t.driver_id, count(*)::int AS active_count
      FROM public.trips t
     WHERE t.driver_id IS NOT NULL
       AND t.status IN ('driver_assigned','accepted','en_route_pickup','arrived','in_progress','pickup_in_progress')
     GROUP BY t.driver_id
  )
  SELECT
    b.*,
    public.haversine_meters(v_trip.pickup_latitude, v_trip.pickup_longitude, b.lat, b.lng) AS distance_m,
    COALESCE(ac.active_count, 0) AS active_count,
    (b.push_token IS NOT NULL AND b.push_token <> '')                                       AS has_push,
    (COALESCE(b.socket_connected, false) = true)                                            AS has_realtime,
    (b.last_heartbeat_at IS NOT NULL
      AND b.last_heartbeat_at > v_now - make_interval(secs => v_presence_max_age))          AS healthy_heartbeat,
    (COALESCE(b.presence_health, 'healthy') = 'degraded')                                   AS is_degraded,
    (v_trip.service_area_id IS NULL OR b.service_area_id = v_trip.service_area_id)          AS sa_match,
    (v_trip.region_id       IS NULL OR b.region_id       = v_trip.region_id)                AS region_match,
    (b.current_trip_id IS NULL)                                                             AS is_idle
  FROM base b
  LEFT JOIN active_counts ac ON ac.driver_id = b.driver_id;

  -- Eligibility evaluation
  DROP TABLE IF EXISTS _disp_eval;
  CREATE TEMP TABLE _disp_eval ON COMMIT DROP AS
  SELECT
    c.*,
    (
      c.current_trip_id IS NOT NULL
      AND COALESCE(v_g.stacked_rides_enabled, false) = true
      AND c.active_count < COALESCE(v_g.max_stacked_rides, 1)
      AND c.distance_m <= COALESCE(v_g.stacked_search_radius_meters, c.distance_m)
    ) AS stack_ok,
    CASE
      WHEN c.distance_m > v_radius                              THEN 'out_of_radius'
      WHEN NOT c.sa_match                                       THEN 'service_area_mismatch'
      WHEN NOT c.region_match                                   THEN 'region_mismatch'
      WHEN NOT c.healthy_heartbeat                              THEN 'stale_heartbeat'
      WHEN NOT (c.has_push OR c.has_realtime)                   THEN 'no_delivery_channel'
      WHEN c.presence_health = 'offline'                        THEN 'presence_offline'
      ELSE NULL
    END AS reject_reason
  FROM _disp_candidates c;

  -- Apply busy/stacked rule on top
  UPDATE _disp_eval
     SET reject_reason = COALESCE(reject_reason,
       CASE WHEN NOT is_idle AND NOT stack_ok THEN 'busy_no_stack' ELSE NULL END);

  -- Compute score (lower = better)
  DROP TABLE IF EXISTS _disp_scored;
  CREATE TEMP TABLE _disp_scored ON COMMIT DROP AS
  SELECT
    e.*,
    (
      e.distance_m * COALESCE(v_g.distance_penalty_per_meter, 0)::numeric
      + CASE WHEN e.is_degraded THEN 100 ELSE 0 END
      - LEAST(
          GREATEST(EXTRACT(EPOCH FROM (v_now - COALESCE(e.last_offer_at, e.last_trip_end_at, v_now)))/60.0, 0),
          COALESCE(v_g.max_waiting_bonus_minutes, 0)
        ) * COALESCE(v_g.waiting_bonus_per_minute, 0)::numeric
      - CASE
          WHEN COALESCE(v_g.fairness_idle_minutes, 0) > 0
           AND EXTRACT(EPOCH FROM (v_now - COALESCE(e.last_offer_at, e.last_trip_end_at, v_now)))/60.0
               >= v_g.fairness_idle_minutes
          THEN COALESCE(v_g.fairness_boost_score, 0)
          ELSE 0
        END
    )::numeric AS score
  FROM _disp_eval e;

  -- Log every considered driver
  PERFORM public.log_dispatch_eligibility(
    p_trip_id,
    s.driver_id,
    (s.reject_reason IS NULL),
    s.reject_reason,
    jsonb_build_object(
      'wave', v_round,
      'trigger_reason', p_trigger_reason,
      'driver_code', s.driver_code,
      'distance_m', s.distance_m,
      'score', s.score,
      'is_degraded', s.is_degraded,
      'sa_match', s.sa_match,
      'region_match', s.region_match,
      'has_push', s.has_push,
      'has_realtime', s.has_realtime,
      'healthy_heartbeat', s.healthy_heartbeat,
      'is_idle', s.is_idle,
      'stack_ok', s.stack_ok,
      'active_count', s.active_count,
      'hard_excluded', (s.reject_reason IS NOT NULL)
    )
  )
  FROM _disp_scored s;

  SELECT
    count(*),
    count(*) FILTER (WHERE reject_reason IS NULL),
    count(*) FILTER (WHERE is_degraded),
    count(*) FILTER (WHERE reject_reason IS NOT NULL)
  INTO v_candidate_count, v_eligible_count, v_degraded_count, v_hard_excl_count
  FROM _disp_scored;

  -- Insert offers for top eligible by score
  WITH picks AS (
    SELECT driver_id, distance_m, score, stack_ok, is_degraded
      FROM _disp_scored
     WHERE reject_reason IS NULL
     ORDER BY score ASC, distance_m ASC
     LIMIT v_wave_cap
  )
  INSERT INTO public.ride_offers (
    trip_id, driver_id, status, expires_at, distance_meters,
    broadcast_round, offered_at, is_stacked, offer_snapshot
  )
  SELECT
    p_trip_id, p.driver_id, 'pending', v_expires_at, round(p.distance_m)::int,
    v_round, v_now, p.stack_ok,
    jsonb_build_object('wave', v_round, 'score', p.score, 'trigger_reason', p_trigger_reason,
                       'degraded', p.is_degraded, 'stacked', p.stack_ok)
  FROM picks p;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_selected_count := v_inserted;

  -- Build selected snapshot with ride_offer_id
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'driver_id', ro.driver_id,
           'ride_offer_id', ro.id,
           'distance_m', ro.distance_meters,
           'is_stacked', ro.is_stacked
         )), '[]'::jsonb)
    INTO v_selected_json
   FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id AND ro.broadcast_round = v_round;

  -- Trip status update
  IF v_inserted = 0 THEN
    UPDATE public.trips
      SET current_broadcast_round = v_round,
          last_broadcast_at = v_now,
          updated_at = v_now
      WHERE id = p_trip_id;
  ELSE
    UPDATE public.trips
      SET status = 'offered',
          dispatch_status = 'broadcasting',
          current_broadcast_round = v_round,
          broadcast_started_at = COALESCE(v_trip.broadcast_started_at, v_now),
          last_broadcast_at = v_now,
          updated_at = v_now
      WHERE id = p_trip_id;
  END IF;

  -- Wave snapshot row
  INSERT INTO public.dispatch_wave_snapshots(
    trip_id, dispatch_round, trigger_reason, wave_cap, search_radius_meters,
    candidate_count, eligible_count, degraded_count, hard_excluded_count,
    selected_count, offer_created_count, selected_drivers, previous_round_drivers,
    reason_for_next_wave
  ) VALUES (
    p_trip_id, v_round, p_trigger_reason, v_wave_cap, v_radius,
    v_candidate_count, v_eligible_count, v_degraded_count, v_hard_excl_count,
    v_selected_count, v_inserted, v_selected_json, v_previous_json,
    CASE WHEN v_inserted = 0 THEN 'no_eligible_drivers' ELSE NULL END
  );

  -- If no offers were created, immediately try next wave (will be idempotency-guarded too)
  IF v_inserted = 0 THEN
    PERFORM public.maybe_advance_dispatch_after_offer_resolution(p_trip_id, NULL, 'no_eligible_drivers');
  END IF;
END;
$function$;

-- 4. maybe_advance_dispatch_after_offer_resolution — add trigger_reason
CREATE OR REPLACE FUNCTION public.maybe_advance_dispatch_after_offer_resolution(
  p_trip_id uuid,
  p_resolved_driver_id uuid DEFAULT NULL,
  p_trigger_reason text DEFAULT 'resolution'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_cancelled uuid[];
  v_excluded uuid[];
  v_pending_count int;
  v_round int;
  v_max_rounds int;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_trip.driver_id IS NOT NULL OR v_trip.confirmed_driver_id IS NOT NULL THEN RETURN; END IF;
  IF COALESCE(v_trip.scan_go, false) OR COALESCE(v_trip.broadcast_enabled, true) = false THEN RETURN; END IF;
  IF v_trip.status IN ('completed', 'cancelled', 'declined') THEN RETURN; END IF;
  IF v_trip.negotiation_owner_driver_id IS NOT NULL AND v_trip.status = 'negotiating' THEN RETURN; END IF;

  v_cancelled := COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[]);
  v_excluded  := COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[]);

  IF p_resolved_driver_id IS NOT NULL THEN
    IF NOT (p_resolved_driver_id = ANY (v_cancelled)) THEN
      v_cancelled := array_append(v_cancelled, p_resolved_driver_id);
    END IF;
    IF NOT (p_resolved_driver_id = ANY (v_excluded)) THEN
      v_excluded := array_append(v_excluded, p_resolved_driver_id);
    END IF;
    UPDATE public.trips
      SET cancelled_driver_ids = v_cancelled,
          excluded_driver_ids  = v_excluded,
          updated_at = v_now
      WHERE id = p_trip_id;
  END IF;

  SELECT count(*)::int INTO v_pending_count
    FROM public.ride_offers ro
   WHERE ro.trip_id = p_trip_id
     AND ro.status IN ('pending', 'countered')
     AND (
       ro.negotiation_status IN ('waiting_customer', 'waiting_driver', 'waiting_driver_final')
       OR ro.expires_at IS NULL
       OR ro.expires_at > v_now
     );

  IF v_pending_count > 0 THEN
    UPDATE public.trips
      SET status = 'offered',
          dispatch_status = 'broadcasting',
          driver_id = NULL,
          confirmed_driver_id = NULL,
          negotiation_owner_driver_id = NULL,
          negotiation_locked_until = NULL,
          updated_at = v_now
      WHERE id = p_trip_id
        AND status IN ('pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver');
    RETURN;
  END IF;

  v_round      := COALESCE(v_trip.current_broadcast_round, 0);
  v_max_rounds := COALESCE(v_trip.max_broadcast_rounds, 3);

  IF v_round >= v_max_rounds THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN;
  END IF;

  PERFORM public.dispatch_trip_offers(p_trip_id, COALESCE(p_trigger_reason, 'resolution'));
END;
$function$;

-- 5. expire_stale_offers — pass 'offer_expired' trigger reason
CREATE OR REPLACE FUNCTION public.expire_stale_offers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_expired_count int := 0;
  v_trip_id uuid;
  v_trip_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  WITH expired_rows AS (
    UPDATE public.ride_offers ro
       SET status = 'expired', responded_at = v_now, updated_at = v_now
     WHERE ro.status = 'pending'
       AND ro.negotiation_status IS NULL
       AND ro.expires_at IS NOT NULL
       AND ro.expires_at < v_now
    RETURNING ro.trip_id
  )
  SELECT count(*)::int, coalesce(array_agg(DISTINCT trip_id), ARRAY[]::uuid[])
    INTO v_expired_count, v_trip_ids
    FROM expired_rows;

  IF v_trip_ids IS NOT NULL THEN
    FOREACH v_trip_id IN ARRAY v_trip_ids LOOP
      PERFORM public.maybe_advance_dispatch_after_offer_resolution(v_trip_id, NULL, 'offer_expired');
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'expired_count', v_expired_count,
    'trips_needing_rebroadcast', to_jsonb(COALESCE(v_trip_ids, ARRAY[]::uuid[]))
  );
END;
$function$;

-- 6. accept_ride_offer — enforce max_stacked_rides (both overloads)
CREATE OR REPLACE FUNCTION public.accept_ride_offer(p_offer_id uuid, p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_fare_pence integer;
  v_fare_source text;
  v_original_fare_pence integer;
  v_now timestamptz := now();
  v_g public.global_dispatch_settings%ROWTYPE;
  v_active_count int;
  v_max_stack int;
BEGIN
  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND', 'message', 'Offer not found');
  END IF;
  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_MISMATCH', 'message', 'Offer not yours');
  END IF;

  IF v_offer.status = 'accepted' AND v_offer.negotiation_status = 'confirmed' THEN
    SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id;
    IF v_trip.driver_id = p_driver_id THEN
      PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);
      RETURN jsonb_build_object(
        'success', true, 'trip_id', v_offer.trip_id, 'status', v_trip.status,
        'driver_id', p_driver_id, 'final_fare_pence', v_trip.final_fare_pence,
        'fare_source', COALESCE(v_trip.fare_snapshot_json->>'fare_source', 'original_fare'),
        'idempotent', true
      );
    END IF;
  END IF;

  IF v_offer.negotiation_status IS DISTINCT FROM 'waiting_customer'
     AND NOT (COALESCE(v_offer.driver_offer_fare, 0) > 0 AND v_offer.status IN ('pending', 'countered'))
     AND NOT (v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter')
              AND COALESCE(v_offer.customer_counter_fare, 0) > 0)
     AND NOT (v_offer.negotiation_status IS NULL AND v_offer.status IN ('pending', 'countered')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_ACCEPTABLE', 'message', 'Offer is not awaiting acceptance');
  END IF;

  IF v_offer.customer_respond_by IS NOT NULL AND v_offer.customer_respond_by < v_now
     AND v_offer.negotiation_status = 'waiting_customer' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;
  IF v_offer.driver_respond_by IS NOT NULL AND v_offer.driver_respond_by < v_now
     AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Counter-offer response window expired');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;
  IF v_trip.driver_id IS NOT NULL AND v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.status NOT IN ('pending', 'searching', 'offered', 'broadcasting', 'negotiating',
                           'accepted', 'confirmed', 'driver_assigned') THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride not available for assignment');
  END IF;

  -- ====== MAX STACK ENFORCEMENT ======
  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
  v_max_stack := COALESCE(v_g.max_stacked_rides, 1);
  SELECT count(*)::int INTO v_active_count
    FROM public.trips t
   WHERE t.driver_id = p_driver_id
     AND t.id <> v_offer.trip_id
     AND t.status IN ('driver_assigned','accepted','en_route_pickup','arrived','in_progress','pickup_in_progress');
  IF v_active_count >= v_max_stack THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'MAX_STACK_REACHED',
      'message', format('Driver already at maximum stacked rides (%s).', v_max_stack),
      'active_count', v_active_count, 'max_stacked_rides', v_max_stack
    );
  END IF;
  IF v_active_count > 0 AND COALESCE(v_g.stacked_rides_enabled, false) = false THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'STACKED_RIDES_DISABLED',
      'message', 'Stacked rides are disabled. Finish current ride before accepting another.'
    );
  END IF;

  v_original_fare_pence := COALESCE(
    NULLIF(v_trip.base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.estimated_fare, 0) * 100)::integer, 0),
    NULLIF(v_trip.gross_fare_pence, 0),
    NULLIF(v_offer.counter_fare, 0),
    0
  );

  IF COALESCE(v_offer.customer_counter_fare, 0) > 0
     AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') THEN
    v_fare_pence := v_offer.customer_counter_fare;
    v_fare_source := 'customer_counter_offer';
  ELSIF COALESCE(v_offer.driver_offer_fare, 0) > 0
        AND (v_offer.negotiation_status = 'waiting_customer'
             OR (v_offer.negotiation_status IS NULL AND v_offer.status IN ('pending', 'countered'))) THEN
    v_fare_pence := v_offer.driver_offer_fare;
    v_fare_source := 'negotiated_offer';
  ELSE
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  END IF;

  IF v_fare_pence <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FARE', 'message', 'Invalid fare');
  END IF;

  UPDATE public.ride_offers
    SET status = 'accepted', negotiation_status = 'confirmed',
        responded_at = v_now,
        customer_respond_by = NULL, driver_respond_by = NULL, grace_window_expires_at = NULL,
        expires_at = v_now + interval '7 days', updated_at = v_now
    WHERE id = p_offer_id;

  UPDATE public.ride_offers
    SET status = 'revoked', revoked_reason = 'another_offer_accepted', negotiation_status = NULL,
        customer_respond_by = NULL, driver_respond_by = NULL, grace_window_expires_at = NULL,
        updated_at = v_now
    WHERE trip_id = v_offer.trip_id AND id <> p_offer_id AND status IN ('pending', 'countered');

  UPDATE public.trips
    SET status = 'driver_assigned', driver_id = p_driver_id, confirmed_driver_id = p_driver_id,
        negotiation_owner_driver_id = NULL, negotiation_locked_until = NULL, negotiation_status = NULL,
        current_offer_driver_id = NULL, current_offer_expires_at = NULL,
        dispatch_status = 'assigned', searching_expires_at = NULL, broadcast_enabled = true,
        assigned_at = COALESCE(assigned_at, v_now),
        final_fare_pence = v_fare_pence, gross_fare_pence = v_fare_pence,
        estimated_total_pence = v_fare_pence, estimated_fare = (v_fare_pence::numeric / 100),
        fare = (v_fare_pence::numeric / 100),
        base_fare_pence = COALESCE(NULLIF(base_fare_pence, 0), v_fare_pence),
        fare_locked = true,
        fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
          || jsonb_strip_nulls(jsonb_build_object(
            'fare_source', v_fare_source,
            'original_fare_pence', NULLIF(v_original_fare_pence, 0),
            'accepted_fare_pence', v_fare_pence,
            'accepted_via', 'accept_ride_offer',
            'accepted_at', v_now,
            'stacked', v_active_count > 0
          )),
        updated_at = v_now
    WHERE id = v_offer.trip_id;

  UPDATE public.drivers
    SET current_trip_id = v_offer.trip_id, updated_at = v_now
    WHERE id = p_driver_id;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers
      SET active_trip_id = v_offer.trip_id, updated_at = v_now
      WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id;
  END IF;

  PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);

  BEGIN
    PERFORM public.record_booking_delivery(
      v_offer.trip_id, 'accepted', p_driver_id, p_offer_id, 'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'fare_source', v_fare_source,
        'final_fare_pence', v_fare_pence,
        'accepted_via', 'accept_ride_offer',
        'stacked', v_active_count > 0
      ))
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[accept_ride_offer] record_booking_delivery failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true, 'trip_id', v_offer.trip_id, 'status', 'driver_assigned',
    'driver_id', p_driver_id, 'final_fare_pence', v_fare_pence,
    'fare_source', v_fare_source, 'original_fare_pence', v_original_fare_pence,
    'counter_offer_amount_pence', v_offer.customer_counter_fare,
    'accepted_via', 'accept_ride_offer', 'stacked', v_active_count > 0
  );
END;
$function$;

-- The 3-arg overload also gets stacked enforcement
CREATE OR REPLACE FUNCTION public.accept_ride_offer(
  p_offer_id uuid, p_driver_id uuid, p_allow_customer_counter boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_fare_pence integer;
  v_fare_source text;
  v_original_fare_pence integer;
  v_snapshot_base integer;
  v_now timestamptz := now();
  v_g public.global_dispatch_settings%ROWTYPE;
  v_active_count int;
  v_max_stack int;
BEGIN
  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND', 'message', 'Offer not found');
  END IF;
  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_MISMATCH', 'message', 'Offer not yours');
  END IF;

  IF v_offer.status = 'accepted' AND v_offer.negotiation_status = 'confirmed' THEN
    SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id;
    IF v_trip.driver_id = p_driver_id THEN
      PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);
      RETURN jsonb_build_object(
        'success', true, 'trip_id', v_offer.trip_id, 'status', v_trip.status,
        'driver_id', p_driver_id, 'final_fare_pence', v_trip.final_fare_pence,
        'fare_source', COALESCE(v_trip.fare_snapshot_json->>'fare_source', 'original_fare'),
        'idempotent', true
      );
    END IF;
  END IF;

  IF NOT p_allow_customer_counter
     AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter')
     AND COALESCE(v_offer.customer_counter_fare, 0) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'COUNTER_PENDING',
      'message', 'Use Accept fare to accept the customer counter-offer');
  END IF;

  IF v_offer.status NOT IN ('pending', 'countered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_PENDING',
      'message', 'Offer already ' || COALESCE(v_offer.status, 'handled'));
  END IF;

  IF v_offer.customer_respond_by IS NOT NULL AND v_offer.customer_respond_by < v_now
     AND v_offer.negotiation_status = 'waiting_customer' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;
  IF v_offer.expires_at IS NOT NULL AND v_offer.expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;
  IF public.is_future_scheduled_reservation_trip(v_trip, v_offer) THEN
    RETURN jsonb_build_object('success', false, 'error', 'SCHEDULED_RESERVATION_REQUIRED',
      'message', 'This is a future scheduled booking. Confirm it from Scheduled Jobs.');
  END IF;
  IF v_trip.driver_id IS NOT NULL AND v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.status NOT IN ('pending', 'searching', 'offered', 'broadcasting', 'negotiating',
                           'accepted', 'confirmed', 'driver_assigned') THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride not available for assignment');
  END IF;

  -- ====== MAX STACK ENFORCEMENT ======
  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
  v_max_stack := COALESCE(v_g.max_stacked_rides, 1);
  SELECT count(*)::int INTO v_active_count
    FROM public.trips t
   WHERE t.driver_id = p_driver_id
     AND t.id <> v_offer.trip_id
     AND t.status IN ('driver_assigned','accepted','en_route_pickup','arrived','in_progress','pickup_in_progress');
  IF v_active_count >= v_max_stack THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'MAX_STACK_REACHED',
      'message', format('Driver already at maximum stacked rides (%s).', v_max_stack),
      'active_count', v_active_count, 'max_stacked_rides', v_max_stack
    );
  END IF;
  IF v_active_count > 0 AND COALESCE(v_g.stacked_rides_enabled, false) = false THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'STACKED_RIDES_DISABLED',
      'message', 'Stacked rides are disabled. Finish current ride before accepting another.'
    );
  END IF;

  v_snapshot_base := NULLIF(
    COALESCE(
      (v_offer.offer_snapshot->>'baseFarePence')::integer,
      (v_offer.offer_snapshot->>'base_fare_pence')::integer,
      (v_trip.fare_snapshot_json->>'original_fare_pence')::integer,
      (v_trip.fare_snapshot_json->>'base_fare_pence')::integer,
      (v_trip.fare_snapshot_json->>'accepted_fare_pence')::integer
    ), 0);

  v_original_fare_pence := COALESCE(
    NULLIF(v_trip.base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.estimated_fare, 0) * 100)::integer, 0),
    NULLIF(v_trip.gross_fare_pence, 0),
    v_snapshot_base,
    NULLIF(v_offer.driver_offer_fare, 0),
    NULLIF(v_offer.counter_fare, 0),
    0);

  IF p_allow_customer_counter
     AND COALESCE(v_offer.customer_counter_fare, 0) > 0
     AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') THEN
    v_fare_pence := v_offer.customer_counter_fare;
    v_fare_source := 'customer_counter_offer';
  ELSE
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  END IF;

  IF v_fare_pence <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FARE', 'message', 'Invalid fare');
  END IF;

  UPDATE public.ride_offers
    SET status = 'accepted', negotiation_status = 'confirmed',
        driver_offer_fare = CASE WHEN v_fare_source = 'customer_counter_offer' THEN v_fare_pence
                                 ELSE driver_offer_fare END,
        counter_fare      = CASE WHEN v_fare_source = 'customer_counter_offer' THEN v_fare_pence
                                 ELSE counter_fare END,
        responded_at = v_now,
        customer_respond_by = NULL, driver_respond_by = NULL, grace_window_expires_at = NULL,
        expires_at = v_now + interval '7 days', updated_at = v_now
    WHERE id = p_offer_id;

  UPDATE public.ride_offers
    SET status = 'revoked', revoked_reason = 'another_offer_accepted', negotiation_status = NULL,
        customer_respond_by = NULL, driver_respond_by = NULL, grace_window_expires_at = NULL,
        updated_at = v_now
    WHERE trip_id = v_offer.trip_id AND id <> p_offer_id AND status IN ('pending', 'countered');

  UPDATE public.trips
    SET status = 'driver_assigned', driver_id = p_driver_id, confirmed_driver_id = p_driver_id,
        negotiation_owner_driver_id = NULL, negotiation_locked_until = NULL, negotiation_status = NULL,
        current_offer_driver_id = NULL, current_offer_expires_at = NULL,
        dispatch_status = 'assigned', searching_expires_at = NULL, broadcast_enabled = true,
        assigned_at = COALESCE(assigned_at, v_now),
        final_fare_pence = v_fare_pence, gross_fare_pence = v_fare_pence,
        estimated_total_pence = v_fare_pence, estimated_fare = (v_fare_pence::numeric / 100),
        fare = (v_fare_pence::numeric / 100),
        base_fare_pence = COALESCE(NULLIF(base_fare_pence, 0), v_fare_pence),
        fare_locked = true,
        fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
          || jsonb_strip_nulls(jsonb_build_object(
            'fare_source', v_fare_source,
            'original_fare_pence', NULLIF(v_original_fare_pence, 0),
            'negotiated_fare_pence', CASE WHEN v_fare_source = 'original_fare' THEN NULL ELSE v_fare_pence END,
            'counter_offer_amount_pence', CASE
              WHEN v_fare_source = 'customer_counter_offer' THEN v_offer.customer_counter_fare ELSE NULL END,
            'accepted_fare_pence', v_fare_pence,
            'accepted_via', CASE
              WHEN v_fare_source = 'customer_counter_offer' THEN 'driver_accept_counter_offer'
              ELSE 'accept_ride_offer' END,
            'accepted_at', v_now,
            'stacked', v_active_count > 0
          )),
        updated_at = v_now
    WHERE id = v_offer.trip_id;

  UPDATE public.drivers
    SET current_trip_id = v_offer.trip_id, updated_at = v_now
    WHERE id = p_driver_id;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers
      SET active_trip_id = v_offer.trip_id, updated_at = v_now
      WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id;
  END IF;

  PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);

  BEGIN
    PERFORM public.record_booking_delivery(
      v_offer.trip_id, 'accepted', p_driver_id, p_offer_id, 'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'fare_source', v_fare_source, 'final_fare_pence', v_fare_pence,
        'counter_offer_amount_pence', CASE WHEN v_fare_source = 'customer_counter_offer' THEN v_offer.customer_counter_fare ELSE NULL END,
        'accepted_via', CASE WHEN v_fare_source = 'customer_counter_offer' THEN 'driver_accept_counter_offer' ELSE 'accept_ride_offer' END,
        'stacked', v_active_count > 0
      ))
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[accept_ride_offer] record_booking_delivery failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true, 'trip_id', v_offer.trip_id, 'status', 'driver_assigned',
    'driver_id', p_driver_id, 'final_fare_pence', v_fare_pence, 'fare_source', v_fare_source,
    'accepted_via', CASE WHEN v_fare_source = 'customer_counter_offer' THEN 'driver_accept_counter_offer' ELSE 'accept_ride_offer' END,
    'stacked', v_active_count > 0
  );
END;
$function$;
