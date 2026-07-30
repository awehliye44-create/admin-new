-- Driver availability SSOT:
-- - authenticated session ≠ account eligibility ≠ compliance ≠ online intent ≠ effective availability ≠ trip state ≠ presence freshness
-- - Atomic driver_request_go_online / driver_request_go_offline set/clear intent
-- - Cron may degrade effective availability but must NEVER clear driver_online_intent
-- - Admin disable / document expiry keep intent; block go-online + dispatch + accept

BEGIN;

-- ---------------------------------------------------------------------------
-- Audit events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_availability_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  actor_user_id uuid NULL,
  actor_role text NOT NULL DEFAULT 'system',
  event_type text NOT NULL,
  reason text NULL,
  from_intent boolean NULL,
  to_intent boolean NULL,
  from_is_online boolean NULL,
  to_is_online boolean NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_availability_events_driver_created
  ON public.driver_availability_events (driver_id, created_at DESC);

ALTER TABLE public.driver_availability_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read driver availability events" ON public.driver_availability_events;
CREATE POLICY "Admins read driver availability events"
  ON public.driver_availability_events
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Drivers read own availability events" ON public.driver_availability_events;
CREATE POLICY "Drivers read own availability events"
  ON public.driver_availability_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.id = driver_id AND d.user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.log_driver_availability_event(
  p_driver_id uuid,
  p_event_type text,
  p_reason text DEFAULT NULL,
  p_from_intent boolean DEFAULT NULL,
  p_to_intent boolean DEFAULT NULL,
  p_from_is_online boolean DEFAULT NULL,
  p_to_is_online boolean DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_actor_role text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.driver_availability_events (
    driver_id,
    actor_user_id,
    actor_role,
    event_type,
    reason,
    from_intent,
    to_intent,
    from_is_online,
    to_is_online,
    metadata
  ) VALUES (
    p_driver_id,
    auth.uid(),
    COALESCE(
      NULLIF(trim(p_actor_role), ''),
      CASE
        WHEN auth.role() = 'service_role' THEN 'service_role'
        WHEN auth.uid() IS NULL THEN 'system'
        ELSE 'driver'
      END
    ),
    p_event_type,
    public.normalize_driver_offline_reason(p_reason),
    p_from_intent,
    p_to_intent,
    p_from_is_online,
    p_to_is_online,
    COALESCE(p_metadata, '{}'::jsonb)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Guard: clients cannot directly mutate availability columns
-- SECURITY DEFINER writers set local flag before UPDATE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.allow_driver_availability_write()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM set_config('app.allow_driver_availability_write', 'on', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_guard_driver_availability_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.driver_online_intent IS DISTINCT FROM OLD.driver_online_intent
     OR NEW.is_online IS DISTINCT FROM OLD.is_online
     OR NEW.online_since IS DISTINCT FROM OLD.online_since
  THEN
    IF COALESCE(current_setting('app.allow_driver_availability_write', true), '') <> 'on' THEN
      RAISE EXCEPTION 'DIRECT_AVAILABILITY_WRITE_FORBIDDEN: use driver_request_go_online / driver_request_go_offline'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_guard_driver_availability_columns ON public.drivers;
CREATE TRIGGER tr_guard_driver_availability_columns
  BEFORE UPDATE OF driver_online_intent, is_online, online_since
  ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_guard_driver_availability_columns();

-- ---------------------------------------------------------------------------
-- Eligibility assert: live enum is active|disabled|deleted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_driver_presence_online_eligible(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_doc jsonb;
  v_has_vehicle boolean;
BEGIN
  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_NOT_FOUND',
      'message', 'Driver profile not found.'
    );
  END IF;

  IF lower(COALESCE(v_driver.approval_status, '')) <> 'approved' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_NOT_APPROVED',
      'message', 'Driver is not approved.'
    );
  END IF;

  IF lower(COALESCE(v_driver.driver_status::text, '')) <> 'active' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_ACCOUNT_DISABLED',
      'message', 'Driver account is disabled.'
    );
  END IF;

  IF COALESCE(v_driver.phone_verified, false) <> true THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'PHONE_UNVERIFIED',
      'message', 'Phone verification required before going online.'
    );
  END IF;

  IF v_driver.service_area_id IS NULL THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_SERVICE_AREA_NOT_ASSIGNED',
      'message', 'Assign a service area before going online.'
    );
  END IF;

  IF COALESCE(v_driver.vehicle_edit_request_status, '') = 'pending' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'VEHICLE_CHANGE_PENDING',
      'message', 'Vehicle change request is pending admin approval.'
    );
  END IF;

  v_doc := public.get_driver_document_eligibility(p_driver_id);
  IF COALESCE((v_doc ->> 'approved')::boolean, false) <> true THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', COALESCE(v_doc ->> 'code', 'DOCUMENTS_NOT_APPROVED'),
      'message', COALESCE(v_doc ->> 'message', 'Documents must be approved before going online.')
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.vehicles v
    WHERE v.driver_id = p_driver_id
      AND COALESCE(v.is_primary, false) = true
      AND lower(COALESCE(v.approval_status, '')) = 'approved'
  ) INTO v_has_vehicle;

  IF NOT v_has_vehicle THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'VEHICLE_NOT_APPROVED',
      'message', 'An approved primary vehicle is required before going online.'
    );
  END IF;

  RETURN jsonb_build_object('eligible', true, 'code', 'OK', 'message', '');
END;
$$;

-- ---------------------------------------------------------------------------
-- Resolve driver id from auth.uid()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.require_authenticated_driver_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
    AND d.deleted_at IS NULL
  ORDER BY d.created_at DESC NULLS LAST
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'DRIVER_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_driver_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Atomic go online — sets intent=true
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_request_go_online(
  p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL,
  p_heading double precision DEFAULT NULL,
  p_speed double precision DEFAULT NULL,
  p_accuracy double precision DEFAULT NULL,
  p_app_state text DEFAULT 'foreground',
  p_platform text DEFAULT NULL,
  p_network_type text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id uuid;
  v_driver public.drivers%ROWTYPE;
  v_eligibility jsonb;
  v_from_intent boolean;
  v_from_online boolean;
BEGIN
  v_driver_id := public.require_authenticated_driver_id();

  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = v_driver_id
  FOR UPDATE;

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
        ELSE now()
      END,
      current_lat = COALESCE(p_lat, current_lat),
      current_lng = COALESCE(p_lng, current_lng),
      heading = COALESCE(p_heading, heading),
      speed = COALESCE(p_speed, speed),
      last_location_updated_at = CASE WHEN p_lat IS NOT NULL THEN now() ELSE last_location_updated_at END,
      last_seen_at = now(),
      updated_at = now()
  WHERE id = v_driver_id;

  INSERT INTO public.driver_presence (
    driver_id,
    status,
    presence_health,
    last_heartbeat_at,
    lat,
    lng,
    heading,
    speed,
    last_location_at,
    app_state,
    platform,
    network_type,
    offline_reason,
    last_offline_at,
    updated_at
  ) VALUES (
    v_driver_id,
    'online',
    'healthy',
    now(),
    p_lat,
    p_lng,
    p_heading,
    p_speed,
    CASE WHEN p_lat IS NOT NULL THEN now() ELSE NULL END,
    COALESCE(NULLIF(trim(p_app_state), ''), 'foreground'),
    p_platform,
    NULLIF(trim(COALESCE(p_network_type, '')), ''),
    NULL,
    NULL,
    now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = 'online',
    presence_health = 'healthy',
    last_heartbeat_at = now(),
    lat = COALESCE(EXCLUDED.lat, public.driver_presence.lat),
    lng = COALESCE(EXCLUDED.lng, public.driver_presence.lng),
    heading = COALESCE(EXCLUDED.heading, public.driver_presence.heading),
    speed = COALESCE(EXCLUDED.speed, public.driver_presence.speed),
    last_location_at = CASE
      WHEN EXCLUDED.lat IS NOT NULL THEN now()
      ELSE public.driver_presence.last_location_at
    END,
    app_state = COALESCE(EXCLUDED.app_state, public.driver_presence.app_state),
    platform = COALESCE(EXCLUDED.platform, public.driver_presence.platform),
    network_type = COALESCE(EXCLUDED.network_type, public.driver_presence.network_type),
    offline_reason = NULL,
    updated_at = now();

  PERFORM public.log_driver_availability_event(
    v_driver_id,
    'go_online',
    'driver_request_go_online',
    v_from_intent,
    true,
    v_from_online,
    true,
    jsonb_build_object('source', 'driver_request_go_online')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'message', '',
    'driver_id', v_driver_id,
    'driver_online_intent', true,
    'is_online', true,
    'status', 'online'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Atomic go offline — clears intent=false
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_request_go_offline(
  p_reason text DEFAULT 'manual_go_offline'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id uuid;
  v_driver public.drivers%ROWTYPE;
  v_reason text;
  v_from_intent boolean;
  v_from_online boolean;
BEGIN
  v_driver_id := public.require_authenticated_driver_id();
  v_reason := COALESCE(
    public.normalize_driver_offline_reason(p_reason),
    'manual_go_offline'
  );

  IF NOT public.is_explicit_offline_reason(v_reason)
     AND v_reason NOT IN ('manual_go_offline', 'logout', 'session_signed_out') THEN
    v_reason := 'manual_go_offline';
  END IF;

  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = v_driver_id
  FOR UPDATE;

  v_from_intent := COALESCE(v_driver.driver_online_intent, false);
  v_from_online := COALESCE(v_driver.is_online, false);

  -- Active trip: allow offline intent clear for explicit driver action, but
  -- never clear current_trip_id here (trip continues).
  PERFORM public.allow_driver_availability_write();

  UPDATE public.drivers
  SET driver_online_intent = false,
      is_online = false,
      online_since = NULL,
      last_seen_at = now(),
      updated_at = now()
  WHERE id = v_driver_id;

  INSERT INTO public.driver_presence (
    driver_id,
    status,
    presence_health,
    offline_reason,
    last_offline_at,
    last_heartbeat_at,
    updated_at
  ) VALUES (
    v_driver_id,
    'offline',
    'offline',
    v_reason,
    now(),
    now(),
    now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = 'offline',
    presence_health = 'offline',
    offline_reason = EXCLUDED.offline_reason,
    last_offline_at = now(),
    updated_at = now();

  PERFORM public.log_driver_availability_event(
    v_driver_id,
    'go_offline',
    v_reason,
    v_from_intent,
    false,
    v_from_online,
    false,
    jsonb_build_object('source', 'driver_request_go_offline')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'message', '',
    'driver_id', v_driver_id,
    'driver_online_intent', false,
    'is_online', false,
    'status', 'offline',
    'reason', v_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.driver_request_go_online(
  double precision, double precision, double precision, double precision,
  double precision, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_request_go_online(
  double precision, double precision, double precision, double precision,
  double precision, text, text, text
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.driver_request_go_offline(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_request_go_offline(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Upsert presence: heartbeat / location only — NEVER set/clear intent.
-- Explicit online/offline transitions must use driver_request_* RPCs.
-- ---------------------------------------------------------------------------
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
  p_offline_reason text DEFAULT NULL::text
)
RETURNS driver_presence
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result public.driver_presence;
  v_driver public.drivers%ROWTYPE;
  v_prev_hb timestamptz;
  v_gap_s integer;
  v_low_accuracy boolean;
  v_active_device text;
  v_effective_online boolean;
  v_eligible jsonb;
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

  SELECT dp.last_heartbeat_at INTO v_prev_hb
  FROM public.driver_presence dp
  WHERE dp.driver_id = p_driver_id;

  IF v_prev_hb IS NOT NULL THEN
    v_gap_s := GREATEST(0, floor(extract(epoch FROM (now() - v_prev_hb)))::integer);
    IF v_gap_s < 2 AND COALESCE(p_status, '') <> 'offline' THEN
      SELECT * INTO v_result FROM public.driver_presence WHERE driver_id = p_driver_id;
      IF FOUND THEN
        RETURN v_result;
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

  INSERT INTO public.driver_presence (
    driver_id, status, last_heartbeat_at,
    lat, lng, heading, speed, last_location_at,
    app_state, platform, push_token,
    accuracy_m, battery_level, low_accuracy,
    socket_connected, unresolved_critical_tracking,
    last_socket_pong_at, network_type, updated_at
  ) VALUES (
    p_driver_id,
    COALESCE(p_status, CASE WHEN COALESCE(v_driver.driver_online_intent, false) THEN 'online' ELSE 'offline' END),
    now(),
    p_lat, p_lng, p_heading, p_speed,
    CASE WHEN p_lat IS NOT NULL THEN now() ELSE NULL END,
    COALESCE(p_app_state, 'foreground'),
    p_platform,
    p_push_token,
    p_accuracy, p_battery_level, v_low_accuracy,
    p_socket_connected,
    COALESCE(p_unresolved_critical_tracking, false),
    CASE WHEN COALESCE(p_socket_connected, false) THEN now() ELSE NULL END,
    NULLIF(trim(COALESCE(p_network_type, '')), ''),
    now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = CASE
      WHEN p_status IS NOT NULL THEN p_status
      WHEN COALESCE(v_driver.driver_online_intent, false) THEN COALESCE(public.driver_presence.status, 'online')
      ELSE public.driver_presence.status
    END,
    last_heartbeat_at = now(),
    lat = COALESCE(p_lat, public.driver_presence.lat),
    lng = COALESCE(p_lng, public.driver_presence.lng),
    heading = COALESCE(p_heading, public.driver_presence.heading),
    speed = COALESCE(p_speed, public.driver_presence.speed),
    last_location_at = CASE WHEN p_lat IS NOT NULL THEN now() ELSE public.driver_presence.last_location_at END,
    app_state = COALESCE(p_app_state, public.driver_presence.app_state),
    platform = COALESCE(p_platform, public.driver_presence.platform),
    push_token = COALESCE(p_push_token, public.driver_presence.push_token),
    accuracy_m = COALESCE(p_accuracy, public.driver_presence.accuracy_m),
    battery_level = COALESCE(p_battery_level, public.driver_presence.battery_level),
    low_accuracy = CASE WHEN p_accuracy IS NOT NULL THEN v_low_accuracy ELSE public.driver_presence.low_accuracy END,
    socket_connected = COALESCE(p_socket_connected, public.driver_presence.socket_connected),
    unresolved_critical_tracking = COALESCE(p_unresolved_critical_tracking, public.driver_presence.unresolved_critical_tracking),
    last_socket_pong_at = CASE
      WHEN COALESCE(p_socket_connected, false) THEN now()
      ELSE public.driver_presence.last_socket_pong_at
    END,
    network_type = CASE
      WHEN p_network_type IS NOT NULL AND trim(p_network_type) <> '' THEN trim(p_network_type)
      ELSE public.driver_presence.network_type
    END,
    updated_at = now()
  RETURNING * INTO v_result;

  -- Effective availability: intent + eligibility + presence status. Never touch intent here.
  v_eligible := public.assert_driver_presence_online_eligible(p_driver_id);
  v_effective_online :=
    COALESCE(v_driver.driver_online_intent, false)
    AND COALESCE((v_eligible ->> 'eligible')::boolean, false)
    AND v_result.status IN ('online', 'on_trip', 'paused');

  PERFORM public.allow_driver_availability_write();
  UPDATE public.drivers SET
    is_online = v_effective_online,
    current_lat = COALESCE(p_lat, current_lat),
    current_lng = COALESCE(p_lng, current_lng),
    heading = COALESCE(p_heading, heading),
    speed = COALESCE(p_speed, speed),
    last_location_updated_at = CASE WHEN p_lat IS NOT NULL THEN now() ELSE last_location_updated_at END,
    last_seen_at = now(),
    updated_at = now()
  WHERE id = p_driver_id;

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Presence → is_online sync: respect intent + eligibility; never clear intent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_driver_online_from_presence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_eligible jsonb;
  v_should_be_online boolean;
BEGIN
  SELECT * INTO v_driver FROM public.drivers WHERE id = NEW.driver_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_eligible := public.assert_driver_presence_online_eligible(NEW.driver_id);
  v_should_be_online :=
    COALESCE(v_driver.driver_online_intent, false)
    AND COALESCE((v_eligible ->> 'eligible')::boolean, false)
    AND NEW.status IN ('online', 'on_trip', 'paused');

  IF v_driver.is_online IS DISTINCT FROM v_should_be_online THEN
    PERFORM public.allow_driver_availability_write();
    UPDATE public.drivers
    SET is_online = v_should_be_online,
        updated_at = now()
    WHERE id = NEW.driver_id;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cron: derive effective availability; NEVER clear driver_online_intent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_stale_drivers(p_ttl_seconds integer DEFAULT 60)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_repaired integer := 0;
  v_degraded integer := 0;
  v_offline integer := 0;
  v_unavailable integer := 0;
  v_ineligible integer := 0;
  v_ttl_s integer := GREATEST(p_ttl_seconds, 45);
  v_ghost_ttl_s integer := GREATEST(p_ttl_seconds * 5, 300);
BEGIN
  PERFORM public.allow_driver_availability_write();

  -- 1) REPAIR: intent=true + eligible + fresh HB → presence healthy/online
  UPDATE public.driver_presence dp
  SET status = 'online',
      presence_health = 'healthy',
      offline_reason = CASE
        WHEN public.is_explicit_offline_reason(dp.offline_reason) THEN dp.offline_reason
        ELSE NULL
      END,
      updated_at = now()
  FROM public.drivers d
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND COALESCE((public.assert_driver_presence_online_eligible(d.id) ->> 'eligible')::boolean, false) = true
    AND NOT public.is_explicit_offline_reason(dp.offline_reason)
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at > now() - make_interval(secs => v_ttl_s)
    AND (
      dp.status IS DISTINCT FROM 'online'
      OR (dp.offline_reason IS NOT NULL AND NOT public.is_explicit_offline_reason(dp.offline_reason))
      OR dp.presence_health IS DISTINCT FROM 'healthy'
    );
  GET DIAGNOSTICS v_repaired = ROW_COUNT;

  -- 2) DEGRADED: intent=true, HB stale but not ghost
  UPDATE public.driver_presence dp
  SET presence_health = 'degraded',
      updated_at = now()
  FROM public.drivers d
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at <= now() - make_interval(secs => v_ttl_s)
    AND dp.last_heartbeat_at > now() - make_interval(secs => v_ghost_ttl_s)
    AND dp.presence_health IS DISTINCT FROM 'degraded';
  GET DIAGNOSTICS v_degraded = ROW_COUNT;

  -- 3) GHOST: stale HB → effective is_online=false, KEEP intent
  UPDATE public.drivers d
  SET is_online = false,
      updated_at = now()
  FROM public.driver_presence dp
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at <= now() - make_interval(secs => v_ghost_ttl_s)
    AND d.is_online IS DISTINCT FROM false;
  GET DIAGNOSTICS v_unavailable = ROW_COUNT;

  -- 4) Intent=true but account/compliance ineligible → effective offline, KEEP intent
  UPDATE public.drivers d
  SET is_online = false,
      updated_at = now()
  WHERE COALESCE(d.driver_online_intent, false) = true
    AND COALESCE((public.assert_driver_presence_online_eligible(d.id) ->> 'eligible')::boolean, false) = false
    AND d.is_online IS DISTINCT FROM false;
  GET DIAGNOSTICS v_ineligible = ROW_COUNT;

  -- Mark presence health for ineligible-with-intent (not explicit offline)
  UPDATE public.driver_presence dp
  SET presence_health = 'degraded',
      updated_at = now()
  FROM public.drivers d
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND COALESCE((public.assert_driver_presence_online_eligible(d.id) ->> 'eligible')::boolean, false) = false
    AND NOT public.is_explicit_offline_reason(dp.offline_reason)
    AND dp.presence_health IS DISTINCT FROM 'degraded'
    AND dp.presence_health IS DISTINCT FROM 'offline';

  -- 5) Explicit offline intent=false → presence offline + is_online false
  UPDATE public.driver_presence dp
  SET status = 'offline',
      presence_health = 'offline',
      offline_reason = COALESCE(NULLIF(trim(dp.offline_reason), ''), 'manual_go_offline'),
      last_offline_at = COALESCE(dp.last_offline_at, now()),
      updated_at = now()
  FROM public.drivers d
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = false
    AND (
      dp.status IS DISTINCT FROM 'offline'
      OR dp.presence_health IS DISTINCT FROM 'offline'
    );
  GET DIAGNOSTICS v_offline = ROW_COUNT;

  UPDATE public.drivers d
  SET is_online = false,
      updated_at = now()
  WHERE COALESCE(d.driver_online_intent, false) = false
    AND d.is_online IS DISTINCT FROM false;

  IF v_repaired > 0 OR v_degraded > 0 OR v_offline > 0 OR v_unavailable > 0 OR v_ineligible > 0 THEN
    RAISE LOG '[expire_stale_drivers] repaired=% degraded=% ghost=% offline=% ineligible=% ttl_s=%',
      v_repaired, v_degraded, v_unavailable, v_offline, v_ineligible, v_ttl_s;
  END IF;

  RETURN v_offline + v_unavailable + v_ineligible;
END;
$$;

-- ---------------------------------------------------------------------------
-- Admin disable: force effective offline without clearing intent / trip
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tr_driver_status_enforce()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.driver_status IS DISTINCT FROM 'active' AND OLD.driver_status = 'active' THEN
    PERFORM public.allow_driver_availability_write();
    NEW.is_online := false;
    -- Preserve driver_online_intent per approved policy.
  END IF;

  IF NEW.driver_status = 'deleted' AND OLD.driver_status IS DISTINCT FROM 'deleted' THEN
    NEW.deleted_at := now();
  END IF;

  IF NEW.driver_status IS DISTINCT FROM 'deleted' AND OLD.driver_status = 'deleted' THEN
    NEW.deleted_at := NULL;
  END IF;

  IF NEW.driver_status IN ('disabled', 'deleted') AND OLD.driver_status = 'active' THEN
    IF NEW.current_trip_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot disable or delete a driver with an active trip (trip_id: %)', NEW.current_trip_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Document recalc: effective offline only; preserve intent
CREATE OR REPLACE FUNCTION public.recalculate_driver_documents_approved(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_approved boolean;
  v_from_online boolean;
BEGIN
  v_approved := public.check_driver_documents_approved(p_driver_id);

  SELECT COALESCE(is_online, false) INTO v_from_online
  FROM public.drivers
  WHERE id = p_driver_id;

  PERFORM public.allow_driver_availability_write();

  UPDATE public.drivers
  SET documents_approved = v_approved,
      is_online = CASE
        WHEN v_approved THEN is_online
        ELSE false
      END,
      -- Intentionally do NOT clear driver_online_intent
      updated_at = now()
  WHERE id = p_driver_id;

  IF NOT v_approved AND v_from_online THEN
    PERFORM public.log_driver_availability_event(
      p_driver_id,
      'effective_offline_compliance',
      'documents_not_approved',
      NULL,
      NULL,
      v_from_online,
      false,
      jsonb_build_object('source', 'recalculate_driver_documents_approved'),
      'system'
    );
  END IF;

  RETURN v_approved;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_online_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.is_online = true AND (OLD.is_online IS DISTINCT FROM true) THEN
    IF NEW.approval_status != 'approved' OR NEW.documents_approved != true
       OR lower(COALESCE(NEW.driver_status::text, '')) <> 'active' THEN
      PERFORM public.allow_driver_availability_write();
      NEW.is_online := false;
    END IF;
  END IF;

  -- Effective offline only — do not clear driver_online_intent
  IF (NEW.approval_status != 'approved'
      OR NEW.documents_approved != true
      OR lower(COALESCE(NEW.driver_status::text, '')) <> 'active') THEN
    IF NEW.is_online IS DISTINCT FROM false THEN
      PERFORM public.allow_driver_availability_write();
      NEW.is_online := false;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- force_driver_offline: keep clearing intent (logout / security only)
-- Ensure it can bypass the guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.force_driver_offline(p_driver_id uuid, p_reason text DEFAULT 'logout'::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason text := COALESCE(public.normalize_driver_offline_reason(p_reason), 'logout');
  v_driver RECORD;
  v_allowed boolean;
  v_from_intent boolean;
  v_from_online boolean;
BEGIN
  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'p_driver_id is required';
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Driver not found: %', p_driver_id;
  END IF;

  v_allowed := auth.role() = 'service_role'
    OR auth.uid() = v_driver.user_id
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid() AND p.role = 'admin'
    );

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized to force this driver offline';
  END IF;

  v_from_intent := COALESCE(v_driver.driver_online_intent, false);
  v_from_online := COALESCE(v_driver.is_online, false);

  DELETE FROM public.push_tokens
  WHERE driver_id = p_driver_id
    AND app_type = 'driver';

  PERFORM public.allow_driver_availability_write();

  UPDATE public.drivers
  SET is_online = false,
      driver_online_intent = false,
      online_since = NULL,
      updated_at = now()
  WHERE id = p_driver_id;

  INSERT INTO public.driver_presence (
    driver_id, status, presence_health, offline_reason, last_offline_at,
    socket_connected, app_state, updated_at
  ) VALUES (
    p_driver_id, 'offline', 'offline', v_reason, now(), false, 'terminated', now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = 'offline',
    presence_health = 'offline',
    offline_reason = EXCLUDED.offline_reason,
    last_offline_at = EXCLUDED.last_offline_at,
    socket_connected = false,
    push_token = NULL,
    app_state = COALESCE(NULLIF(public.driver_presence.app_state, ''), 'terminated'),
    updated_at = now();

  UPDATE public.ride_offers
  SET status = 'expired',
      updated_at = now()
  WHERE driver_id = p_driver_id
    AND status = 'pending';

  PERFORM public.log_driver_availability_event(
    p_driver_id,
    'force_offline',
    v_reason,
    v_from_intent,
    false,
    v_from_online,
    false,
    jsonb_build_object('source', 'force_driver_offline')
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- accept_ride_offer: block acceptance when account/compliance ineligible
-- (does not clear intent; does not logout)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_ride_offer_eligibility_guard(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_eligibility jsonb;
BEGIN
  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'message', 'Driver not found');
  END IF;

  IF lower(COALESCE(v_driver.driver_status::text, '')) <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_ACCOUNT_DISABLED', 'message', 'Driver account is disabled');
  END IF;

  IF lower(COALESCE(v_driver.approval_status, '')) <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_APPROVED', 'message', 'Driver is not approved');
  END IF;

  IF COALESCE(v_driver.documents_approved, false) <> true THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCUMENTS_NOT_APPROVED', 'message', 'Documents are not approved');
  END IF;

  v_eligibility := public.get_driver_document_eligibility(p_driver_id);
  IF COALESCE((v_eligibility ->> 'approved')::boolean, false) <> true THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', COALESCE(v_eligibility ->> 'code', 'DOCUMENTS_NOT_APPROVED'),
      'message', COALESCE(v_eligibility ->> 'message', 'Documents must be approved')
    );
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'OK');
END;
$$;

-- Patched accept_ride_offer with eligibility guard
CREATE OR REPLACE FUNCTION public.accept_ride_offer(p_offer_id uuid, p_driver_id uuid, p_allow_customer_counter boolean DEFAULT false)
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
  v_gross_pence integer;
  v_discount_pence integer;
  v_booking_net_pence integer;
  v_final_customer_pence integer;
  v_locked_base_pence integer;
  v_fare_finalize jsonb;
  v_preset_key text;
  v_preset_fare_pence integer;
  v_now timestamptz := now();
  v_accept_guard jsonb;
BEGIN
  PERFORM p_allow_customer_counter;
  v_accept_guard := public.accept_ride_offer_eligibility_guard(p_driver_id);
  IF COALESCE((v_accept_guard ->> 'ok')::boolean, false) <> true THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_accept_guard ->> 'code', 'DRIVER_INELIGIBLE'),
      'message', COALESCE(v_accept_guard ->> 'message', 'Driver is not eligible to accept offers')
    );
  END IF;



  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND', 'message', 'Offer not found');
  END IF;

  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_MISMATCH', 'message', 'Offer not yours');
  END IF;

  IF v_offer.status = 'accepted' AND v_offer.negotiation_status = 'confirmed' THEN
    SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id;
    IF v_trip.driver_id = p_driver_id OR v_trip.confirmed_driver_id = p_driver_id THEN
      PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);
      RETURN jsonb_build_object(
        'success', true,
        'trip_id', v_offer.trip_id,
        'status', v_trip.status,
        'driver_id', p_driver_id,
        'final_fare_pence', v_trip.final_fare_pence,
        'final_customer_fare_pence', v_trip.final_customer_fare_pence,
        'fare_source', COALESCE(v_trip.fare_snapshot_json->>'fare_source', 'original_fare'),
        'accepted_via', 'accept_ride_offer',
        'idempotent', true
      );
    END IF;
  END IF;

  IF v_offer.status NOT IN ('pending', 'countered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_PENDING', 'message', 'Offer already ' || COALESCE(v_offer.status, 'handled'));
  END IF;

  IF v_offer.negotiation_status IS DISTINCT FROM 'waiting_customer'
     AND v_offer.negotiation_status IS DISTINCT FROM 'declined_customer_awaiting_driver'
     AND NOT (COALESCE(v_offer.driver_offer_fare, 0) > 0 AND v_offer.status IN ('pending', 'countered'))
     AND NOT (v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') AND COALESCE(v_offer.customer_counter_fare, 0) > 0)
     AND NOT (v_offer.negotiation_status IS NULL AND v_offer.status IN ('pending', 'countered')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_ACCEPTABLE', 'message', 'Offer is not awaiting acceptance');
  END IF;

  IF v_offer.customer_respond_by IS NOT NULL AND v_offer.customer_respond_by < v_now AND v_offer.negotiation_status = 'waiting_customer' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;
  IF v_offer.driver_respond_by IS NOT NULL AND v_offer.driver_respond_by < v_now AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Counter-offer response window expired');
  END IF;
  IF v_offer.negotiation_expires_at IS NOT NULL AND v_offer.negotiation_expires_at < v_now AND v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Standard fare acceptance window expired');
  END IF;
  IF v_offer.expires_at IS NOT NULL AND v_offer.expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;
  IF v_trip.driver_id IS NOT NULL AND v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.confirmed_driver_id IS NOT NULL AND v_trip.confirmed_driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.status NOT IN ('pending','searching','searching_new_driver','offered','broadcasting','offering','negotiating','accepted','confirmed','driver_assigned') THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride not available for assignment');
  END IF;

  v_original_fare_pence := COALESCE(
    NULLIF(v_trip.gross_fare_pence, 0),
    NULLIF(v_trip.base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.estimated_fare, 0) * 100)::integer, 0),
    NULLIF(v_offer.counter_fare, 0),
    0
  );

  IF COALESCE(v_offer.customer_counter_fare, 0) > 0
     AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') THEN
    v_fare_pence := v_offer.customer_counter_fare;
    v_fare_source := 'customer_counter_offer';
  ELSIF COALESCE(v_offer.driver_offer_fare, 0) > 0
     AND v_offer.negotiation_status = 'waiting_customer' THEN
    v_fare_pence := v_offer.driver_offer_fare;
    v_fare_source := 'negotiated_offer';
  ELSIF v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  ELSE
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  END IF;

  IF v_fare_pence <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FARE', 'message', 'Invalid fare');
  END IF;

  v_gross_pence := COALESCE(NULLIF(v_trip.gross_fare_pence, 0), NULLIF(v_original_fare_pence, 0), v_fare_pence);
  v_discount_pence := COALESCE(NULLIF(v_trip.discount_pence, 0), NULLIF(v_trip.offer_discount_pence, 0), 0);
  v_booking_net_pence := COALESCE(NULLIF(v_trip.final_customer_fare_pence, 0), NULLIF(v_trip.final_fare_pence, 0));

  IF v_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN
    v_final_customer_pence := v_fare_pence;
    v_locked_base_pence := v_fare_pence;
    IF v_gross_pence > v_fare_pence THEN
      v_discount_pence := GREATEST(v_discount_pence, v_gross_pence - v_fare_pence);
    END IF;
  ELSIF v_booking_net_pence IS NOT NULL AND v_booking_net_pence > 0 AND v_gross_pence > v_booking_net_pence THEN
    v_final_customer_pence := v_booking_net_pence;
    v_locked_base_pence := v_gross_pence;
  ELSIF v_discount_pence > 0 AND v_gross_pence > v_discount_pence THEN
    v_final_customer_pence := v_gross_pence - v_discount_pence;
    v_locked_base_pence := v_gross_pence;
  ELSE
    v_final_customer_pence := v_fare_pence;
    v_locked_base_pence := COALESCE(NULLIF(v_gross_pence, 0), v_fare_pence);
  END IF;

  -- Preset selection tracking (SSOT completeness)
  v_preset_key := NULLIF(v_offer.offer_snapshot->>'selectedOfferKey', '');
  IF v_preset_key IS NOT NULL THEN
    v_preset_fare_pence := NULLIF((v_offer.offer_snapshot->'selectedOffer'->>'grossFarePence')::integer, 0);
  END IF;

  v_fare_finalize := public.finalize_negotiated_fare(v_offer.trip_id, p_offer_id, v_final_customer_pence, v_fare_source, p_driver_id);

  IF COALESCE(v_fare_finalize->>'success', 'false') <> 'true' THEN
    RETURN jsonb_build_object('success', false, 'error', 'FARE_FINALIZE_FAILED', 'message', COALESCE(v_fare_finalize->>'error', 'Could not finalize fare'));
  END IF;

  UPDATE public.ride_offers
  SET
    status = 'accepted',
    negotiation_status = 'confirmed',
    driver_offer_fare = CASE WHEN v_fare_source IN ('customer_counter_offer', 'negotiated_offer') THEN v_fare_pence ELSE driver_offer_fare END,
    counter_fare = CASE WHEN v_fare_source IN ('customer_counter_offer', 'negotiated_offer') THEN v_fare_pence ELSE counter_fare END,
    responded_at = v_now,
    customer_respond_by = NULL,
    driver_respond_by = NULL,
    grace_window_expires_at = NULL,
    negotiation_expires_at = NULL,
    expires_at = v_now + interval '7 days',
    updated_at = v_now
  WHERE id = p_offer_id;

  UPDATE public.ride_offers
  SET status = 'revoked', revoked_reason = 'another_offer_accepted', negotiation_status = NULL,
      customer_respond_by = NULL, driver_respond_by = NULL, grace_window_expires_at = NULL,
      negotiation_expires_at = NULL, updated_at = v_now
  WHERE trip_id = v_offer.trip_id AND id <> p_offer_id AND status IN ('pending', 'countered');

  UPDATE public.trips
  SET
    status = 'driver_assigned',
    driver_id = p_driver_id,
    confirmed_driver_id = p_driver_id,
    negotiation_owner_driver_id = NULL,
    negotiation_locked_until = NULL,
    negotiation_status = 'confirmed',
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    dispatch_status = 'assigned',
    searching_expires_at = NULL,
    assigned_at = COALESCE(assigned_at, v_now),
    accepted_ride_offer_id = p_offer_id,
    cancelled_at = NULL,
    cancelled_by = NULL,
    cancel_reason = NULL,
    cancellation_reason = NULL,
    cancellation_note = NULL,
    accepted_driver_offer_fare_pence = CASE
      WHEN v_fare_source = 'negotiated_offer' THEN v_fare_pence
      ELSE accepted_driver_offer_fare_pence
    END,
    accepted_preset_offer_fare_pence = CASE
      WHEN v_preset_key IS NOT NULL AND v_preset_fare_pence IS NOT NULL THEN v_preset_fare_pence
      WHEN v_preset_key IS NOT NULL AND v_fare_source = 'negotiated_offer' THEN v_fare_pence
      ELSE accepted_preset_offer_fare_pence
    END,
    locked_offer_type = CASE
      WHEN v_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN v_fare_source
      ELSE locked_offer_type
    END,
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'original_fare_pence', NULLIF(v_original_fare_pence, 0),
        'accepted_via', 'accept_ride_offer',
        'accepted_at', v_now,
        'accepted_preset_key', v_preset_key,
        'accepted_preset_fare_pence', v_preset_fare_pence
      )),
    updated_at = v_now
  WHERE id = v_offer.trip_id;

  UPDATE public.drivers SET current_trip_id = v_offer.trip_id, updated_at = v_now WHERE id = p_driver_id;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers SET active_trip_id = v_offer.trip_id, updated_at = v_now
    WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id;
  END IF;

  PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);

  BEGIN
    PERFORM public.record_booking_delivery(v_offer.trip_id, 'accepted', p_driver_id, p_offer_id, 'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'fare_source', v_fare_source,
        'final_fare_pence', v_final_customer_pence,
        'final_customer_fare_pence', v_final_customer_pence,
        'accepted_preset_key', v_preset_key,
        'accepted_via', 'accept_ride_offer'
      )));
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[accept_ride_offer] record_booking_delivery failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', v_offer.trip_id,
    'status', 'driver_assigned',
    'driver_id', p_driver_id,
    'final_fare_pence', v_final_customer_pence,
    'final_customer_fare_pence', v_final_customer_pence,
    'gross_fare_pence', (v_fare_finalize->>'gross_fare_pence')::integer,
    'discount_pence', v_discount_pence,
    'commission_pence', (v_fare_finalize->>'commission_pence')::integer,
    'driver_net_pence', (v_fare_finalize->>'driver_net_pence')::integer,
    'fare_source', v_fare_source,
    'accepted_preset_key', v_preset_key,
    'accepted_preset_fare_pence', v_preset_fare_pence,
    'original_fare_pence', v_original_fare_pence,
    'counter_offer_amount_pence', v_offer.customer_counter_fare,
    'accepted_via', 'accept_ride_offer'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_explicit_offline_reason(p_reason text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.normalize_driver_offline_reason(p_reason) IN (
    'session_invalid',
    'logout',
    'session_signed_out',
    'token_refresh_failed',
    'admin_force_offline',
    'manual_go_offline'
  ), FALSE);
$$;

-- Block new pending offers when account/compliance ineligible (stacked + idle).
CREATE OR REPLACE FUNCTION public.tr_block_ineligible_ride_offer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_guard jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;
  IF NEW.driver_id IS NULL THEN
    RETURN NEW;
  END IF;
  v_guard := public.accept_ride_offer_eligibility_guard(NEW.driver_id);
  IF COALESCE((v_guard ->> 'ok')::boolean, false) <> true THEN
    RAISE EXCEPTION 'RIDE_OFFER_DRIVER_INELIGIBLE: %',
      COALESCE(v_guard ->> 'code', 'DRIVER_INELIGIBLE')
      USING ERRCODE = 'P0001',
            DETAIL = COALESCE(v_guard ->> 'message', 'Driver is not eligible for new offers');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_block_ineligible_ride_offer ON public.ride_offers;
CREATE TRIGGER tr_block_ineligible_ride_offer
  BEFORE INSERT ON public.ride_offers
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_block_ineligible_ride_offer();

COMMIT;
