-- Bug #44 — JIT-aware scheduled commitment gate parity (SQL twin of Edge SSOT).
-- Accept-time atomic safeguard mirrors pre-dispatch remaining composition:
--   stackedRemaining + travelToInstantPickup + pickupWaiting + candidateDuration
--   + travel(dropoff→scheduled) + earlyArrival + safetyBuffer ≤ available
-- Hard-excludes awaiting_activation_accept and sticky/computed JIT departure deadline.
-- Does NOT change JIT activation timings, assignment, cancellation, rematch, or payment.

CREATE OR REPLACE FUNCTION public.driver_scheduled_commitment_gate(
  p_driver_id uuid,
  p_candidate_trip_id uuid,
  p_mode text DEFAULT 'additional_work'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_cand public.trips%ROWTYPE;
  v_other record;
  v_earliest record;
  v_cand_dur integer;
  v_remaining_active integer := 0;
  v_travel_to_cand integer := 0;
  v_waiting integer := 5;
  v_remaining integer := 0;
  v_cur_trip_id uuid;
  v_cur_dur integer;
  v_from_lat double precision;
  v_from_lng double precision;
  v_origin_lat double precision;
  v_origin_lng double precision;
  v_driver_lat double precision;
  v_driver_lng double precision;
  v_travel integer;
  v_travel_driver_to_sched integer;
  v_cfg record;
  v_early integer := 5;
  v_local_buf integer := 3;
  v_long_buf integer := 5;
  v_threshold integer := 30;
  v_buffer integer;
  v_deadline timestamptz;
BEGIN
  IF p_driver_id IS NULL OR p_candidate_trip_id IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'reason', NULL, 'commitment_trip_id', NULL);
  END IF;

  SELECT * INTO v_cand FROM public.trips WHERE id = p_candidate_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'reason', NULL, 'commitment_trip_id', NULL);
  END IF;

  IF p_mode = 'additional_scheduled' THEN
    -- Candidate without a schedule time cannot conflict (Edge skips the gate too).
    IF v_cand.scheduled_at IS NULL THEN
      RETURN jsonb_build_object('allowed', true, 'reason', NULL, 'commitment_trip_id', NULL);
    END IF;
    v_cand_dur := GREATEST(5, CEIL(COALESCE(NULLIF(v_cand.estimated_duration_minutes, 0), 30)))::integer;

    FOR v_other IN
      SELECT t.id, t.scheduled_at, t.pickup_latitude, t.pickup_longitude
      FROM public.trips t
      WHERE t.dispatch_mode = 'scheduled'
        AND t.confirmed_driver_id = p_driver_id
        AND t.driver_id IS NULL
        AND t.id <> p_candidate_trip_id
        AND t.scheduled_status::text IN (
          'driver_assigned', 'scheduled', 'scheduled_committed', 'awaiting_activation_accept'
        )
        AND t.scheduled_at > v_now - interval '15 minutes'
      ORDER BY t.scheduled_at ASC
      LIMIT 20
    LOOP
      IF v_cand.scheduled_at <= v_other.scheduled_at THEN
        v_travel := COALESCE(
          public.scheduled_commitment_estimate_eta_minutes(
            v_cand.dropoff_latitude::double precision,
            v_cand.dropoff_longitude::double precision,
            v_other.pickup_latitude::double precision,
            v_other.pickup_longitude::double precision
          ),
          30
        );
        IF NOT public.scheduled_commitment_is_feasible(
          v_cand.scheduled_at, v_cand_dur, v_travel, v_other.scheduled_at
        ) THEN
          RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'scheduled_commitment_infeasible',
            'commitment_trip_id', v_other.id
          );
        END IF;
      ELSE
        v_travel := COALESCE(
          public.scheduled_commitment_estimate_eta_minutes(
            v_other.pickup_latitude::double precision,
            v_other.pickup_longitude::double precision,
            v_cand.pickup_latitude::double precision,
            v_cand.pickup_longitude::double precision
          ),
          30
        );
        IF NOT public.scheduled_commitment_is_feasible(
          v_other.scheduled_at, 30, v_travel, v_cand.scheduled_at
        ) THEN
          RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'scheduled_commitment_infeasible',
            'commitment_trip_id', v_other.id
          );
        END IF;
      END IF;
    END LOOP;

    RETURN jsonb_build_object('allowed', true, 'reason', NULL, 'commitment_trip_id', NULL);
  END IF;

  -- additional_work: earliest confirmed commitment must stay reachable after this accept.
  SELECT
    t.id,
    t.scheduled_at,
    t.pickup_latitude,
    t.pickup_longitude,
    t.scheduled_status::text AS scheduled_status,
    t.scheduled_jit_activate_at
  INTO v_earliest
  FROM public.trips t
  WHERE t.dispatch_mode = 'scheduled'
    AND t.confirmed_driver_id = p_driver_id
    AND t.driver_id IS NULL
    AND t.id <> p_candidate_trip_id
    AND t.scheduled_status::text IN (
      'driver_assigned', 'scheduled', 'scheduled_committed', 'awaiting_activation_accept'
    )
    AND t.scheduled_at > v_now - interval '15 minutes'
  ORDER BY t.scheduled_at ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', true, 'reason', NULL, 'commitment_trip_id', NULL);
  END IF;

  -- JIT-armed exclusive activation: no new conflicting instant work.
  IF lower(COALESCE(v_earliest.scheduled_status, '')) = 'awaiting_activation_accept' THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'jit_activation_armed',
      'commitment_trip_id', v_earliest.id
    );
  END IF;

  SELECT
    gds.jit_target_early_arrival_minutes AS early,
    gds.jit_local_safety_buffer_minutes AS local_buf,
    gds.jit_long_safety_buffer_minutes AS long_buf,
    gds.jit_long_distance_eta_threshold_minutes AS threshold,
    gds.pickup_waiting_grace_period_seconds AS waiting_sec
  INTO v_cfg
  FROM public.global_dispatch_settings gds
  WHERE gds.singleton = true;

  IF FOUND THEN
    IF COALESCE(v_cfg.early, 0) > 0 THEN v_early := v_cfg.early; END IF;
    IF COALESCE(v_cfg.local_buf, 0) > 0 THEN v_local_buf := v_cfg.local_buf; END IF;
    IF COALESCE(v_cfg.long_buf, 0) > 0 THEN v_long_buf := v_cfg.long_buf; END IF;
    IF COALESCE(v_cfg.threshold, 0) > 0 THEN v_threshold := v_cfg.threshold; END IF;
    IF COALESCE(v_cfg.waiting_sec, 0) > 0 THEN
      v_waiting := GREATEST(0, CEIL(v_cfg.waiting_sec / 60.0))::integer;
    END IF;
  END IF;

  SELECT d.current_lat, d.current_lng, d.current_trip_id
  INTO v_driver_lat, v_driver_lng, v_cur_trip_id
  FROM public.drivers d
  WHERE d.id = p_driver_id;

  v_travel_driver_to_sched := COALESCE(
    public.scheduled_commitment_estimate_eta_minutes(
      v_driver_lat,
      v_driver_lng,
      v_earliest.pickup_latitude::double precision,
      v_earliest.pickup_longitude::double precision
    ),
    30
  );

  -- Sticky deadline first; else compute same formula as computeJitDepartureDeadlineMs.
  IF v_earliest.scheduled_jit_activate_at IS NOT NULL
     AND v_now >= v_earliest.scheduled_jit_activate_at THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'jit_departure_deadline_reached',
      'commitment_trip_id', v_earliest.id
    );
  END IF;

  v_buffer := CASE
    WHEN v_travel_driver_to_sched >= GREATEST(1, v_threshold) THEN GREATEST(1, v_long_buf)
    ELSE GREATEST(1, v_local_buf)
  END;
  v_deadline := v_earliest.scheduled_at
    - make_interval(mins => (GREATEST(0, v_early) + v_travel_driver_to_sched + v_buffer));
  IF v_now >= v_deadline THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'jit_departure_deadline_reached',
      'commitment_trip_id', v_earliest.id
    );
  END IF;

  v_cand_dur := GREATEST(5, CEIL(COALESCE(NULLIF(v_cand.estimated_duration_minutes, 0), 30)))::integer;

  -- Stacked accept: remaining on live current trip + origin at its dropoff.
  v_origin_lat := v_driver_lat;
  v_origin_lng := v_driver_lng;
  IF v_cur_trip_id IS NOT NULL AND v_cur_trip_id <> p_candidate_trip_id THEN
    SELECT
      GREATEST(5, CEIL(COALESCE(NULLIF(ct.estimated_duration_minutes, 0), 20)))::integer,
      ct.dropoff_latitude::double precision,
      ct.dropoff_longitude::double precision
    INTO v_cur_dur, v_origin_lat, v_origin_lng
    FROM public.trips ct
    WHERE ct.id = v_cur_trip_id
      AND lower(COALESCE(ct.status::text, '')) NOT IN (
        'completed', 'cancelled', 'expired', 'expired_no_driver', 'no_show',
        'customer_cancelled', 'driver_cancelled'
      );
    v_remaining_active := COALESCE(v_cur_dur, 0);
    IF v_origin_lat IS NULL OR v_origin_lng IS NULL THEN
      v_origin_lat := v_driver_lat;
      v_origin_lng := v_driver_lng;
    END IF;
  END IF;

  v_travel_to_cand := COALESCE(
    public.scheduled_commitment_estimate_eta_minutes(
      v_origin_lat,
      v_origin_lng,
      v_cand.pickup_latitude::double precision,
      v_cand.pickup_longitude::double precision
    ),
    30
  );

  v_remaining := v_remaining_active + v_travel_to_cand + v_waiting + v_cand_dur;

  v_from_lat := COALESCE(v_cand.dropoff_latitude, v_cand.pickup_latitude)::double precision;
  v_from_lng := COALESCE(v_cand.dropoff_longitude, v_cand.pickup_longitude)::double precision;
  v_travel := COALESCE(
    public.scheduled_commitment_estimate_eta_minutes(
      v_from_lat,
      v_from_lng,
      v_earliest.pickup_latitude::double precision,
      v_earliest.pickup_longitude::double precision
    ),
    30
  );

  IF public.scheduled_commitment_is_feasible(
    v_now, v_remaining, v_travel, v_earliest.scheduled_at
  ) THEN
    RETURN jsonb_build_object('allowed', true, 'reason', NULL, 'commitment_trip_id', v_earliest.id);
  END IF;

  RETURN jsonb_build_object(
    'allowed', false,
    'reason', 'scheduled_commitment_infeasible',
    'commitment_trip_id', v_earliest.id
  );
END;
$function$;

COMMENT ON FUNCTION public.driver_scheduled_commitment_gate(uuid, uuid, text) IS
  'Bug #44 / Phase 4 commitment feasibility (SQL twin of evaluateInstantOfferScheduledCommitmentGate). Called inside accept_ride_offer (additional_work) and accept_scheduled_ride (additional_scheduled). Returns {allowed, reason, commitment_trip_id}.';

REVOKE ALL ON FUNCTION public.driver_scheduled_commitment_gate(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
