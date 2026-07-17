-- Phase 6 gap-close: INSERT assignment reserve, SQL dispatch CW soft gate,
-- tighten reserve CHECK (wallet must be on when reserve enabled).

-- 1) Soft gate helper for SQL dispatch paths (Scan & Go + emergency waves).
CREATE OR REPLACE FUNCTION public.driver_passes_commission_wallet_dispatch_gate(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_fare_minor integer;
  v_pct numeric;
  v_rate_bps integer;
  v_required integer;
  v_usable integer;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN true;
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id;

  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF NOT public.is_commission_wallet_reserve_enabled(v_trip.service_area_id) THEN
    RETURN true;
  END IF;

  v_fare_minor := public.trip_commission_reserve_fare_minor(v_trip);
  v_pct := COALESCE(
    NULLIF(v_trip.driver_tier_commission_percent, 0),
    public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id),
    0
  );
  v_rate_bps := GREATEST(
    0,
    COALESCE(NULLIF(v_trip.snapshotted_commission_rate_bps, 0), ROUND(v_pct * 100)::integer)
  );
  v_required := public.required_commission_reserve_minor(v_fare_minor, v_rate_bps);

  IF v_required <= 0 THEN
    RETURN true;
  END IF;

  v_usable := public.driver_commission_wallet_usable_balance_minor(p_driver_id, v_trip.service_area_id);
  RETURN v_usable >= v_required;
END;
$$;

COMMENT ON FUNCTION public.driver_passes_commission_wallet_dispatch_gate(uuid, uuid) IS
  'Phase 6: true when CW reserve gate is off or driver usable balance covers estimated commission reserve.';

GRANT EXECUTE ON FUNCTION public.driver_passes_commission_wallet_dispatch_gate(uuid, uuid) TO authenticated, service_role;

-- 2) Patch SQL dispatch_trip_offers with CW soft gate (Scan & Go + emergency waves).
CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid, p_internal boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  v_locked_driver record;
  v_inserted int;
  v_cooldown_seconds int;
  v_emergency_only boolean;
BEGIN
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

  v_settings := public.get_dispatch_settings(v_trip.service_area_id);

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
       OR v_locked_driver.last_heartbeat_at <= v_now - make_interval(secs => v_presence_max_age_seconds)
    THEN
      UPDATE public.trips
      SET status = 'expired', dispatch_status = 'expired', cancel_reason = 'scan_go_driver_unavailable', updated_at = v_now
      WHERE id = p_trip_id AND status NOT IN ('completed', 'cancelled', 'expired');
      RETURN;
    END IF;

    v_expires_at := v_now + make_interval(secs => public.dispatch_wave_offer_expiry_seconds(v_settings, 1));

    -- Phase 6: CW soft gate for Scan & Go locked driver (parity with auto-dispatch).
    IF NOT public.driver_passes_commission_wallet_dispatch_gate(v_trip.locked_driver_id, p_trip_id) THEN
      UPDATE public.trips
      SET status = 'expired',
          dispatch_status = 'expired',
          cancel_reason = 'insufficient_commission_wallet_balance',
          updated_at = v_now
      WHERE id = p_trip_id AND status NOT IN ('completed', 'cancelled', 'expired');
      RETURN;
    END IF;

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
      jsonb_build_object(
        'scan_and_go', true,
        'locked_driver', true,
        'dispatch_source', 'sql_dispatch_trip_offers'
      )
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
      AND COALESCE(d.display_rating, d.rating, 0) >= COALESCE(v_settings.minimum_rating, 0)
      AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
      AND NOT (d.id = ANY (COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[])))
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
          AND ro.status IN ('pending', 'declined', 'accepted', 'revoked', 'countered')
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

COMMENT ON FUNCTION public.dispatch_trip_offers(uuid, boolean) IS
  'SQL dispatch (Scan & Go / emergency). Phase 6: filters drivers via driver_passes_commission_wallet_dispatch_gate when CW reserve enabled.';

-- 3) Reserve on INSERT assignment as well as UPDATE OF driver_id.
CREATE OR REPLACE FUNCTION public.trg_commission_wallet_on_trip_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Release when assignment cleared (UPDATE only).
  IF TG_OP = 'UPDATE'
     AND OLD.driver_id IS NOT NULL
     AND (NEW.driver_id IS NULL OR NEW.driver_id IS DISTINCT FROM OLD.driver_id) THEN
    v_result := public.release_driver_commission_wallet(
      OLD.driver_id,
      NEW.id,
      CASE
        WHEN NEW.driver_id IS NULL THEN 'assignment_cleared'
        ELSE 'driver_reassigned'
      END
    );
    IF COALESCE(v_result->>'ok', 'false') <> 'true' THEN
      RAISE WARNING 'commission wallet release failed: %', v_result;
    END IF;
  END IF;

  -- Reserve on new assignment (INSERT with driver_id, accept / stacked / reassign UPDATE).
  IF NEW.driver_id IS NOT NULL
     AND (
       TG_OP = 'INSERT'
       OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     ) THEN
    v_result := public.reserve_driver_commission_wallet(NEW.driver_id, NEW.id);
    IF COALESCE(v_result->>'ok', 'false') <> 'true' THEN
      IF COALESCE(v_result->>'skipped', 'false') = 'true'
         OR COALESCE(v_result->>'code', '') IN ('WALLET_GATE_OFF', 'ZERO_RESERVE') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION '%', COALESCE(v_result->>'error', v_result->>'code', 'COMMISSION_RESERVE_FAILED')
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_wallet_on_trip_assignment ON public.trips;
CREATE TRIGGER trg_commission_wallet_on_trip_assignment
  AFTER INSERT OR UPDATE OF driver_id ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_commission_wallet_on_trip_assignment();

-- 4) Tighten SA consistency: reserve cannot be on unless wallet is enabled.
UPDATE public.service_areas
SET commission_reserve_enabled = false
WHERE commission_reserve_enabled = true
  AND (
    financial_model <> 'DRIVER_COLLECTED_COMMISSION_WALLET'
    OR commission_wallet_enabled IS NOT TRUE
  );

ALTER TABLE public.service_areas
  DROP CONSTRAINT IF EXISTS service_areas_commission_wallet_model_consistency;
ALTER TABLE public.service_areas
  ADD CONSTRAINT service_areas_commission_wallet_model_consistency
  CHECK (
    (
      financial_model = 'PLATFORM_COLLECTED'
      AND commission_wallet_enabled = false
      AND commission_reserve_enabled = false
    )
    OR (
      financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
      AND (
        commission_reserve_enabled = false
        OR commission_wallet_enabled = true
      )
    )
  );
