-- MK-260817-006: SQL dispatch_trip_offers must not treat scheduled
-- booking created_at as instant search TTL. Isolated replace of the three
-- live overloads (already applied 20260921130000 without this skip).

CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip record;
  v_settings record;
  v_round int;
  v_max_rounds int;
  v_offer_expiry_seconds int;
  v_search_radius_meters int;
  v_max_offers_per_request int;
  v_expires_at timestamptz;
  v_now timestamptz := now();
  v_presence_max_age_seconds int := 60;
BEGIN
  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF lower(COALESCE(v_trip.dispatch_mode, '')) = 'scheduled'
     AND lower(COALESCE(v_trip.scheduled_status, '')) IS DISTINCT FROM 'converted_to_instant' THEN
    RETURN;
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN;
  END IF;

  IF v_trip.status IS NULL OR v_trip.status NOT IN (
    'pending','searching','broadcasting','offered','offering','searching_new_driver'
  ) THEN
    RETURN;
  END IF;

  IF v_trip.status IN ('completed','cancelled','expired','declined') THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ride_offers ro
    WHERE ro.trip_id = p_trip_id
      AND ro.status IN ('pending','accepted')
      AND ro.expires_at > v_now
  ) THEN
    RETURN;
  END IF;

  SELECT * INTO v_settings
  FROM public.dispatch_settings
  WHERE service_area_id = v_trip.service_area_id
  LIMIT 1;

  IF v_settings IS NULL THEN
    SELECT * INTO v_settings
    FROM public.dispatch_settings
    WHERE service_area_id IS NULL
    LIMIT 1;
  END IF;

  v_search_radius_meters := COALESCE(v_settings.search_radius_meters, 5000);
  v_offer_expiry_seconds := COALESCE(v_settings.offer_expiry_seconds, 20);
  v_max_offers_per_request := COALESCE(v_settings.max_offers_per_request, 5);

  v_round := COALESCE(v_trip.current_broadcast_round, 0) + 1;
  v_max_rounds := public.dispatch_max_broadcast_rounds(
    public.get_dispatch_settings(v_trip.service_area_id),
    v_trip.max_broadcast_rounds
  );

  IF v_round > v_max_rounds THEN
    UPDATE public.trips
    SET status = 'expired',
        dispatch_status = 'expired',
        updated_at = v_now
    WHERE id = p_trip_id;
    RETURN;
  END IF;

  v_expires_at := v_now + make_interval(secs => v_offer_expiry_seconds);

  INSERT INTO public.ride_offers (trip_id, driver_id, status, expires_at, distance_meters, broadcast_round, offered_at)
  SELECT
    p_trip_id,
    d.id,
    'pending',
    v_expires_at,
    round(public.haversine_meters(
      v_trip.pickup_latitude,
      v_trip.pickup_longitude,
      COALESCE(dp.lat, d.current_lat),
      COALESCE(dp.lng, d.current_lng)
    ))::int,
    v_round,
    v_now
  FROM public.drivers d
  JOIN public.driver_presence dp ON dp.driver_id = d.id
  WHERE d.is_online = true
    AND d.approval_status = 'approved'
    AND d.current_trip_id IS NULL
    AND dp.status = 'online'
    AND dp.last_heartbeat_at > v_now - make_interval(secs => v_presence_max_age_seconds)
    AND dp.push_token IS NOT NULL
    AND dp.push_token <> ''
    AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
    AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
    AND NOT public.driver_location_is_frozen(d.id)
    AND (
      v_trip.service_area_id IS NULL
      OR d.service_area_id = v_trip.service_area_id
      OR EXISTS (
        SELECT 1 FROM public.driver_service_areas dsa
        WHERE dsa.driver_id = d.id
          AND dsa.service_area_id = v_trip.service_area_id
      )
    )
    AND (v_trip.region_id IS NULL OR d.region_id = v_trip.region_id)
    AND public.haversine_meters(
      v_trip.pickup_latitude,
      v_trip.pickup_longitude,
      COALESCE(dp.lat, d.current_lat),
      COALESCE(dp.lng, d.current_lng)
    ) <= v_search_radius_meters
    AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
    AND NOT EXISTS (
      SELECT 1 FROM public.ride_offers ro
      WHERE ro.trip_id = p_trip_id
        AND ro.driver_id = d.id
        AND ro.status IN ('pending','accepted','revoked')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.ride_offers ro
      WHERE ro.trip_id = p_trip_id
        AND ro.driver_id = d.id
        AND ro.status = 'declined'
        AND COALESCE(ro.responded_at, ro.updated_at, ro.offered_at) >
            (v_now - make_interval(secs => COALESCE(
              (public.get_dispatch_settings(v_trip.service_area_id)).cooldown_after_reject_seconds,
              180
            )))
    )
  ORDER BY public.haversine_meters(
    v_trip.pickup_latitude,
    v_trip.pickup_longitude,
    COALESCE(dp.lat, d.current_lat),
    COALESCE(dp.lng, d.current_lng)
  ) ASC
  LIMIT v_max_offers_per_request;

  UPDATE public.trips
  SET status = 'offered',
      dispatch_status = 'broadcasting',
      current_broadcast_round = v_round,
      broadcast_started_at = COALESCE(v_trip.broadcast_started_at, v_now),
      last_broadcast_at = v_now,
      updated_at = v_now
  WHERE id = p_trip_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid, p_internal boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

DECLARE
  v_trip record;
  v_settings public.dispatch_settings;
  v_round int;
  v_max_rounds int;
  v_offer_expiry_seconds int;
  v_search_radius_meters int;
  v_wave_cap int;
  v_shortlist_limit int;
  v_expires_at timestamptz;
  v_now timestamptz := now();
  v_presence_max_age_seconds int := 60;
  v_inserted int;
  v_cooldown_seconds int;
  v_emergency_only boolean;

BEGIN
  -- P0 #1: amount gate before any ride_offer insert (boolean overload).
  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION '%', SQLERRM USING ERRCODE = 'P0001';
  END;

  IF NOT p_internal THEN

    SELECT COALESCE(ds.manual_emergency_dispatch_only, false)
      INTO v_emergency_only
      FROM public.dispatch_settings ds
     WHERE ds.service_area_id IS NULL
     LIMIT 1;
    IF NOT COALESCE(v_emergency_only, false) THEN
      RAISE EXCEPTION
        'dispatch_trip_offers RPC disabled (Phase 3). Use auto-dispatch edge. Enable manual_emergency_dispatch_only on global dispatch_settings for admin emergency SQL dispatch.';
    END IF;
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF lower(COALESCE(v_trip.dispatch_mode, '')) = 'scheduled'
     AND lower(COALESCE(v_trip.scheduled_status, '')) IS DISTINCT FROM 'converted_to_instant' THEN
    RETURN;
  END IF;

  v_settings := public.get_dispatch_settings(v_trip.service_area_id);

  -- Pause SQL dispatch while broadcast is disabled.
  IF COALESCE(v_trip.broadcast_enabled, true) = false THEN
    RETURN;
  END IF;

  IF v_trip.negotiation_owner_driver_id IS NOT NULL OR v_trip.status = 'negotiating' THEN
    RETURN;
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN;
  END IF;

  IF v_trip.status IS NULL OR v_trip.status NOT IN (
    'pending', 'searching', 'broadcasting', 'offered', 'offering', 'searching_new_driver'
  ) THEN
    RETURN;
  END IF;

  IF v_trip.status IN ('completed', 'cancelled', 'expired', 'declined') THEN
    RETURN;
  END IF;

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

  v_cooldown_seconds := COALESCE(v_settings.cooldown_after_reject_seconds, 180);
  v_round := COALESCE(v_trip.current_broadcast_round, 0) + 1;
  v_max_rounds := public.dispatch_max_broadcast_rounds(v_settings, v_trip.max_broadcast_rounds);
  v_search_radius_meters := public.dispatch_effective_radius_meters(v_settings, v_round);
  v_wave_cap := public.dispatch_wave_cap(v_settings, v_round);
  v_shortlist_limit := COALESCE(v_settings.shortlist_limit, 100);
  v_offer_expiry_seconds := public.dispatch_wave_offer_expiry_seconds(v_settings, v_round);

  IF v_round > v_max_rounds THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN;
  END IF;

  v_expires_at := v_now + make_interval(secs => v_offer_expiry_seconds);

  INSERT INTO public.ride_offers (
    trip_id, driver_id, status, expires_at, distance_meters, broadcast_round, offered_at, offer_snapshot
  )
  SELECT
    p_trip_id,
    cand.driver_id,
    'pending',
    v_expires_at,
    cand.distance_meters,
    v_round,
    v_now,
    jsonb_build_object('dispatch_source', 'sql_dispatch_trip_offers')
  FROM (
    SELECT
      d.id AS driver_id,
      round(public.haversine_meters(
        v_trip.pickup_latitude,
        v_trip.pickup_longitude,
        COALESCE(dp.lat, d.current_lat),
        COALESCE(dp.lng, d.current_lng)
      ))::int AS distance_meters,
      public.compute_dispatch_score(
        v_settings,
        public.haversine_meters(
          v_trip.pickup_latitude,
          v_trip.pickup_longitude,
          COALESCE(dp.lat, d.current_lat),
          COALESCE(dp.lng, d.current_lng)
        ),
        COALESCE(d.display_rating, d.rating, 4.5),
        COALESCE(
          (
            SELECT COUNT(*) FILTER (WHERE ro2.status = 'accepted')::numeric
              / NULLIF(COUNT(*)::numeric, 0)
            FROM public.ride_offers ro2
            WHERE ro2.driver_id = d.id
              AND ro2.created_at > v_now - interval '30 days'
          ),
          0.5
        ),
        public.driver_idle_minutes(d.last_trip_end_at, d.online_since, d.last_seen_at, v_now)
      ) AS dispatch_score
    FROM public.drivers d
    JOIN public.driver_presence dp ON dp.driver_id = d.id
    WHERE d.is_online = true
      AND d.approval_status = 'approved'
      AND d.current_trip_id IS NULL
      AND dp.status = 'online'
      AND dp.last_heartbeat_at > v_now - make_interval(secs => v_presence_max_age_seconds)
      AND dp.push_token IS NOT NULL
      AND dp.push_token <> ''
      AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
      AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
      AND NOT public.driver_location_is_frozen(d.id)
      AND COALESCE(d.display_rating, d.rating, 0) >= COALESCE(v_settings.minimum_rating, 0)
      AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
      AND NOT (d.id = ANY (COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[])))
      AND NOT EXISTS (
        SELECT 1 FROM public.trip_driver_exclusions tde
        WHERE tde.trip_id = p_trip_id
          AND tde.driver_id = d.id
      )
      AND (
        v_trip.service_area_id IS NULL
        OR d.service_area_id = v_trip.service_area_id
        OR EXISTS (
          SELECT 1 FROM public.driver_service_areas dsa
          WHERE dsa.driver_id = d.id
            AND dsa.service_area_id = v_trip.service_area_id
        )
      )
      AND (v_trip.region_id IS NULL OR d.region_id = v_trip.region_id)
      AND public.haversine_meters(
        v_trip.pickup_latitude,
        v_trip.pickup_longitude,
        COALESCE(dp.lat, d.current_lat),
        COALESCE(dp.lng, d.current_lng)
      ) <= v_search_radius_meters
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id
          AND ro.driver_id = d.id
          -- Do not block rematch rebroadcast on historically revoked offers.
          -- Soft declines use cooldown below (Edge parity); do not hard-block forever.
          AND ro.status IN ('pending', 'accepted', 'countered')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id
          AND ro.driver_id = d.id
          AND ro.status IN ('declined', 'expired')
          AND ro.responded_at > v_now - make_interval(secs => v_cooldown_seconds)
      )
      AND public.driver_passes_commission_wallet_dispatch_gate(d.id, p_trip_id)
    ORDER BY dispatch_score DESC, distance_meters ASC
    LIMIT v_shortlist_limit
  ) cand
  LIMIT v_wave_cap;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    UPDATE public.trips
    SET
      current_broadcast_round = v_round,
      last_broadcast_at = v_now,
      updated_at = v_now
    WHERE id = p_trip_id;
    PERFORM public.maybe_advance_dispatch_after_offer_resolution(p_trip_id, NULL);
    RETURN;
  END IF;

  UPDATE public.trips
  SET status = 'offered',
      dispatch_status = 'broadcasting',
      current_broadcast_round = v_round,
      broadcast_started_at = COALESCE(v_trip.broadcast_started_at, v_now),
      last_broadcast_at = v_now,
      updated_at = v_now
  WHERE id = p_trip_id;

  PERFORM public.enrich_ride_offer_presets(p_trip_id);
END;

$function$;

CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid, p_trigger_reason text DEFAULT 'auto'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip            public.trips%ROWTYPE;
  v_g               public.global_dispatch_settings%ROWTYPE;
  v_now             timestamptz := now();
  v_seq             integer;
  v_wave            integer;
  v_round           integer;
  v_max_rounds      integer;
  v_wave_cap        integer;
  v_radius          integer;
  v_max_radius      integer;
  v_expiry_secs     integer;
  v_presence_max_age int;
  v_inserted        integer := 0;
  v_candidate_count int := 0;
  v_eligible_count  int := 0;
  v_degraded_count  int := 0;
  v_hard_excl_count int := 0;
  v_selected_count  int := 0;
  v_selected_json   jsonb := '[]'::jsonb;
  v_previous_json   jsonb := '[]'::jsonb;
  v_prev_seq        integer;
  v_offer_ids       uuid[] := ARRAY[]::uuid[];
  v_selected_ids    uuid[] := ARRAY[]::uuid[];
  v_skipped_ids     uuid[] := ARRAY[]::uuid[];
  v_status          text := 'ok';
  v_reason          text := NULL;
  v_expires_at      timestamptz;
  v_search_deadline timestamptz;
  v_find_minutes    integer;
  v_new_trip_distance_m numeric;
  v_new_bearing     double precision;
  v_base_pct        numeric;
  v_reduction_pct   numeric;
  v_effective_pct   numeric;
  v_commissionable  integer;
  v_offered_net     integer;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', NULL,
      'round', NULL, 'wave', NULL, 'status', 'trip_not_found',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'trip_not_found'
    );
  END IF;

  -- MK-260817-006: instant TTL has not started. Do not use created_at.
  IF lower(COALESCE(v_trip.dispatch_mode, '')) = 'scheduled'
     AND lower(COALESCE(v_trip.scheduled_status, '')) IS DISTINCT FROM 'converted_to_instant' THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
      'round', COALESCE(v_trip.current_broadcast_round, 0),
      'status', 'skipped',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'scheduled_handover_pending'
    );
  END IF;

  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RETURN jsonb_build_object(
        'trip_id', p_trip_id,
        'trip_code', v_trip.trip_code,
        'round', COALESCE(v_trip.current_broadcast_round, 0),
        'status', 'payment_gate_failed',
        'offers_created', 0,
        'offer_ids', '[]'::jsonb,
        'selected_driver_ids', '[]'::jsonb,
        'skipped_driver_ids', '[]'::jsonb,
        'candidate_count', 0,
        'eligible_count', 0,
        'wave_cap', NULL,
        'search_radius_meters', NULL,
        'reason', SQLERRM,
        'code', CASE
          WHEN SQLERRM ILIKE '%PAYMENT_AUTHORISATION_INSUFFICIENT%'
            THEN 'PAYMENT_AUTHORISATION_INSUFFICIENT'
          ELSE 'PAYMENT_GATE_NOT_SATISFIED'
        END
      );
  END;

  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'global_dispatch_settings singleton missing';
  END IF;

  -- Max absolute sequences (cycles × 3), prefer trip stamp.
  v_max_rounds       := public.dispatch_max_broadcast_rounds(
    to_jsonb(v_g),
    v_trip.max_broadcast_rounds
  );
  v_presence_max_age := COALESCE(v_g.presence_max_age_seconds, 60);
  v_prev_seq         := COALESCE(v_trip.current_broadcast_round, 0);

  BEGIN
    INSERT INTO public.dispatch_round_advance_log(trip_id, previous_round, trigger_reason)
    VALUES (p_trip_id, v_prev_seq, COALESCE(p_trigger_reason, 'auto'));
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
      'round', v_prev_seq, 'status', 'duplicate_trigger',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'round already advanced for previous_round=' || v_prev_seq
    );
  END;

  IF COALESCE(v_trip.broadcast_enabled, true) = false THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
      'round', v_prev_seq, 'status', 'skipped',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'broadcast_disabled'
    );
  END IF;

  IF v_trip.negotiation_owner_driver_id IS NOT NULL OR v_trip.status = 'negotiating' THEN
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_prev_seq,
      'status','skipped','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',NULL,'search_radius_meters',NULL,
      'reason','trip_in_negotiation');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ride_offers ro
    WHERE ro.trip_id = p_trip_id AND ro.status = 'pending'
      AND (ro.negotiation_status IN ('waiting_customer','waiting_driver','waiting_driver_final')
           OR ro.expires_at > v_now)
  ) THEN
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_prev_seq,
      'status','skipped','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',NULL,'search_radius_meters',NULL,
      'reason','active_offers_outstanding');
  END IF;

  -- Wave / round derivation: 3 waves per round, rounds repeat.
  v_seq   := v_prev_seq + 1;
  v_wave  := ((v_seq - 1) % 3) + 1;
  v_round := ((v_seq - 1) / 3) + 1;
  v_max_radius := v_g.max_radius_meters;

  CASE v_wave
    WHEN 1 THEN
      v_wave_cap := v_g.wave1_size; v_radius := v_g.start_radius_meters;  v_expiry_secs := v_g.wave1_offer_expiry_seconds;
    WHEN 2 THEN
      v_wave_cap := v_g.wave2_size; v_radius := v_g.expand_radius_meters; v_expiry_secs := v_g.wave2_offer_expiry_seconds;
    ELSE
      v_wave_cap := v_g.wave3_size; v_radius := v_g.max_radius_meters;    v_expiry_secs := v_g.wave3_offer_expiry_seconds;
  END CASE;

  IF v_radius IS NULL OR v_wave_cap IS NULL OR v_expiry_secs IS NULL THEN
    RAISE EXCEPTION 'global_dispatch_settings missing wave configuration for wave %', v_wave;
  END IF;

  v_radius := LEAST(v_radius, COALESCE(v_max_radius, v_radius));

  -- Overall trip TTL controls the maximum search duration.
  v_find_minutes := GREATEST(1, COALESCE(v_g.max_driver_find_time_minutes, 3));
  v_search_deadline := COALESCE(
    v_trip.searching_expires_at,
    v_trip.created_at + make_interval(mins => v_find_minutes),
    v_now + make_interval(mins => v_find_minutes)
  );

  IF v_search_deadline <= v_now THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_round,'wave',v_wave,
      'status','exhausted','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',v_wave_cap,'search_radius_meters',v_radius,
      'reason','trip_search_window_elapsed');
  END IF;

  IF v_seq > v_max_rounds THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_round,'wave',v_wave,
      'status','exhausted','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',v_wave_cap,'search_radius_meters',v_radius,
      'reason','max_rounds_reached');
  END IF;

  -- Offer window never outlives the overall trip TTL.
  v_expires_at := LEAST(v_now + make_interval(secs => v_expiry_secs), v_search_deadline);

  -- Per-wave commission incentive (monotonic across waves/rounds).
  SELECT base_percent, reduction_percent, effective_percent
    INTO v_base_pct, v_reduction_pct, v_effective_pct
  FROM public.resolve_wave_commission_percent(
    v_wave, COALESCE(v_trip.max_wave_commission_reduction_percent, 0));

  v_commissionable := GREATEST(0,
    COALESCE(
      NULLIF(v_trip.final_customer_fare_pence, 0),
      NULLIF(v_trip.final_fare_pence, 0),
      NULLIF(v_trip.estimated_total_pence, 0),
      NULLIF(v_trip.gross_fare_pence, 0),
      NULLIF(v_trip.base_fare_pence, 0),
      0
    ) - COALESCE(v_trip.airport_charge_pence, 0));
  v_offered_net := GREATEST(0, v_commissionable - ROUND(v_commissionable * v_effective_pct / 100.0)::int);

  v_new_trip_distance_m := COALESCE(v_trip.estimated_distance_km, 0)::numeric * 1000.0;
  IF v_new_trip_distance_m <= 0 THEN
    v_new_trip_distance_m := public.haversine_meters(
      v_trip.pickup_latitude, v_trip.pickup_longitude,
      v_trip.dropoff_latitude, v_trip.dropoff_longitude);
  END IF;
  v_new_bearing := public.bearing_deg(
    v_trip.pickup_latitude, v_trip.pickup_longitude,
    v_trip.dropoff_latitude, v_trip.dropoff_longitude);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'ride_offer_id', id, 'driver_id', driver_id, 'status', status,
           'broadcast_round', broadcast_round
         )), '[]'::jsonb)
    INTO v_previous_json
    FROM public.ride_offers WHERE trip_id = p_trip_id;

  DROP TABLE IF EXISTS _disp_candidates;
  CREATE TEMP TABLE _disp_candidates ON COMMIT DROP AS
  WITH base AS (
    SELECT d.id AS driver_id, d.driver_code, d.service_area_id, d.region_id, d.category_id,
           d.current_trip_id, d.last_offer_at, d.last_trip_end_at,
           dp.status AS presence_status, dp.presence_health, dp.push_token,
           dp.socket_connected, dp.last_heartbeat_at, dp.offline_reason,
           dp.last_gps_sample_at, dp.speed AS presence_speed,
           COALESCE(dp.lat, d.current_lat) AS lat,
           COALESCE(dp.lng, d.current_lng) AS lng,
           at.dropoff_latitude  AS active_drop_lat,
           at.dropoff_longitude AS active_drop_lng,
           at.pickup_latitude   AS active_pick_lat,
           at.pickup_longitude  AS active_pick_lng,
           at.estimated_distance_km AS active_est_km,
           at.estimated_duration_minutes AS active_est_min,
           at.started_at AS active_started_at
    FROM public.drivers d
    LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
    LEFT JOIN public.trips at ON at.id = d.current_trip_id
    WHERE d.approval_status = 'approved' AND d.documents_approved = true
      AND public.driver_passes_commission_wallet_dispatch_gate(d.id, p_trip_id)
      AND d.is_online = true AND COALESCE(d.driver_online_intent, false) = true
      AND NOT public.is_explicit_offline_reason(dp.offline_reason)
      AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
      AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
      AND NOT (COALESCE(dp.lat, d.current_lat) = 0 AND COALESCE(dp.lng, d.current_lng) = 0)
      AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
      AND NOT (d.id = ANY (COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[])))
      -- Hard exclusions: live / accepted / countered offers are never re-offered.
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id AND ro.driver_id = d.id
          AND ro.status IN ('pending','accepted','countered')
      )
      -- Soft declines: cooldown only (parity with Edge auto-dispatch).
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id AND ro.driver_id = d.id
          AND ro.status = 'declined'
          AND COALESCE(ro.responded_at, ro.updated_at, ro.offered_at) >
              (v_now - make_interval(secs => GREATEST(
                0,
                COALESCE(
                  (public.get_dispatch_settings(v_trip.service_area_id)).cooldown_after_reject_seconds,
                  180
                )
              )))
      )
      -- Lapsed offers may be re-offered, but only in a LATER round.
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id AND ro.driver_id = d.id
          AND ro.status IN ('expired','revoked')
          AND COALESCE(ro.dispatch_round, 1) >= v_round
      )
  ),
  active_counts AS (
    SELECT t.driver_id, count(*)::int AS active_count
      FROM public.trips t
     WHERE t.driver_id IS NOT NULL
       AND t.status IN ('driver_assigned','accepted','en_route_pickup','arrived','in_progress','pickup_in_progress','en_route_to_pickup','arrived_at_pickup','at_pickup','pickup_waiting','waiting','en_route_to_dropoff','en_route_to_stop','arrived_at_stop','at_stop','waiting_at_stop')
     GROUP BY t.driver_id
  ),
  queued_counts AS (
    SELECT t.driver_id, count(*)::int AS queued_count
      FROM public.trips t
     WHERE t.driver_id IS NOT NULL
       AND t.status = 'queued'
     GROUP BY t.driver_id
  )
  SELECT b.*,
    public.haversine_meters(v_trip.pickup_latitude, v_trip.pickup_longitude, b.lat, b.lng) AS distance_m,
    COALESCE(ac.active_count, 0) AS active_count,
    COALESCE(qc.queued_count, 0) AS queued_count,
    (b.push_token IS NOT NULL AND b.push_token <> '') AS has_push,
    (COALESCE(b.socket_connected, false) = true) AS has_realtime,
    (b.last_heartbeat_at IS NOT NULL
      AND b.last_heartbeat_at > v_now - make_interval(secs => v_presence_max_age)) AS healthy_heartbeat,
    (COALESCE(b.presence_health, 'healthy') = 'degraded') AS is_degraded,
    public.driver_location_state(true, b.last_heartbeat_at, b.last_gps_sample_at, b.presence_speed) = 'location_frozen' AS is_frozen,
    (v_trip.service_area_id IS NULL OR b.service_area_id = v_trip.service_area_id) AS sa_match,
    (v_trip.region_id IS NULL OR b.region_id = v_trip.region_id) AS region_match,
    (b.current_trip_id IS NULL) AS is_idle
  FROM base b
  LEFT JOIN active_counts ac ON ac.driver_id = b.driver_id
  LEFT JOIN queued_counts qc ON qc.driver_id = b.driver_id;

  DROP TABLE IF EXISTS _disp_eval;
  CREATE TEMP TABLE _disp_eval ON COMMIT DROP AS
  WITH stack_calc AS (
    SELECT c.*,
      CASE WHEN c.active_drop_lat IS NOT NULL AND c.active_drop_lng IS NOT NULL
        THEN public.haversine_meters(c.active_drop_lat, c.active_drop_lng,
                                     v_trip.pickup_latitude, v_trip.pickup_longitude)
        ELSE NULL END AS detour_extra_m,
      CASE WHEN c.active_est_km IS NOT NULL AND c.active_est_min IS NOT NULL AND c.active_est_min > 0
        THEN (c.active_est_km / c.active_est_min) * 60.0
        ELSE 30.0 END AS active_speed_kmh,
      CASE WHEN c.active_pick_lat IS NOT NULL AND c.active_drop_lat IS NOT NULL
        THEN public.bearing_deg(c.active_pick_lat, c.active_pick_lng,
                                c.active_drop_lat, c.active_drop_lng)
        ELSE NULL END AS active_bearing,
      CASE WHEN c.active_started_at IS NOT NULL AND c.active_est_min IS NOT NULL
        THEN GREATEST(0,
          c.active_est_min - EXTRACT(EPOCH FROM (v_now - c.active_started_at))/60.0)
        WHEN c.active_est_min IS NOT NULL
        THEN c.active_est_min::numeric
        ELSE NULL END AS active_remaining_min
    FROM _disp_candidates c
  ),
  with_quality AS (
    SELECT s.*,
      CASE WHEN s.active_bearing IS NULL THEN NULL
        ELSE abs(mod(((v_new_bearing - s.active_bearing + 540.0))::numeric, 360.0) - 180.0)
      END AS bearing_diff_deg,
      CASE WHEN s.detour_extra_m IS NULL THEN NULL
        ELSE (s.detour_extra_m / 1000.0) / NULLIF(s.active_speed_kmh,0) * 60.0
      END AS detour_min
    FROM stack_calc s
  ),
  final_eval AS (
    SELECT q.*,
      (NOT q.is_idle
        AND COALESCE(v_g.stacked_rides_enabled, false) = true
        AND v_g.max_stacked_rides IS NOT NULL
        AND v_g.max_stacked_rides >= 1
        AND q.active_count = 1
        AND q.queued_count < v_g.max_stacked_rides
      ) AS stack_pre_ok,
      CASE
        WHEN q.is_idle THEN NULL
        WHEN COALESCE(v_g.stacked_rides_enabled, false) = false THEN 'stacked_disabled'
        WHEN v_g.max_stacked_rides IS NULL OR v_g.max_stacked_rides < 1 THEN 'stacked_config_invalid'
        WHEN q.active_count <> 1 THEN 'stacked_active_count_invalid'
        WHEN q.queued_count >= v_g.max_stacked_rides THEN 'stacked_cap_reached'
        WHEN q.distance_m > COALESCE(v_g.stacked_search_radius_meters, q.distance_m) THEN 'stacked_radius_exceeded'
        WHEN v_new_trip_distance_m < COALESCE(v_g.stacked_min_trip_distance_meters, 0) THEN 'stacked_min_distance'
        WHEN q.detour_min IS NOT NULL AND q.detour_min > COALESCE(v_g.stacked_max_detour_minutes, 9999) THEN 'stacked_detour_exceeded'
        WHEN COALESCE(v_g.stacked_same_direction_only, true) = true
             AND q.bearing_diff_deg IS NOT NULL AND q.bearing_diff_deg > 90.0 THEN 'stacked_wrong_direction'
        WHEN q.active_remaining_min IS NOT NULL
             AND q.active_remaining_min > COALESCE(v_g.stacked_offer_window_minutes, 9999) THEN 'stacked_window_too_far'
        ELSE NULL
      END AS stacked_reject_reason
    FROM with_quality q
  )
  SELECT f.*,
    (f.stack_pre_ok
      AND f.distance_m <= COALESCE(v_g.stacked_search_radius_meters, f.distance_m)
      AND v_new_trip_distance_m >= COALESCE(v_g.stacked_min_trip_distance_meters, 0)
      AND (f.detour_min IS NULL OR f.detour_min <= COALESCE(v_g.stacked_max_detour_minutes, 9999))
      AND (COALESCE(v_g.stacked_same_direction_only, true) = false
           OR f.bearing_diff_deg IS NULL
           OR f.bearing_diff_deg <= 90.0)
      AND (f.active_remaining_min IS NULL
           OR f.active_remaining_min <= COALESCE(v_g.stacked_offer_window_minutes, 9999))
    ) AS stack_ok,
    CASE
      WHEN f.distance_m > v_radius THEN 'out_of_radius'
      WHEN NOT f.sa_match THEN 'service_area_mismatch'
      WHEN NOT f.region_match THEN 'region_mismatch'
      WHEN NOT f.healthy_heartbeat THEN 'stale_heartbeat'
      WHEN f.is_frozen THEN 'location_frozen'
      WHEN NOT (f.has_push OR f.has_realtime) THEN 'no_delivery_channel'
      WHEN f.presence_health = 'offline' THEN 'presence_offline'
      ELSE NULL
    END AS reject_reason
  FROM final_eval f;

  UPDATE _disp_eval
     SET reject_reason = COALESCE(reject_reason,
       CASE WHEN NOT is_idle AND NOT stack_ok
            THEN COALESCE(stacked_reject_reason, 'busy_no_stack')
            ELSE NULL END)
   WHERE true;

  DROP TABLE IF EXISTS _disp_scored;
  CREATE TEMP TABLE _disp_scored ON COMMIT DROP AS
  SELECT e.*,
    (e.distance_m * COALESCE(v_g.distance_penalty_per_meter, 0)::numeric
      + CASE WHEN e.is_degraded THEN COALESCE(v_g.degraded_driver_penalty, 100) ELSE 0 END
      - LEAST(GREATEST(EXTRACT(EPOCH FROM (v_now - COALESCE(e.last_offer_at, e.last_trip_end_at, v_now)))/60.0, 0),
              COALESCE(v_g.max_waiting_bonus_minutes, 0)) * COALESCE(v_g.waiting_bonus_per_minute, 0)::numeric
      - CASE
          WHEN COALESCE(v_g.fairness_idle_minutes, 0) > 0
           AND EXTRACT(EPOCH FROM (v_now - COALESCE(e.last_offer_at, e.last_trip_end_at, v_now)))/60.0
               >= v_g.fairness_idle_minutes
          THEN COALESCE(v_g.fairness_boost_score, 0)
          ELSE 0
        END)::numeric AS score
  FROM _disp_eval e;

  PERFORM public.log_dispatch_eligibility(
    p_trip_id, s.driver_id, (s.reject_reason IS NULL), s.reject_reason,
    jsonb_build_object('wave',v_wave,'round',v_round,'wave_sequence',v_seq,
      'trigger_reason',p_trigger_reason,
      'driver_code',s.driver_code,'distance_m',s.distance_m,'score',s.score,
      'is_degraded',s.is_degraded,'sa_match',s.sa_match,'region_match',s.region_match,
      'has_push',s.has_push,'has_realtime',s.has_realtime,
      'healthy_heartbeat',s.healthy_heartbeat,'is_idle',s.is_idle,
      'stack_ok',s.stack_ok,'active_count',s.active_count,
      'stacked_reject_reason', s.stacked_reject_reason,
      'detour_min', s.detour_min,
      'bearing_diff_deg', s.bearing_diff_deg,
      'active_remaining_min', s.active_remaining_min,
      'new_trip_distance_m', v_new_trip_distance_m,
      'hard_excluded',(s.reject_reason IS NOT NULL)))
  FROM _disp_scored s;

  SELECT count(*), count(*) FILTER (WHERE reject_reason IS NULL),
         count(*) FILTER (WHERE is_degraded), count(*) FILTER (WHERE reject_reason IS NOT NULL)
    INTO v_candidate_count, v_eligible_count, v_degraded_count, v_hard_excl_count
    FROM _disp_scored;

  SELECT COALESCE(array_agg(driver_id), ARRAY[]::uuid[]) INTO v_skipped_ids
    FROM _disp_scored WHERE reject_reason IS NOT NULL;

  WITH picks AS (
    SELECT driver_id, distance_m, score, stack_ok, is_degraded
      FROM _disp_scored WHERE reject_reason IS NULL
      ORDER BY score ASC, distance_m ASC LIMIT v_wave_cap
  ),
  ins AS (
    INSERT INTO public.ride_offers (
      trip_id, driver_id, status, expires_at, distance_meters,
      broadcast_round, dispatch_wave, dispatch_round, offered_at, is_stacked,
      base_commission_percent, wave_commission_reduction_percent,
      effective_commission_percent, offered_driver_net_pence, offer_snapshot
    )
    SELECT p_trip_id, p.driver_id, 'pending', v_expires_at, round(p.distance_m)::int,
      v_seq, v_wave, v_round, v_now, p.stack_ok,
      v_base_pct, v_reduction_pct, v_effective_pct, v_offered_net,
      jsonb_build_object('wave',v_wave,'round',v_round,'wave_sequence',v_seq,
                         'score',p.score,'trigger_reason',p_trigger_reason,
                         'degraded',p.is_degraded,'stacked',p.stack_ok,
                         'base_commission_percent',v_base_pct,
                         'wave_commission_reduction_percent',v_reduction_pct,
                         'effective_commission_percent',v_effective_pct,
                         'offered_driver_net_pence',v_offered_net)
    FROM picks p
    RETURNING id, driver_id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]),
         COALESCE(array_agg(driver_id), ARRAY[]::uuid[]),
         count(*)::int
    INTO v_offer_ids, v_selected_ids, v_inserted
    FROM ins;

  v_selected_count := v_inserted;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'driver_id', ro.driver_id, 'ride_offer_id', ro.id,
           'distance_m', ro.distance_meters, 'is_stacked', ro.is_stacked,
           'offered_driver_net_pence', ro.offered_driver_net_pence,
           'effective_commission_percent', ro.effective_commission_percent)), '[]'::jsonb)
    INTO v_selected_json
   FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id AND ro.broadcast_round = v_seq;

  IF v_inserted = 0 THEN
    UPDATE public.trips
      SET current_broadcast_round=v_seq, last_broadcast_at=v_now,
          searching_expires_at=COALESCE(searching_expires_at, v_search_deadline),
          max_wave_commission_reduction_percent=GREATEST(
            COALESCE(max_wave_commission_reduction_percent,0), v_reduction_pct),
          updated_at=v_now
      WHERE id=p_trip_id;
    v_status := 'no_drivers';
    v_reason := 'no_eligible_drivers';
  ELSE
    UPDATE public.trips
      SET status='offered', dispatch_status='broadcasting',
          current_broadcast_round=v_seq,
          broadcast_started_at=COALESCE(v_trip.broadcast_started_at, v_now),
          last_broadcast_at=v_now,
          searching_expires_at=COALESCE(searching_expires_at, v_search_deadline),
          max_wave_commission_reduction_percent=GREATEST(
            COALESCE(max_wave_commission_reduction_percent,0), v_reduction_pct),
          updated_at=v_now
      WHERE id=p_trip_id;
    v_status := 'dispatched';
  END IF;

  INSERT INTO public.dispatch_wave_snapshots(
    trip_id, dispatch_round, trigger_reason, wave_cap, search_radius_meters,
    candidate_count, eligible_count, degraded_count, hard_excluded_count,
    selected_count, offer_created_count, selected_drivers, previous_round_drivers,
    reason_for_next_wave
  ) VALUES (
    p_trip_id, v_seq, p_trigger_reason, v_wave_cap, v_radius,
    v_candidate_count, v_eligible_count, v_degraded_count, v_hard_excl_count,
    v_selected_count, v_inserted, v_selected_json, v_previous_json,
    CASE WHEN v_inserted = 0 THEN 'no_eligible_drivers' ELSE NULL END
  );

  IF v_inserted = 0 THEN
    PERFORM public.maybe_advance_dispatch_after_offer_resolution(p_trip_id, NULL);
  END IF;

  RETURN jsonb_build_object(
    'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
    'round', v_round, 'wave', v_wave, 'wave_sequence', v_seq,
    'status', v_status,
    'offers_created', v_inserted,
    'offer_ids', to_jsonb(v_offer_ids),
    'selected_driver_ids', to_jsonb(v_selected_ids),
    'skipped_driver_ids', to_jsonb(v_skipped_ids),
    'candidate_count', v_candidate_count,
    'eligible_count', v_eligible_count,
    'wave_cap', v_wave_cap,
    'search_radius_meters', v_radius,
    'base_commission_percent', v_base_pct,
    'wave_commission_reduction_percent', v_reduction_pct,
    'effective_commission_percent', v_effective_pct,
    'offered_driver_net_pence', v_offered_net,
    'reason', v_reason
  );
END;
$function$;
