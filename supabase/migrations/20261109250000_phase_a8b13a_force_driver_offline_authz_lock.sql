-- ============================================================
-- Phase A8B13A: force_driver_offline body authorization lock
-- Applied: canonical version 20261109250000.
--
-- Proven callers:
--   Driver native sign-out → forceDriverOffline(own driverId, 'session_signed_out')
--   Go Offline UI uses driver_request_go_offline (unchanged)
--   Admin UI: no mounted caller (types only)
--   Edge / SQL parents / cron / triggers: none
--
-- Vulnerability: body also allowed EXISTS profiles.role = 'admin'.
-- Live consistency: profiles.role=admin count = 0 while active staff = 1
-- (stale / dead Admin path). No force-offline action key exists.
-- HARD STOP on inventing staff_has_page_access('drivers') without a
-- mounted Admin route/sidebar/action agreement.
--
-- Gate: service_role OR auth.uid() = drivers.user_id
-- Remove profiles.role path. SQLSTATE 42501 + 'not authorized'.
-- Preserve signature, offline mutations, ACL (authenticated EXECUTE),
-- owner/language/volatility/SECURITY DEFINER/search_path.
-- Production body_md5 before: c2a240bbda71c3e66f7ead124b736723
-- Proposed body_md5:          0083223b11219bfa908030434d8c8500
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.force_driver_offline(
  p_driver_id uuid,
  p_reason text DEFAULT 'logout'::text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_reason text := COALESCE(public.normalize_driver_offline_reason(p_reason), 'logout');
  v_driver RECORD;
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

  -- Driver self (sign-out) or service_role only. Do not trust profiles.role.
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM v_driver.user_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
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
$fn$;

COMMENT ON FUNCTION public.force_driver_offline(uuid, text) IS
  'Phase A8B13A: service_role OR driver self (auth.uid = drivers.user_id). profiles.role admin path removed. Offline behaviour otherwise unchanged.';

-- Preserve safe ACL (no PUBLIC / anon).
REVOKE ALL ON FUNCTION public.force_driver_offline(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_driver_offline(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.force_driver_offline(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.force_driver_offline(uuid, text) TO service_role;

COMMIT;
