-- ============================================================
-- Scheduled booking gap closure (Gap B + Gap C SQL backstops)
-- Branch: fix/scheduled-booking-gap-closure-final
-- NOT APPLIED to production — review + explicit approval required.
--
-- Gap B — Phase 4 commitment feasibility TOCTOU
--   Edge accept-offer / scheduled-ride-action already call
--   driverMayAcceptAdditionalWork / driverMayTakeAdditionalScheduledBooking
--   (scheduledCommitmentOfferGateSSOT.ts). That precheck is outside the SQL
--   transaction, so a concurrent accept can slip past it.
--   This migration ports the same math into SQL and re-validates it INSIDE
--   accept_ride_offer and accept_scheduled_ride under a per-driver advisory
--   lock (same key accept_scheduled_ride already uses).
--   Failure code: SCHEDULED_COMMITMENT_INFEASIBLE
--
-- Gap C — Commission wallet gate on scheduled marketplace accept
--   Instant dispatch uses driver_passes_commission_wallet_dispatch_gate.
--   accept_scheduled_ride now re-checks the SAME function (Edge also gates
--   get_available + accept + Admin assign_now).
--   Failure code: INSUFFICIENT_COMMISSION_WALLET_BALANCE
--
-- No feature flags are changed (jit_auto_activate_enabled,
-- scheduled_departure_ack_enabled untouched). Instant gate is not modified.
-- ============================================================

-- ── 1) ETA estimate — port of scheduledDispatchConfig.estimateEtaMinutes ─────
CREATE OR REPLACE FUNCTION public.scheduled_commitment_estimate_eta_minutes(
  p_from_lat double precision,
  p_from_lng double precision,
  p_to_lat double precision,
  p_to_lng double precision
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_dlat double precision;
  v_dlng double precision;
  v_a double precision;
  v_km double precision;
BEGIN
  IF p_from_lat IS NULL OR p_from_lng IS NULL OR p_to_lat IS NULL OR p_to_lng IS NULL THEN
    RETURN NULL;
  END IF;
  v_dlat := radians(p_to_lat - p_from_lat);
  v_dlng := radians(p_to_lng - p_from_lng);
  v_a := power(sin(v_dlat / 2), 2)
    + cos(radians(p_from_lat)) * cos(radians(p_to_lat)) * power(sin(v_dlng / 2), 2);
  v_a := LEAST(1, GREATEST(0, v_a));
  v_km := 6371 * 2 * atan2(sqrt(v_a), sqrt(1 - v_a));
  -- road factor 1.45, 20 km/h, min 3 minutes (mirrors Edge estimateEtaMinutes).
  RETURN GREATEST(3, CEIL((v_km * 1.45 / 20.0) * 60.0))::integer;
END;
$function$;

-- ── 2) Feasibility — port of evaluateScheduledCommitmentFeasibility ──────────
--   now + remaining + travelEta + earlyArrival + safetyBuffer <= scheduled_at
CREATE OR REPLACE FUNCTION public.scheduled_commitment_is_feasible(
  p_now timestamptz,
  p_remaining_journey_minutes numeric,
  p_travel_eta_minutes numeric,
  p_scheduled_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg record;
  v_early integer := 5;
  v_local_buf integer := 3;
  v_long_buf integer := 5;
  v_threshold integer := 30;
  v_eta integer;
  v_remaining integer;
  v_buffer integer;
  v_required numeric;
  v_available numeric;
BEGIN
  IF p_scheduled_at IS NULL OR p_now IS NULL THEN
    RETURN false;
  END IF;

  SELECT
    gds.jit_target_early_arrival_minutes AS early,
    gds.jit_local_safety_buffer_minutes AS local_buf,
    gds.jit_long_safety_buffer_minutes AS long_buf,
    gds.jit_long_distance_eta_threshold_minutes AS threshold
  INTO v_cfg
  FROM public.global_dispatch_settings gds
  WHERE gds.singleton = true;

  -- parsePositiveInt semantics: non-positive / null → default.
  IF FOUND THEN
    IF COALESCE(v_cfg.early, 0) > 0 THEN v_early := v_cfg.early; END IF;
    IF COALESCE(v_cfg.local_buf, 0) > 0 THEN v_local_buf := v_cfg.local_buf; END IF;
    IF COALESCE(v_cfg.long_buf, 0) > 0 THEN v_long_buf := v_cfg.long_buf; END IF;
    IF COALESCE(v_cfg.threshold, 0) > 0 THEN v_threshold := v_cfg.threshold; END IF;
  END IF;

  v_eta := GREATEST(0, CEIL(COALESCE(p_travel_eta_minutes, 0)))::integer;
  v_remaining := GREATEST(0, CEIL(COALESCE(p_remaining_journey_minutes, 0)))::integer;
  v_buffer := CASE
    WHEN v_eta >= GREATEST(1, v_threshold) THEN GREATEST(1, v_long_buf)
    ELSE GREATEST(1, v_local_buf)
  END;

  v_required := v_remaining + v_eta + GREATEST(0, v_early) + v_buffer;
  v_available := EXTRACT(EPOCH FROM (p_scheduled_at - p_now)) / 60.0;
  RETURN v_available >= v_required;
END;
$function$;

-- ── 3) Gate — port of scheduledCommitmentOfferGateSSOT ───────────────────────
--   p_mode 'additional_work'      ≙ driverMayAcceptAdditionalWork (accept_ride_offer)
--   p_mode 'additional_scheduled' ≙ driverMayTakeAdditionalScheduledBooking (accept_scheduled_ride)
--   Confirmed commitments exclude the candidate trip itself (never block a driver
--   from accepting / activating their own already-confirmed booking).
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
  v_cur_trip_id uuid;
  v_cur_dur integer;
  v_from_lat double precision;
  v_from_lng double precision;
  v_travel integer;
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
        -- Candidate runs first: must finish + reach the other pickup in time.
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
        -- Other runs first (approximate 30m duration): must reach candidate pickup.
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
  SELECT t.id, t.scheduled_at, t.pickup_latitude, t.pickup_longitude
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

  v_cand_dur := GREATEST(5, CEIL(COALESCE(NULLIF(v_cand.estimated_duration_minutes, 0), 30)))::integer;

  -- Stacked accept: driver's live current trip still has to be driven first.
  SELECT d.current_trip_id INTO v_cur_trip_id FROM public.drivers d WHERE d.id = p_driver_id;
  IF v_cur_trip_id IS NOT NULL AND v_cur_trip_id <> p_candidate_trip_id THEN
    SELECT GREATEST(5, CEIL(COALESCE(NULLIF(ct.estimated_duration_minutes, 0), 20)))::integer
    INTO v_cur_dur
    FROM public.trips ct
    WHERE ct.id = v_cur_trip_id
      AND lower(COALESCE(ct.status::text, '')) NOT IN (
        'completed', 'cancelled', 'expired', 'expired_no_driver', 'no_show',
        'customer_cancelled', 'driver_cancelled'
      );
    v_remaining_active := COALESCE(v_cur_dur, 0);
  END IF;

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
    v_now, v_remaining_active + v_cand_dur, v_travel, v_earliest.scheduled_at
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
  'Phase 4 commitment feasibility (SQL twin of scheduledCommitmentOfferGateSSOT.ts). Called inside accept_ride_offer (additional_work) and accept_scheduled_ride (additional_scheduled). Returns {allowed, reason, commitment_trip_id}.';

-- Internal SECURITY DEFINER helpers only (called from accept RPCs as owner).
REVOKE ALL ON FUNCTION public.scheduled_commitment_estimate_eta_minutes(double precision, double precision, double precision, double precision) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.scheduled_commitment_is_feasible(timestamptz, numeric, numeric, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.driver_scheduled_commitment_gate(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- ── 4) accept_ride_offer — patch (same pg_get_functiondef pattern as 20260919130200) ──
DO $patch$
DECLARE
  v_def text;
  v_lock_marker text := E'  PERFORM p_allow_customer_counter;\n';
  v_lock_inject text :=
$inj$
  PERFORM p_allow_customer_counter;

  -- Gap B: serialize with accept_scheduled_ride (same per-driver key) BEFORE any row locks
  -- so the commitment feasibility re-check below is race-free.
  PERFORM pg_advisory_xact_lock(hashtext('driver_sched_accept:' || p_driver_id::text));
$inj$;
  v_gate_marker text :=
    E'  v_original_fare_pence := COALESCE(\n    NULLIF(v_trip.gross_fare_pence, 0),';
  v_gate_inject text :=
$inj$
  -- Gap B: Phase 4 commitment feasibility re-validated inside the accept transaction
  -- (Edge driverMayAcceptAdditionalWork precheck is not authoritative on its own).
  IF COALESCE(
       (public.driver_scheduled_commitment_gate(p_driver_id, v_offer.trip_id, 'additional_work') ->> 'allowed')::boolean,
       true
     ) = false
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'SCHEDULED_COMMITMENT_INFEASIBLE',
      'message', 'Accepting this trip would make your confirmed scheduled booking infeasible',
      'commitment_trip_id',
        public.driver_scheduled_commitment_gate(p_driver_id, v_offer.trip_id, 'additional_work') ->> 'commitment_trip_id'
    );
  END IF;

  v_original_fare_pence := COALESCE(
    NULLIF(v_trip.gross_fare_pence, 0),$inj$;
BEGIN
  SELECT pg_get_functiondef('public.accept_ride_offer(uuid,uuid,boolean)'::regprocedure)
    INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'accept_ride_offer(uuid,uuid,boolean) missing';
  END IF;
  IF position('driver_scheduled_commitment_gate' in v_def) > 0 THEN
    RAISE NOTICE 'accept_ride_offer already carries Gap B commitment gate';
    RETURN;
  END IF;
  IF position(v_lock_marker in v_def) = 0 OR position(v_gate_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'accept_ride_offer Gap B patch marker not found — abort';
  END IF;
  v_def := replace(v_def, v_lock_marker, v_lock_inject);
  v_def := replace(v_def, v_gate_marker, v_gate_inject);
  EXECUTE v_def;
END;
$patch$;

-- ── 5) accept_scheduled_ride — patch: commitment feasibility + commission wallet ──
DO $patch$
DECLARE
  v_def text;
  v_marker text :=
    E'  UPDATE public.trips\n  SET\n    confirmed_driver_id = v_driver_id,\n    status = ''accepted'',';
  v_inject text :=
$inj$
  -- Gap B: Phase 4 commitment feasibility inside the accept transaction
  -- (under driver_sched_accept advisory lock taken above).
  IF COALESCE(
       (public.driver_scheduled_commitment_gate(v_driver_id, p_trip_id, 'additional_scheduled') ->> 'allowed')::boolean,
       true
     ) = false
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'SCHEDULED_COMMITMENT_INFEASIBLE',
      'message', 'This booking conflicts with another confirmed scheduled ride.',
      'commitment_trip_id',
        public.driver_scheduled_commitment_gate(v_driver_id, p_trip_id, 'additional_scheduled') ->> 'commitment_trip_id'
    );
  END IF;

  -- Gap C: same commission wallet gate as instant dispatch (trip-scoped; non-CW trips pass).
  IF NOT public.driver_passes_commission_wallet_dispatch_gate(v_driver_id, p_trip_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INSUFFICIENT_COMMISSION_WALLET_BALANCE',
      'message', 'Your commission wallet balance is too low to take this booking. Top up your wallet and try again.'
    );
  END IF;

  UPDATE public.trips
  SET
    confirmed_driver_id = v_driver_id,
    status = 'accepted',$inj$;
BEGIN
  SELECT pg_get_functiondef('public.accept_scheduled_ride(uuid,uuid)'::regprocedure)
    INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'accept_scheduled_ride(uuid,uuid) missing';
  END IF;
  IF position('driver_scheduled_commitment_gate' in v_def) > 0 THEN
    RAISE NOTICE 'accept_scheduled_ride already carries Gap B/C gates';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'accept_scheduled_ride Gap B/C patch marker not found — abort';
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch$;

COMMENT ON FUNCTION public.accept_scheduled_ride(uuid, uuid) IS
  'Atomically reserve a marketplace scheduled ride. Requires live document eligibility, assert_payment_gate, Phase 4 commitment feasibility (SCHEDULED_COMMITMENT_INFEASIBLE) and commission wallet gate (INSUFFICIENT_COMMISSION_WALLET_BALANCE).';
