-- ============================================================================
-- P0 fix: Background location SSOT / "frozen driver" bug (audit: Ahmed Osman).
--
-- ROOT CAUSE (confirmed):
--   The driver app's 15s presence heartbeat republishes the LAST KNOWN
--   (possibly cached/stale) coordinates through upsert_driver_presence on
--   every tick. That RPC unconditionally treated any non-null p_lat/p_lng as
--   "fresh": it bumped driver_presence.last_location_at + mirrored into
--   drivers.current_lat/current_lng/last_location_updated_at even when the
--   coordinates never changed. Presence therefore looked perpetually healthy
--   (last_heartbeat_at always fresh) while the reported position silently
--   froze. Every downstream consumer that trusts last_location_at /
--   current_lat/current_lng (dispatch, find_nearby_drivers, Admin Fleet)
--   inherited the same stale-but-"fresh-looking" position.
--
-- FIX (additive, backward compatible):
--   1. upsert_driver_presence now only advances location-freshness columns
--      (last_location_at, last_gps_sample_at, last_coordinate_change_at,
--      drivers.current_lat/lng, drivers.last_location_updated_at) for a
--      genuinely NEW sample:
--        - if the caller supplies p_gps_recorded_at (new app builds), the
--          sample is validated (not from the future, not older than the
--          configured max age, not older than the last accepted sample by
--          more than a small tolerance, not byte-identical to the last
--          accepted sample) before being accepted;
--        - if the caller omits p_gps_recorded_at (every driver app version
--          already installed today), a coordinate-equality heuristic is
--          used instead: a sample whose lat/lng is IDENTICAL to the
--          currently stored lat/lng is treated as an unproven cache replay
--          and does NOT advance freshness. Real GPS fixes vary at double
--          precision even when the vehicle is stationary, so this closes
--          the confirmed bug immediately, without requiring a mobile
--          release, while a driver who is genuinely moving is unaffected.
--      Heartbeat fields (last_heartbeat_at, app_state, platform, battery,
--      socket, push token, presence_health, is_online, ...) continue to be
--      refreshed on every call exactly as before - liveness and location
--      freshness are now independent signals.
--   2. New columns capture the richer signal: driver_presence/drivers gain
--      last_gps_sample_at (server receipt time of the last ACCEPTED sample),
--      last_gps_recorded_at (device/GPS fix time, presence-only), and
--      last_coordinate_change_at (last time the driver moved more than the
--      configurable jitter threshold). last_significant_move_at/lat/lng
--      (pre-existing, previously unpopulated) are restored in lockstep.
--   3. driver_location_state()/driver_location_is_frozen() give one
--      authoritative derived status - location_live | location_stationary |
--      location_frozen | location_stale | location_unavailable - reused by
--      dispatch protection (dispatch_trip_offers, find_nearby_drivers) and
--      by the new admin_driver_fleet_status view (Admin Live Fleet).
--
-- Nothing here changes trip/offer tables, RLS, or removes any existing
-- column, index, or function signature. Safe to re-run (IF NOT EXISTS /
-- CREATE OR REPLACE throughout).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Additive columns
-- ----------------------------------------------------------------------------

ALTER TABLE public.driver_presence
  ADD COLUMN IF NOT EXISTS last_gps_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_gps_sample_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_coordinate_change_at timestamptz,
  ADD COLUMN IF NOT EXISTS location_source text;

COMMENT ON COLUMN public.driver_presence.last_gps_recorded_at IS
  'Device/OS-reported GPS fix timestamp of the last ACCEPTED sample (native-app-supplied; null for legacy callers). Used to reject stale/out-of-order/duplicate samples.';
COMMENT ON COLUMN public.driver_presence.last_gps_sample_at IS
  'Server receipt time of the last ACCEPTED genuine location sample. This - not last_heartbeat_at - is the authoritative "is the GPS pipeline alive" clock.';
COMMENT ON COLUMN public.driver_presence.last_coordinate_change_at IS
  'Last time the driver moved more than driver_location_thresholds().movement_threshold_meters from its previous tracked point. Populated in lockstep with last_significant_move_at/lat/lng.';
COMMENT ON COLUMN public.driver_presence.location_source IS
  'Provenance of the last accepted sample, e.g. foreground_gps | background_gps | go_online. Diagnostic only.';

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS last_gps_sample_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_coordinate_change_at timestamptz,
  ADD COLUMN IF NOT EXISTS location_source text;

COMMENT ON COLUMN public.drivers.last_gps_sample_at IS
  'Mirror of driver_presence.last_gps_sample_at for callers (Admin Fleet, dispatch Edges) that read drivers directly.';
COMMENT ON COLUMN public.drivers.last_coordinate_change_at IS
  'Mirror of driver_presence.last_coordinate_change_at.';
COMMENT ON COLUMN public.drivers.location_source IS
  'Mirror of driver_presence.location_source.';

CREATE INDEX IF NOT EXISTS idx_driver_presence_gps_sample_at
  ON public.driver_presence (last_gps_sample_at)
  WHERE status IN ('online', 'on_trip');

-- ----------------------------------------------------------------------------
-- 2. Single source of truth for thresholds (tune here, not scattered inline)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.driver_location_thresholds()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    -- Heartbeat (liveness) freshness window. Matches the driver app's
    -- documented contract (presenceHeartbeatTiming.ts DISPATCH_STALE_HEARTBEAT_SECONDS).
    'heartbeat_fresh_seconds', 45,
    -- Genuine GPS sample freshness window. Slightly above 2x the 15s
    -- publish cadence to absorb normal jitter/backoff without flapping.
    'gps_fresh_seconds', 60,
    -- Below this speed (m/s) a driver with fresh GPS is "stationary" rather
    -- than "live" (~2.9 km/h - filters GPS noise while parked).
    'stationary_speed_mps', 0.8,
    -- Movement below this distance (metres) is GPS jitter, not real motion.
    'movement_threshold_meters', 50,
    -- Reject a GPS sample whose device timestamp is older than this at
    -- receipt time (accounts for OS-throttled background delivery/Doze).
    'gps_sample_max_age_seconds', 180,
    -- Tolerance for treating a slightly-earlier timestamp as "in order"
    -- (clock skew / near-simultaneous FG+BG delivery), beyond which a
    -- sample is rejected as severely out-of-order.
    'out_of_order_tolerance_seconds', 5,
    -- Reject a GPS sample timestamped more than this far in the future.
    'future_skew_tolerance_seconds', 10
  );
$$;

COMMENT ON FUNCTION public.driver_location_thresholds() IS
  'Single source of truth for location/heartbeat freshness thresholds used by upsert_driver_presence, driver_location_state, and dispatch protection.';

-- ----------------------------------------------------------------------------
-- 3. Derived location state (pure function - unit-testable without a driver row)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.driver_location_state(
  p_driver_online_intent boolean,
  p_last_heartbeat_at timestamptz,
  p_last_gps_sample_at timestamptz,
  p_speed double precision DEFAULT NULL,
  p_now timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  WITH t AS (SELECT public.driver_location_thresholds() AS v)
  SELECT CASE
    WHEN NOT COALESCE(p_driver_online_intent, false) THEN 'location_unavailable'
    WHEN p_last_heartbeat_at IS NULL THEN 'location_unavailable'
    WHEN p_now - p_last_heartbeat_at > make_interval(secs => (SELECT (v->>'heartbeat_fresh_seconds')::int FROM t))
      THEN 'location_stale'
    WHEN p_last_gps_sample_at IS NULL THEN 'location_unavailable'
    WHEN p_now - p_last_gps_sample_at > make_interval(secs => (SELECT (v->>'gps_fresh_seconds')::int FROM t))
      THEN 'location_frozen'
    WHEN COALESCE(p_speed, 0) < (SELECT (v->>'stationary_speed_mps')::double precision FROM t)
      THEN 'location_stationary'
    ELSE 'location_live'
  END;
$$;

COMMENT ON FUNCTION public.driver_location_state(boolean, timestamptz, timestamptz, double precision, timestamptz) IS
  'Derives location_live | location_stationary | location_frozen | location_stale | location_unavailable from raw heartbeat/GPS-sample freshness. Frozen = heartbeat still fresh (device alive) but no genuine GPS sample within the freshness window (GPS pipeline stalled while cache/heartbeat kept publishing).';

CREATE OR REPLACE FUNCTION public.driver_location_state_for_driver(p_driver_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.driver_location_state(
    d.driver_online_intent,
    dp.last_heartbeat_at,
    COALESCE(dp.last_gps_sample_at, d.last_gps_sample_at),
    COALESCE(dp.speed, d.speed)
  )
  FROM public.drivers d
  LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
  WHERE d.id = p_driver_id;
$$;

COMMENT ON FUNCTION public.driver_location_state_for_driver(uuid) IS
  'Convenience wrapper around driver_location_state() joining live drivers + driver_presence columns for a single driver.';

CREATE OR REPLACE FUNCTION public.driver_location_is_frozen(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.driver_location_state_for_driver(p_driver_id) = 'location_frozen';
$$;

COMMENT ON FUNCTION public.driver_location_is_frozen(uuid) IS
  'True when the driver''s heartbeat is fresh but no genuine GPS sample has landed within the freshness window. Used as a hard dispatch-exclusion gate (dispatch_trip_offers, find_nearby_drivers) - frozen drivers are excluded from new offers/customer map until fresh GPS resumes, without forcing them offline or touching an active trip.';

-- ----------------------------------------------------------------------------
-- 4. The authoritative writer: upsert_driver_presence (CREATE OR REPLACE)
--    Signature is backward compatible - two new optional trailing params.
-- ----------------------------------------------------------------------------

-- Prod currently has only the legacy 16-param overload (verified via
-- pg_get_function_identity_arguments against thazislrdkjpvvghtvzo). The
-- CREATE OR REPLACE below adds 2 new trailing params, which Postgres
-- treats as a distinct overload rather than a replace, causing a
-- "function name is not unique" error (42725) on internal callers below.
-- Drop the old 16-param signature explicitly first so CREATE OR REPLACE
-- unambiguously defines a single 18-param upsert_driver_presence.
DROP FUNCTION IF EXISTS public.upsert_driver_presence(uuid,text,double precision,double precision,double precision,double precision,text,text,text,text,double precision,smallint,boolean,boolean,text,text);

CREATE OR REPLACE FUNCTION public.upsert_driver_presence(
  p_driver_id uuid,
  p_status text DEFAULT NULL::text,
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_heading double precision DEFAULT NULL::double precision,
  p_speed double precision DEFAULT NULL::double precision,
  p_app_state text DEFAULT NULL::text,
  p_platform text DEFAULT NULL::text,
  p_push_token text DEFAULT NULL::text,
  p_device_id text DEFAULT NULL::text,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_battery_level smallint DEFAULT NULL::smallint,
  p_socket_connected boolean DEFAULT NULL::boolean,
  p_unresolved_critical_tracking boolean DEFAULT NULL::boolean,
  p_network_type text DEFAULT NULL::text,
  p_offline_reason text DEFAULT NULL::text,
  p_gps_recorded_at timestamptz DEFAULT NULL::timestamptz,
  p_source text DEFAULT NULL::text
)
 RETURNS driver_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result public.driver_presence;
  v_driver public.drivers%ROWTYPE;
  v_prev public.driver_presence%ROWTYPE;
  v_prev_hb timestamptz;
  v_gap_s integer;
  v_low_accuracy boolean;
  v_active_device text;
  v_effective_online boolean;
  v_eligible jsonb;
  v_next_status text;
  v_thresholds jsonb;
  v_now timestamptz := now();
  v_lat double precision := p_lat;
  v_lng double precision := p_lng;
  v_accept_location boolean := false;
  v_location_reject_reason text := NULL;
  v_coordinate_changed boolean := false;
  v_ref_lat double precision;
  v_ref_lng double precision;
  v_move_m double precision;
BEGIN
  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_id required';
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRIVER_NOT_FOUND';
  END IF;

  -- Ownership: caller must own the driver (or service_role/admin).
  IF auth.role() <> 'service_role'
     AND auth.uid() IS DISTINCT FROM v_driver.user_id
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.user_id = auth.uid() AND p.role = 'admin'
     )
  THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED'
      USING ERRCODE = 'P0001';
  END IF;

  -- Reject legacy intent-changing status transitions via upsert.
  IF p_status = 'offline' AND public.is_explicit_offline_reason(p_offline_reason) THEN
    RAISE EXCEPTION 'USE_DRIVER_REQUEST_GO_OFFLINE: call driver_request_go_offline instead'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_status IN ('online', 'on_trip')
     AND COALESCE(v_driver.driver_online_intent, false) <> true
  THEN
    RAISE EXCEPTION 'USE_DRIVER_REQUEST_GO_ONLINE: call driver_request_go_online instead'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_prev FROM public.driver_presence WHERE driver_id = p_driver_id;
  v_prev_hb := v_prev.last_heartbeat_at;

  IF v_prev_hb IS NOT NULL THEN
    v_gap_s := GREATEST(0, floor(extract(epoch FROM (v_now - v_prev_hb)))::integer);
    IF v_gap_s < 2 AND COALESCE(p_status, '') <> 'offline' THEN
      IF FOUND THEN
        RETURN v_prev;
      END IF;
    END IF;
  END IF;

  IF p_device_id IS NOT NULL THEN
    SELECT device_id INTO v_active_device
    FROM public.driver_active_devices
    WHERE driver_id = p_driver_id;
    IF v_active_device IS NOT NULL AND v_active_device <> p_device_id THEN
      RAISE EXCEPTION 'STALE_DEVICE: device % is not the active device for driver %',
        p_device_id, p_driver_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_low_accuracy := (p_accuracy IS NOT NULL AND p_accuracy > 50);

  v_next_status := COALESCE(
    p_status,
    CASE
      WHEN COALESCE(v_driver.driver_online_intent, false) THEN 'online'
      ELSE 'offline'
    END
  );

  -- ── Location-freshness gate ──────────────────────────────────────────────
  -- This is the P0 fix: only a genuinely NEW sample may advance
  -- last_location_at / last_gps_sample_at / last_coordinate_change_at /
  -- drivers.current_lat/lng / drivers.last_location_updated_at. A heartbeat
  -- tick that merely republishes the same cached fix must NOT look fresh.
  v_thresholds := public.driver_location_thresholds();

  IF v_lat IS NOT NULL AND v_lng IS NOT NULL THEN
    -- Impossible-coordinate guard (NaN self-inequality check included).
    IF v_lat <> v_lat OR v_lng <> v_lng
       OR abs(v_lat) > 90 OR abs(v_lng) > 180
       OR (v_lat = 0 AND v_lng = 0)
    THEN
      v_lat := NULL;
      v_lng := NULL;
      v_location_reject_reason := 'impossible_coordinates';
    END IF;
  END IF;

  IF v_lat IS NOT NULL AND v_lng IS NOT NULL THEN
    IF p_gps_recorded_at IS NOT NULL THEN
      -- New app builds: caller proves this is a genuine device GPS fix.
      IF p_gps_recorded_at > v_now + make_interval(secs => (v_thresholds->>'future_skew_tolerance_seconds')::int) THEN
        v_location_reject_reason := 'future_timestamp';
      ELSIF p_gps_recorded_at < v_now - make_interval(secs => (v_thresholds->>'gps_sample_max_age_seconds')::int) THEN
        v_location_reject_reason := 'stale_gps_timestamp';
      ELSIF v_prev.last_gps_recorded_at IS NOT NULL
            AND p_gps_recorded_at < v_prev.last_gps_recorded_at - make_interval(secs => (v_thresholds->>'out_of_order_tolerance_seconds')::int)
      THEN
        v_location_reject_reason := 'out_of_order_sample';
      ELSIF v_prev.last_gps_recorded_at IS NOT NULL
            AND v_prev.last_gps_recorded_at = p_gps_recorded_at
            AND v_prev.lat = v_lat AND v_prev.lng = v_lng
      THEN
        v_location_reject_reason := 'duplicate_cached_sample';
      ELSE
        v_accept_location := true;
      END IF;
    ELSE
      -- Legacy callers (every driver app version live today): no proof of a
      -- fresh GPS timestamp is available. Coordinate-equality heuristic -
      -- a real device GPS fix varies at double precision even when
      -- stationary; an EXACT repeat of the previously stored fix is the
      -- confirmed cache-replay bug pattern and must not advance freshness.
      IF v_prev.lat IS NOT NULL AND v_prev.lng IS NOT NULL
         AND v_prev.lat = v_lat AND v_prev.lng = v_lng
      THEN
        v_location_reject_reason := 'duplicate_cached_sample_no_timestamp';
      ELSE
        v_accept_location := true;
      END IF;
    END IF;
  END IF;

  IF v_accept_location THEN
    v_ref_lat := COALESCE(v_prev.last_significant_move_lat, v_prev.lat);
    v_ref_lng := COALESCE(v_prev.last_significant_move_lng, v_prev.lng);
    IF v_ref_lat IS NULL OR v_ref_lng IS NULL THEN
      v_coordinate_changed := true;
    ELSE
      v_move_m := public.haversine_meters(v_ref_lat, v_ref_lng, v_lat, v_lng);
      v_coordinate_changed := v_move_m >= (v_thresholds->>'movement_threshold_meters')::double precision;
    END IF;
  END IF;

  INSERT INTO public.driver_presence (
    driver_id, status, last_heartbeat_at,
    lat, lng, heading, speed, last_location_at,
    last_gps_recorded_at, last_gps_sample_at, location_source,
    last_coordinate_change_at, last_significant_move_at,
    last_significant_move_lat, last_significant_move_lng,
    app_state, platform, push_token,
    accuracy_m, battery_level, low_accuracy,
    socket_connected, unresolved_critical_tracking,
    last_socket_pong_at, network_type,
    presence_health, offline_reason, updated_at
  ) VALUES (
    p_driver_id,
    v_next_status,
    v_now,
    CASE WHEN v_accept_location THEN v_lat ELSE NULL END,
    CASE WHEN v_accept_location THEN v_lng ELSE NULL END,
    p_heading, p_speed,
    CASE WHEN v_accept_location THEN v_now ELSE NULL END,
    CASE WHEN v_accept_location THEN p_gps_recorded_at ELSE NULL END,
    CASE WHEN v_accept_location THEN v_now ELSE NULL END,
    CASE WHEN v_accept_location THEN p_source ELSE NULL END,
    CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE NULL END,
    CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE NULL END,
    CASE WHEN v_accept_location AND v_coordinate_changed THEN v_lat ELSE NULL END,
    CASE WHEN v_accept_location AND v_coordinate_changed THEN v_lng ELSE NULL END,
    COALESCE(p_app_state, 'foreground'),
    p_platform,
    p_push_token,
    p_accuracy, p_battery_level, v_low_accuracy,
    p_socket_connected,
    COALESCE(p_unresolved_critical_tracking, false),
    CASE WHEN COALESCE(p_socket_connected, false) THEN v_now ELSE NULL END,
    NULLIF(trim(COALESCE(p_network_type, '')), ''),
    CASE
      WHEN COALESCE(v_driver.driver_online_intent, false)
           AND v_next_status IN ('online', 'on_trip', 'paused')
        THEN 'healthy'
      ELSE 'offline'
    END,
    CASE
      WHEN public.is_explicit_offline_reason(p_offline_reason) THEN p_offline_reason
      ELSE NULL
    END,
    v_now
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = CASE
      WHEN p_status IS NOT NULL THEN p_status
      WHEN COALESCE(v_driver.driver_online_intent, false) THEN
        CASE
          WHEN public.driver_presence.status IN ('online', 'on_trip', 'paused')
            THEN public.driver_presence.status
          ELSE 'online'
        END
      ELSE public.driver_presence.status
    END,
    last_heartbeat_at = v_now,
    lat = CASE WHEN v_accept_location THEN v_lat ELSE public.driver_presence.lat END,
    lng = CASE WHEN v_accept_location THEN v_lng ELSE public.driver_presence.lng END,
    -- Gated on v_accept_location (not just "was a value supplied"): a
    -- rejected/duplicate location sample must not leak a new heading/speed/
    -- accuracy reading into driver_presence either — the whole GPS sample
    -- (lat, lng, gps_ts, accuracy, speed, course) is accepted or rejected
    -- as one atomic unit. A pure heartbeat (driver_heartbeat_ping — no
    -- p_heading/p_speed supplied) already no-ops via COALESCE regardless.
    heading = CASE WHEN v_accept_location THEN COALESCE(p_heading, public.driver_presence.heading) ELSE public.driver_presence.heading END,
    speed = CASE WHEN v_accept_location THEN COALESCE(p_speed, public.driver_presence.speed) ELSE public.driver_presence.speed END,
    last_location_at = CASE WHEN v_accept_location THEN v_now ELSE public.driver_presence.last_location_at END,
    last_gps_recorded_at = CASE WHEN v_accept_location THEN p_gps_recorded_at ELSE public.driver_presence.last_gps_recorded_at END,
    last_gps_sample_at = CASE WHEN v_accept_location THEN v_now ELSE public.driver_presence.last_gps_sample_at END,
    location_source = CASE WHEN v_accept_location THEN p_source ELSE public.driver_presence.location_source END,
    last_coordinate_change_at = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE public.driver_presence.last_coordinate_change_at END,
    last_significant_move_at = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE public.driver_presence.last_significant_move_at END,
    last_significant_move_lat = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_lat ELSE public.driver_presence.last_significant_move_lat END,
    last_significant_move_lng = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_lng ELSE public.driver_presence.last_significant_move_lng END,
    app_state = COALESCE(p_app_state, public.driver_presence.app_state),
    platform = COALESCE(p_platform, public.driver_presence.platform),
    push_token = COALESCE(p_push_token, public.driver_presence.push_token),
    accuracy_m = CASE WHEN v_accept_location THEN COALESCE(p_accuracy, public.driver_presence.accuracy_m) ELSE public.driver_presence.accuracy_m END,
    battery_level = COALESCE(p_battery_level, public.driver_presence.battery_level),
    low_accuracy = CASE WHEN v_accept_location AND p_accuracy IS NOT NULL THEN v_low_accuracy ELSE public.driver_presence.low_accuracy END,
    socket_connected = COALESCE(p_socket_connected, public.driver_presence.socket_connected),
    unresolved_critical_tracking = COALESCE(p_unresolved_critical_tracking, public.driver_presence.unresolved_critical_tracking),
    last_socket_pong_at = CASE
      WHEN COALESCE(p_socket_connected, false) THEN v_now
      ELSE public.driver_presence.last_socket_pong_at
    END,
    network_type = CASE
      WHEN p_network_type IS NOT NULL AND trim(p_network_type) <> '' THEN trim(p_network_type)
      ELSE public.driver_presence.network_type
    END,
    presence_health = CASE
      WHEN COALESCE(v_driver.driver_online_intent, false) THEN 'healthy'
      ELSE COALESCE(public.driver_presence.presence_health, 'offline')
    END,
    offline_reason = CASE
      WHEN public.is_explicit_offline_reason(p_offline_reason) THEN p_offline_reason
      WHEN COALESCE(v_driver.driver_online_intent, false)
           AND NOT public.is_explicit_offline_reason(public.driver_presence.offline_reason)
        THEN NULL
      ELSE public.driver_presence.offline_reason
    END,
    updated_at = v_now
  RETURNING * INTO v_result;

  v_eligible := public.assert_driver_presence_online_eligible(p_driver_id);
  v_effective_online :=
    COALESCE(v_driver.driver_online_intent, false)
    AND COALESCE((v_eligible ->> 'eligible')::boolean, false)
    AND v_result.status IN ('online', 'on_trip', 'paused');

  PERFORM public.allow_driver_availability_write();
  UPDATE public.drivers SET
    is_online = v_effective_online,
    current_lat = CASE WHEN v_accept_location THEN v_lat ELSE current_lat END,
    current_lng = CASE WHEN v_accept_location THEN v_lng ELSE current_lng END,
    heading = CASE WHEN v_accept_location THEN COALESCE(p_heading, heading) ELSE heading END,
    speed = CASE WHEN v_accept_location THEN COALESCE(p_speed, speed) ELSE speed END,
    last_location_updated_at = CASE WHEN v_accept_location THEN v_now ELSE last_location_updated_at END,
    last_gps_sample_at = CASE WHEN v_accept_location THEN v_now ELSE last_gps_sample_at END,
    location_source = CASE WHEN v_accept_location THEN p_source ELSE location_source END,
    last_coordinate_change_at = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE last_coordinate_change_at END,
    last_seen_at = v_now,
    updated_at = v_now
  WHERE id = p_driver_id;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.upsert_driver_presence(
  uuid, text, double precision, double precision, double precision, double precision,
  text, text, text, text, double precision, smallint, boolean, boolean, text, text,
  timestamptz, text
) IS
  'Single authoritative presence + location writer, derived-owner-checked against auth.uid(). Heartbeat fields always refresh; location-freshness fields (last_location_at, last_gps_sample_at, last_coordinate_change_at, drivers.current_lat/lng) only advance for a genuinely new GPS sample (see driver_location_thresholds()). P0 fix for the frozen-driver-location bug - see migration 20260910120000.';

-- ----------------------------------------------------------------------------
-- 4b. driver_request_go_online also supplies a genuine fresh fix (the coords
--     used to go online). Populate the new freshness columns here too, so a
--     driver never shows location_unavailable for the first heartbeat cycle
--     after going online (cold-start gap - go-online writes dp.lat/lng, and
--     without this the very next heartbeat, on peeking the same
--     just-cached coords, would correctly-but-confusingly reject it as a
--     duplicate before the driver's next genuinely new GPS fix arrives).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.driver_request_go_online(
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_heading double precision DEFAULT NULL::double precision,
  p_speed double precision DEFAULT NULL::double precision,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_app_state text DEFAULT 'foreground'::text,
  p_platform text DEFAULT NULL::text,
  p_network_type text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_driver public.drivers%ROWTYPE;
  v_eligibility jsonb;
  v_from_intent boolean;
  v_from_online boolean;
  v_now timestamptz := now();
BEGIN
  v_driver_id := public.require_authenticated_driver_id();

  SELECT * INTO v_driver FROM public.drivers WHERE id = v_driver_id FOR UPDATE;

  v_from_intent := COALESCE(v_driver.driver_online_intent, false);
  v_from_online := COALESCE(v_driver.is_online, false);

  v_eligibility := public.assert_driver_presence_online_eligible(v_driver_id);
  IF COALESCE((v_eligibility ->> 'eligible')::boolean, false) <> true THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', COALESCE(v_eligibility ->> 'code', 'ONLINE_ELIGIBILITY_BLOCKED'),
      'message', COALESCE(v_eligibility ->> 'message', 'Driver is not eligible to go online.'),
      'driver_id', v_driver_id,
      'driver_online_intent', v_from_intent,
      'is_online', v_from_online
    );
  END IF;

  PERFORM public.allow_driver_availability_write();

  UPDATE public.drivers
  SET driver_online_intent = true,
      is_online = true,
      online_since = CASE
        WHEN COALESCE(driver_online_intent, false) = true AND online_since IS NOT NULL THEN online_since
        ELSE v_now
      END,
      current_lat = COALESCE(p_lat, current_lat),
      current_lng = COALESCE(p_lng, current_lng),
      heading = COALESCE(p_heading, heading),
      speed = COALESCE(p_speed, speed),
      last_location_updated_at = CASE WHEN p_lat IS NOT NULL THEN v_now ELSE last_location_updated_at END,
      last_gps_sample_at = CASE WHEN p_lat IS NOT NULL THEN v_now ELSE last_gps_sample_at END,
      location_source = CASE WHEN p_lat IS NOT NULL THEN 'go_online' ELSE location_source END,
      last_coordinate_change_at = CASE WHEN p_lat IS NOT NULL THEN v_now ELSE last_coordinate_change_at END,
      last_seen_at = v_now,
      updated_at = v_now
  WHERE id = v_driver_id;

  INSERT INTO public.driver_presence (
    driver_id, status, presence_health, last_heartbeat_at, lat, lng, heading, speed,
    last_location_at, last_gps_recorded_at, last_gps_sample_at, location_source,
    last_coordinate_change_at, last_significant_move_at,
    last_significant_move_lat, last_significant_move_lng,
    app_state, platform, network_type, offline_reason, last_offline_at, updated_at
  ) VALUES (
    v_driver_id, 'online', 'healthy', v_now, p_lat, p_lng, p_heading, p_speed,
    CASE WHEN p_lat IS NOT NULL THEN v_now ELSE NULL END,
    NULL,
    CASE WHEN p_lat IS NOT NULL THEN v_now ELSE NULL END,
    CASE WHEN p_lat IS NOT NULL THEN 'go_online' ELSE NULL END,
    CASE WHEN p_lat IS NOT NULL THEN v_now ELSE NULL END,
    CASE WHEN p_lat IS NOT NULL THEN v_now ELSE NULL END,
    p_lat, p_lng,
    COALESCE(NULLIF(trim(p_app_state), ''), 'foreground'),
    p_platform, NULLIF(trim(COALESCE(p_network_type, '')), ''), NULL, NULL, v_now
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = 'online',
    presence_health = 'healthy',
    last_heartbeat_at = v_now,
    lat = COALESCE(EXCLUDED.lat, public.driver_presence.lat),
    lng = COALESCE(EXCLUDED.lng, public.driver_presence.lng),
    heading = COALESCE(EXCLUDED.heading, public.driver_presence.heading),
    speed = COALESCE(EXCLUDED.speed, public.driver_presence.speed),
    last_location_at = CASE WHEN EXCLUDED.lat IS NOT NULL THEN v_now ELSE public.driver_presence.last_location_at END,
    last_gps_sample_at = CASE WHEN EXCLUDED.lat IS NOT NULL THEN v_now ELSE public.driver_presence.last_gps_sample_at END,
    location_source = CASE WHEN EXCLUDED.lat IS NOT NULL THEN 'go_online' ELSE public.driver_presence.location_source END,
    last_coordinate_change_at = CASE WHEN EXCLUDED.lat IS NOT NULL THEN v_now ELSE public.driver_presence.last_coordinate_change_at END,
    last_significant_move_at = CASE WHEN EXCLUDED.lat IS NOT NULL THEN v_now ELSE public.driver_presence.last_significant_move_at END,
    last_significant_move_lat = CASE WHEN EXCLUDED.lat IS NOT NULL THEN EXCLUDED.lat ELSE public.driver_presence.last_significant_move_lat END,
    last_significant_move_lng = CASE WHEN EXCLUDED.lat IS NOT NULL THEN EXCLUDED.lng ELSE public.driver_presence.last_significant_move_lng END,
    app_state = COALESCE(EXCLUDED.app_state, public.driver_presence.app_state),
    platform = COALESCE(EXCLUDED.platform, public.driver_presence.platform),
    network_type = COALESCE(EXCLUDED.network_type, public.driver_presence.network_type),
    offline_reason = NULL,
    updated_at = v_now;

  PERFORM public.log_driver_availability_event(
    v_driver_id, 'go_online', 'driver_request_go_online',
    v_from_intent, true, v_from_online, true,
    jsonb_build_object('source', 'driver_request_go_online')
  );

  RETURN jsonb_build_object(
    'ok', true, 'code', 'OK', 'message', '',
    'driver_id', v_driver_id,
    'driver_online_intent', true, 'is_online', true, 'status', 'online'
  );
END;
$function$;

COMMENT ON FUNCTION public.driver_request_go_online(double precision, double precision, double precision, double precision, double precision, text, text, text) IS
  'Go-online transition. Also seeds last_gps_sample_at/last_coordinate_change_at (source=go_online) so a driver never shows location_unavailable in the brief window before their first post-go-online heartbeat sees a genuinely new fix.';

-- ----------------------------------------------------------------------------
-- 5. Clear, purpose-named wrappers for native call sites (same underlying
--    writer - "one authoritative owner-derived writer" with two intents).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.driver_heartbeat_ping(
  p_driver_id uuid,
  p_app_state text DEFAULT NULL::text,
  p_platform text DEFAULT NULL::text,
  p_push_token text DEFAULT NULL::text,
  p_device_id text DEFAULT NULL::text,
  p_battery_level smallint DEFAULT NULL::smallint,
  p_socket_connected boolean DEFAULT NULL::boolean,
  p_unresolved_critical_tracking boolean DEFAULT NULL::boolean,
  p_network_type text DEFAULT NULL::text
)
RETURNS driver_presence
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  -- Intentionally never passes p_lat/p_lng/p_gps_recorded_at - a heartbeat
  -- can NEVER advance location freshness, by construction.
  SELECT public.upsert_driver_presence(
    p_driver_id => p_driver_id,
    p_app_state => p_app_state,
    p_platform => p_platform,
    p_push_token => p_push_token,
    p_device_id => p_device_id,
    p_battery_level => p_battery_level,
    p_socket_connected => p_socket_connected,
    p_unresolved_critical_tracking => p_unresolved_critical_tracking,
    p_network_type => p_network_type
  );
$$;

COMMENT ON FUNCTION public.driver_heartbeat_ping(uuid, text, text, text, text, smallint, boolean, boolean, text) IS
  'Liveness-only heartbeat. Never touches lat/lng/last_location_at/last_coordinate_change_at. Call every ~15s while online, independent of GPS.';

GRANT EXECUTE ON FUNCTION public.driver_heartbeat_ping(uuid, text, text, text, text, smallint, boolean, boolean, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_driver_location_sample(
  p_driver_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_gps_recorded_at timestamptz,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_heading double precision DEFAULT NULL::double precision,
  p_speed double precision DEFAULT NULL::double precision,
  p_app_state text DEFAULT NULL::text,
  p_platform text DEFAULT NULL::text,
  p_source text DEFAULT NULL::text
)
RETURNS driver_presence
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.upsert_driver_presence(
    p_driver_id => p_driver_id,
    p_lat => p_lat,
    p_lng => p_lng,
    p_heading => p_heading,
    p_speed => p_speed,
    p_app_state => p_app_state,
    p_platform => p_platform,
    p_accuracy => p_accuracy,
    p_gps_recorded_at => p_gps_recorded_at,
    p_source => p_source
  );
$$;

COMMENT ON FUNCTION public.submit_driver_location_sample(uuid, double precision, double precision, timestamptz, double precision, double precision, double precision, text, text, text) IS
  'Genuine GPS sample submission (foreground watcher / background location task). p_gps_recorded_at must be the device fix timestamp, not the send time. Only accepted, in-order, non-duplicate samples advance location freshness.';

GRANT EXECUTE ON FUNCTION public.submit_driver_location_sample(uuid, double precision, double precision, timestamptz, double precision, double precision, double precision, text, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6. Dispatch protection - exclude frozen drivers from NEW offers without
--    forcing them offline or touching an active trip. Both dispatch_trip_offers
--    overloads are live (trigger tr_trips_dispatch_after_insert calls the
--    (uuid, boolean) overload with p_internal=true on every new instant trip).
-- ----------------------------------------------------------------------------

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
  v_max_rounds := COALESCE(v_trip.max_broadcast_rounds, 3);

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
        AND ro.status IN ('pending','declined','accepted','revoked')
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
          -- Declined/expired remain blocked here; cooldown below still applies.
          AND ro.status IN ('pending', 'declined', 'accepted', 'countered')
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

COMMENT ON FUNCTION public.dispatch_trip_offers(uuid) IS
  'Legacy single-arg dispatcher. Retains driver_location_is_frozen() exclusion added in migration 20260910120000.';
COMMENT ON FUNCTION public.dispatch_trip_offers(uuid, boolean) IS
  'Active dispatcher - called by tr_trips_dispatch_after_insert (p_internal=true) on every new instant trip. driver_location_is_frozen() exclusion added in migration 20260910120000.';

-- ----------------------------------------------------------------------------
-- 7. Customer-facing "nearby drivers" - same frozen exclusion.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.find_nearby_drivers(
  p_lat double precision,
  p_lng double precision,
  p_radius_meters double precision,
  p_limit integer DEFAULT 40,
  p_stale_seconds integer DEFAULT 180
)
RETURNS TABLE(
  driver_id uuid, lat double precision, lng double precision,
  heading double precision, speed double precision,
  distance_meters double precision, updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    d.id AS driver_id,
    COALESCE(dp.lat, d.current_lat)::double precision AS lat,
    COALESCE(dp.lng, d.current_lng)::double precision AS lng,
    COALESCE(dp.heading, d.heading, 0::double precision) AS heading,
    COALESCE(dp.speed, d.speed, 0::double precision) AS speed,
    public.haversine_meters(
      p_lat, p_lng,
      COALESCE(dp.lat, d.current_lat)::double precision,
      COALESCE(dp.lng, d.current_lng)::double precision
    )::double precision AS distance_meters,
    COALESCE(dp.updated_at, d.updated_at, d.created_at) AS updated_at
  FROM public.drivers d
  LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
  WHERE d.is_online = true
    AND d.approval_status = 'approved'
    AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
    AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
    AND NOT (
      COALESCE(dp.lat, d.current_lat) = 0
      AND COALESCE(dp.lng, d.current_lng) = 0
    )
    AND (
      dp.driver_id IS NULL
      OR COALESCE(dp.last_heartbeat_at, dp.updated_at, d.updated_at) >
          now() - make_interval(secs => p_stale_seconds)
    )
    AND NOT public.driver_location_is_frozen(d.id)
    AND public.haversine_meters(
      p_lat, p_lng,
      COALESCE(dp.lat, d.current_lat)::double precision,
      COALESCE(dp.lng, d.current_lng)::double precision
    ) <= p_radius_meters
  ORDER BY distance_meters ASC
  LIMIT LEAST(COALESCE(p_limit, 40), 80);
$function$;

COMMENT ON FUNCTION public.find_nearby_drivers(double precision, double precision, double precision, integer, integer) IS
  'Customer map + Admin passenger_map_nearby_drivers. driver_location_is_frozen() exclusion added in migration 20260910120000 - a frozen driver disappears from the map instead of showing a fake live position.';

-- ----------------------------------------------------------------------------
-- 8. Admin Live Fleet - one authoritative status view.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.admin_driver_fleet_status
WITH (security_invoker = true) AS
SELECT
  d.id AS driver_id,
  d.first_name,
  d.last_name,
  d.driver_code,
  d.is_online,
  d.driver_online_intent,
  d.current_trip_id,
  d.approval_status,
  d.driver_status,
  COALESCE(dp.lat, d.current_lat) AS lat,
  COALESCE(dp.lng, d.current_lng) AS lng,
  COALESCE(dp.heading, d.heading) AS heading,
  COALESCE(dp.speed, d.speed) AS speed,
  dp.last_heartbeat_at,
  COALESCE(dp.last_location_at, d.last_location_updated_at) AS last_location_at,
  COALESCE(dp.last_gps_sample_at, d.last_gps_sample_at) AS last_gps_sample_at,
  COALESCE(dp.last_coordinate_change_at, d.last_coordinate_change_at) AS last_coordinate_change_at,
  COALESCE(dp.location_source, d.location_source) AS location_source,
  dp.presence_health,
  dp.app_state,
  dp.platform,
  public.driver_location_state(
    d.driver_online_intent,
    dp.last_heartbeat_at,
    COALESCE(dp.last_gps_sample_at, d.last_gps_sample_at),
    COALESCE(dp.speed, d.speed)
  ) AS location_state,
  EXTRACT(epoch FROM now() - dp.last_heartbeat_at)::integer AS heartbeat_age_seconds,
  EXTRACT(epoch FROM now() - COALESCE(dp.last_gps_sample_at, d.last_gps_sample_at))::integer AS gps_sample_age_seconds,
  EXTRACT(epoch FROM now() - COALESCE(dp.last_coordinate_change_at, d.last_coordinate_change_at))::integer AS coordinate_change_age_seconds
FROM public.drivers d
LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
WHERE d.deleted_at IS NULL;

COMMENT ON VIEW public.admin_driver_fleet_status IS
  'Single authoritative status source for Admin Live Fleet (Dashboard.tsx, FleetTracking.tsx). location_state is one of location_live | location_stationary | location_frozen | location_stale | location_unavailable - see driver_location_state(). security_invoker=true: respects the querying admin''s own RLS on drivers/driver_presence.';

GRANT SELECT ON public.admin_driver_fleet_status TO authenticated;

-- ----------------------------------------------------------------------------
-- 9. Third dispatch_trip_offers overload — (uuid, text). This is the
--    wave-cascade/scoring dispatcher actually used by:
--      - schedule-dispatch/index.ts (scheduled lead-time dispatch)
--      - maybe_advance_dispatch_after_offer_resolution() (REMATCH: advancing
--        to the next wave/driver after a decline, timeout, or expiry)
--    It also evaluates Towards-Destination/stacked candidates in the same
--    query (is_idle = false branch). Neither path is touched by the
--    dispatch_trip_offers(uuid)/(uuid,boolean) overloads above — this was a
--    real gap: scheduled dispatch and rematch could still offer a trip to a
--    driver whose GPS pipeline had stalled (frozen), using only the same
--    heartbeat-only staleness check that caused the original P0 bug.
--    Fix: adds last_gps_sample_at/speed to the candidate query and an
--    `is_frozen` column (driver_location_state(...) = 'location_frozen'),
--    surfaced as reject_reason='location_frozen' (visible in
--    dispatch_eligibility_log, same as the other overloads). Everything else
--    in this function is unchanged from the currently-applied definition in
--    20260524222813_c3b44441-aaf9-4ea8-a664-7b26ae774540.sql.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(
  p_trip_id uuid,
  p_trigger_reason text DEFAULT 'auto'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip            public.trips%ROWTYPE;
  v_g               public.global_dispatch_settings%ROWTYPE;
  v_now             timestamptz := now();
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
  v_prev_round      integer;
  v_locked_driver   record;
  v_offer_ids       uuid[] := ARRAY[]::uuid[];
  v_selected_ids    uuid[] := ARRAY[]::uuid[];
  v_skipped_ids     uuid[] := ARRAY[]::uuid[];
  v_status          text := 'ok';
  v_reason          text := NULL;
  v_expires_at      timestamptz;
  v_new_trip_distance_m numeric;
  v_new_bearing     double precision;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', NULL,
      'round', NULL, 'status', 'trip_not_found',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'trip_not_found'
    );
  END IF;

  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'global_dispatch_settings singleton missing';
  END IF;

  v_max_rounds       := COALESCE(v_g.max_dispatch_rounds, 3);
  v_presence_max_age := COALESCE(v_g.presence_max_age_seconds, 60);
  v_prev_round       := COALESCE(v_trip.current_broadcast_round, 0);

  BEGIN
    INSERT INTO public.dispatch_round_advance_log(trip_id, previous_round, trigger_reason)
    VALUES (p_trip_id, v_prev_round, COALESCE(p_trigger_reason, 'auto'));
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
      'round', v_prev_round, 'status', 'duplicate_trigger',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'round already advanced for previous_round=' || v_prev_round
    );
  END;

  -- ============ SCAN & GO / LOCKED DRIVER (unchanged) ============
  IF v_trip.scan_go = true OR COALESCE(v_trip.broadcast_enabled, true) = false THEN
    IF v_trip.locked_driver_id IS NULL THEN
      RAISE EXCEPTION 'Scan & Go trip % missing locked_driver_id', p_trip_id;
    END IF;

    IF EXISTS (SELECT 1 FROM public.ride_offers ro WHERE ro.trip_id = p_trip_id) THEN
      RETURN jsonb_build_object(
        'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
        'round', 1, 'status', 'already_offered',
        'offers_created', 0, 'offer_ids', '[]'::jsonb,
        'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
        'candidate_count', 0, 'eligible_count', 0,
        'wave_cap', NULL, 'search_radius_meters', NULL,
        'reason', 'already_offered'
      );
    END IF;

    IF v_trip.locked_driver_id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])) THEN
      UPDATE public.trips
        SET status='expired', dispatch_status='expired', updated_at=v_now
        WHERE id=p_trip_id AND status NOT IN ('completed','cancelled','expired');
      RETURN jsonb_build_object(
        'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
        'round', 1, 'status', 'expired',
        'offers_created', 0, 'offer_ids', '[]'::jsonb,
        'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
        'candidate_count', 0, 'eligible_count', 0,
        'wave_cap', NULL, 'search_radius_meters', NULL,
        'reason', 'locked_driver_in_cancelled_list'
      );
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
        SET status='expired', dispatch_status='expired',
            cancel_reason='scan_go_driver_unavailable', updated_at=v_now
        WHERE id=p_trip_id AND status NOT IN ('completed','cancelled','expired');
      RETURN jsonb_build_object(
        'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
        'round', 1, 'status', 'expired',
        'offers_created', 0, 'offer_ids', '[]'::jsonb,
        'selected_driver_ids', '[]'::jsonb,
        'skipped_driver_ids', to_jsonb(ARRAY[v_trip.locked_driver_id]),
        'candidate_count', 1, 'eligible_count', 0,
        'wave_cap', NULL, 'search_radius_meters', NULL,
        'reason', 'scan_go_driver_unavailable'
      );
    END IF;

    v_expires_at := v_now + make_interval(secs => COALESCE(v_g.locked_driver_response_minutes, 2) * 60);

    WITH ins AS (
      INSERT INTO public.ride_offers (
        trip_id, driver_id, status, expires_at, distance_meters, broadcast_round, offered_at,
        is_urgent_dispatch, delivery_phase, offer_snapshot
      ) VALUES (
        p_trip_id, v_trip.locked_driver_id, 'pending', v_expires_at,
        round(public.haversine_meters(
          v_trip.pickup_latitude, v_trip.pickup_longitude,
          v_locked_driver.lat, v_locked_driver.lng))::int,
        1, v_now, true, 'scan_and_go',
        jsonb_build_object('scan_and_go', true, 'locked_driver', true, 'trigger_reason', p_trigger_reason)
      ) RETURNING id
    )
    SELECT array_agg(id) INTO v_offer_ids FROM ins;

    UPDATE public.trips
      SET status='offered', dispatch_status='locked_driver_offered',
          dispatch_mode='locked_driver', broadcast_enabled=false,
          current_offer_driver_id=v_trip.locked_driver_id,
          negotiation_owner_driver_id=v_trip.locked_driver_id,
          current_broadcast_round=1,
          broadcast_started_at=COALESCE(v_trip.broadcast_started_at, v_now),
          last_broadcast_at=v_now, updated_at=v_now
      WHERE id=p_trip_id;

    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
      'round', 1, 'status', 'dispatched_locked_driver',
      'offers_created', COALESCE(array_length(v_offer_ids,1),0),
      'offer_ids', to_jsonb(v_offer_ids),
      'selected_driver_ids', to_jsonb(ARRAY[v_trip.locked_driver_id]),
      'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 1, 'eligible_count', 1,
      'wave_cap', 1, 'search_radius_meters', NULL,
      'reason', NULL
    );
  END IF;

  -- ============ GUARDS ============
  IF v_trip.negotiation_owner_driver_id IS NOT NULL OR v_trip.status = 'negotiating' THEN
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_prev_round,
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
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_prev_round,
      'status','skipped','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',NULL,'search_radius_meters',NULL,
      'reason','active_offers_outstanding');
  END IF;

  v_round      := v_prev_round + 1;
  v_max_radius := v_g.max_radius_meters;

  CASE
    WHEN v_round = 1 THEN
      v_wave_cap := v_g.wave1_size; v_radius := v_g.start_radius_meters;  v_expiry_secs := v_g.wave1_offer_expiry_seconds;
    WHEN v_round = 2 THEN
      v_wave_cap := v_g.wave2_size; v_radius := v_g.expand_radius_meters; v_expiry_secs := v_g.wave2_offer_expiry_seconds;
    ELSE
      v_wave_cap := v_g.wave3_size; v_radius := v_g.max_radius_meters;    v_expiry_secs := v_g.wave3_offer_expiry_seconds;
  END CASE;

  IF v_radius IS NULL OR v_wave_cap IS NULL OR v_expiry_secs IS NULL THEN
    RAISE EXCEPTION 'global_dispatch_settings missing wave configuration for round %', v_round;
  END IF;

  v_radius := LEAST(v_radius, COALESCE(v_max_radius, v_radius));

  IF v_round > v_max_rounds THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_round,
      'status','exhausted','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',v_wave_cap,'search_radius_meters',v_radius,
      'reason','max_rounds_reached');
  END IF;

  v_expires_at := v_now + make_interval(secs => v_expiry_secs);

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
      AND d.is_online = true AND COALESCE(d.driver_online_intent, false) = true
      AND NOT public.is_explicit_offline_reason(dp.offline_reason)
      AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
      AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
      AND NOT (COALESCE(dp.lat, d.current_lat) = 0 AND COALESCE(dp.lng, d.current_lng) = 0)
      AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
      AND NOT (d.id = ANY (COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[])))
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id AND ro.driver_id = d.id
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
  SELECT b.*,
    public.haversine_meters(v_trip.pickup_latitude, v_trip.pickup_longitude, b.lat, b.lng) AS distance_m,
    COALESCE(ac.active_count, 0) AS active_count,
    (b.push_token IS NOT NULL AND b.push_token <> '') AS has_push,
    (COALESCE(b.socket_connected, false) = true) AS has_realtime,
    (b.last_heartbeat_at IS NOT NULL
      AND b.last_heartbeat_at > v_now - make_interval(secs => v_presence_max_age)) AS healthy_heartbeat,
    (COALESCE(b.presence_health, 'healthy') = 'degraded') AS is_degraded,
    -- P0 fix (migration 20260910120000): heartbeat fresh but no genuine
    -- GPS sample within the freshness window. Same derivation as
    -- driver_location_is_frozen() used by the other dispatch_trip_offers
    -- overload, find_nearby_drivers(), and auto-dispatch. This overload is
    -- used by schedule-dispatch (scheduled lead-time) and
    -- maybe_advance_dispatch_after_offer_resolution (rematch after a
    -- decline/expiry) — both were previously ungated on frozen location.
    public.driver_location_state(true, b.last_heartbeat_at, b.last_gps_sample_at, b.presence_speed) = 'location_frozen' AS is_frozen,
    (v_trip.service_area_id IS NULL OR b.service_area_id = v_trip.service_area_id) AS sa_match,
    (v_trip.region_id IS NULL OR b.region_id = v_trip.region_id) AS region_match,
    (b.current_trip_id IS NULL) AS is_idle
  FROM base b LEFT JOIN active_counts ac ON ac.driver_id = b.driver_id;

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
        AND q.active_count < COALESCE(v_g.max_stacked_rides, 1)
      ) AS stack_pre_ok,
      CASE
        WHEN q.is_idle THEN NULL
        WHEN COALESCE(v_g.stacked_rides_enabled, false) = false THEN 'stacked_disabled'
        WHEN q.active_count >= COALESCE(v_g.max_stacked_rides, 1) THEN 'stacked_cap_reached'
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
    jsonb_build_object('wave',v_round,'trigger_reason',p_trigger_reason,
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
      broadcast_round, offered_at, is_stacked, offer_snapshot
    )
    SELECT p_trip_id, p.driver_id, 'pending', v_expires_at, round(p.distance_m)::int,
      v_round, v_now, p.stack_ok,
      jsonb_build_object('wave',v_round,'score',p.score,'trigger_reason',p_trigger_reason,
                         'degraded',p.is_degraded,'stacked',p.stack_ok)
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
           'distance_m', ro.distance_meters, 'is_stacked', ro.is_stacked)), '[]'::jsonb)
    INTO v_selected_json
   FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id AND ro.broadcast_round = v_round;

  IF v_inserted = 0 THEN
    UPDATE public.trips
      SET current_broadcast_round=v_round, last_broadcast_at=v_now, updated_at=v_now
      WHERE id=p_trip_id;
    v_status := 'no_drivers';
    v_reason := 'no_eligible_drivers';
  ELSE
    UPDATE public.trips
      SET status='offered', dispatch_status='broadcasting',
          current_broadcast_round=v_round,
          broadcast_started_at=COALESCE(v_trip.broadcast_started_at, v_now),
          last_broadcast_at=v_now, updated_at=v_now
      WHERE id=p_trip_id;
    v_status := 'dispatched';
  END IF;

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

  IF v_inserted = 0 THEN
    PERFORM public.maybe_advance_dispatch_after_offer_resolution(p_trip_id, NULL, 'no_eligible_drivers');
  END IF;

  RETURN jsonb_build_object(
    'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
    'round', v_round, 'status', v_status,
    'offers_created', v_inserted,
    'offer_ids', to_jsonb(v_offer_ids),
    'selected_driver_ids', to_jsonb(v_selected_ids),
    'skipped_driver_ids', to_jsonb(v_skipped_ids),
    'candidate_count', v_candidate_count,
    'eligible_count', v_eligible_count,
    'wave_cap', v_wave_cap,
    'search_radius_meters', v_radius,
    'reason', v_reason
  );
END;
$function$;

COMMENT ON FUNCTION public.dispatch_trip_offers(uuid, text) IS
  'Wave-cascade/scoring dispatcher used by schedule-dispatch (scheduled lead-time) and maybe_advance_dispatch_after_offer_resolution (rematch after decline/timeout/expiry) - also evaluates Towards-Destination/stacked candidates. driver_location_state() frozen exclusion (reject_reason=location_frozen) added in migration 20260910120000.';

