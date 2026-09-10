-- Rollback Phase A8B13A. Restores exact pre-change production body and safe ACL.
-- Production body_md5 before A8B13A: c2a240bbda71c3e66f7ead124b736723

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
$fn$;

COMMENT ON FUNCTION public.force_driver_offline(uuid, text) IS NULL;

REVOKE ALL ON FUNCTION public.force_driver_offline(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_driver_offline(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.force_driver_offline(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.force_driver_offline(uuid, text) TO service_role;

COMMIT;
