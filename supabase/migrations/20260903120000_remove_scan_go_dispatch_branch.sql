-- Remove retired locked-driver / scan_and_go dispatch branch from dispatch_trip_offers.
-- Normal rematch / broadcasting always uses auto-dispatch Edge (or emergency SQL waves).
-- Drop immutability trigger first so residual flags can be cleared below.
DROP TRIGGER IF EXISTS tr_validate_scan_go_lock ON public.trips;

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
  'SQL emergency dispatch. Retired locked-driver path removed. Phase 6 CW soft gate applies to wave candidates.';

-- Clear residual retired locked-driver / scan_and_go flags so rematch/dispatch treat trips as normal bookings.
UPDATE public.trips
SET
  locked_driver_id = CASE WHEN scan_go = true THEN NULL ELSE locked_driver_id END,
  dispatch_mode = CASE
    WHEN dispatch_mode IN ('scan_and_go', 'locked_driver') THEN NULL
    ELSE dispatch_mode
  END,
  scan_go = false,
  updated_at = now()
WHERE scan_go = true
   OR dispatch_mode IN ('scan_and_go', 'locked_driver');
