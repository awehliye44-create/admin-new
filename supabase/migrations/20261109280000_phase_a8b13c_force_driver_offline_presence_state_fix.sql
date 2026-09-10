-- ============================================================
-- Phase A8B13C: force_driver_offline presence app_state fix
-- Canonical version: 20261109280000.
--
-- Root cause:
--   force_driver_offline INSERT/UPSERT writes app_state='terminated'
--   but driver_presence_app_state_check allows only foreground|background.
--   Unhandled 23514 aborts the function and rolls back prior writes
--   (push-token delete, drivers offline, offer expiry, availability log)
--   when the presence upsert is the failing statement.
--
-- Semantic decision (Option A):
--   app_state is OS lifecycle (foreground/background) only.
--   Availability is independent (drivers.is_online / intent / presence.status).
--   On sign-out write 'background' — do NOT expand the CHECK constraint.
--   Go Offline (driver_request_go_offline) unchanged.
--
-- Preserve A8B13A gate: service_role OR auth.uid() = drivers.user_id
-- Current live body_md5:   0083223b11219bfa908030434d8c8500
-- Proposed body_md5:       03fbd3a02fab2fe38af849d4eb8c5f6d
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
    p_driver_id, 'offline', 'offline', v_reason, now(), false, 'background', now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = 'offline',
    presence_health = 'offline',
    offline_reason = EXCLUDED.offline_reason,
    last_offline_at = EXCLUDED.last_offline_at,
    socket_connected = false,
    push_token = NULL,
    app_state = 'background',
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
  'Phase A8B13C: service_role OR driver self. Presence app_state=background (lifecycle). Offline behaviour otherwise unchanged from A8B13A.';

-- Preserve safe ACL (no PUBLIC / anon).
REVOKE ALL ON FUNCTION public.force_driver_offline(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_driver_offline(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.force_driver_offline(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.force_driver_offline(uuid, text) TO service_role;

COMMIT;
