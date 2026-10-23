-- Admin operational enable/disable for drivers.
-- Direct Admin UPDATE of driver_status alone left driver_online_intent sticky-true
-- and gave opaque client errors. Canonical path: admin_set_driver_operational_status.

BEGIN;

-- ---------------------------------------------------------------------------
-- Status enforce: leaving active clears online + intent
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tr_driver_status_enforce()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.driver_status IS DISTINCT FROM 'active' AND OLD.driver_status = 'active' THEN
    PERFORM public.allow_driver_availability_write();
    NEW.is_online := false;
    NEW.driver_online_intent := false;
    NEW.online_since := NULL;

    IF OLD.is_online IS DISTINCT FROM false
       OR OLD.driver_online_intent IS DISTINCT FROM false
    THEN
      PERFORM public.log_driver_availability_event(
        NEW.id,
        'effective_offline_account',
        CASE
          WHEN NEW.driver_status = 'disabled' THEN 'admin_disabled'
          WHEN NEW.driver_status = 'deleted' THEN 'account_deleted'
          ELSE 'account_ineligible'
        END,
        OLD.driver_online_intent,
        false,
        OLD.is_online,
        false,
        jsonb_build_object(
          'source', 'tr_driver_status_enforce',
          'active_trip_preserved', NEW.current_trip_id IS NOT NULL
        ),
        'admin'
      );
    END IF;
  END IF;

  IF NEW.driver_status = 'deleted' AND OLD.driver_status IS DISTINCT FROM 'deleted' THEN
    IF NEW.current_trip_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot delete a driver with an active trip (trip_id: %)',
        NEW.current_trip_id;
    END IF;
    NEW.deleted_at := now();
  END IF;

  IF NEW.driver_status IS DISTINCT FROM 'deleted' AND OLD.driver_status = 'deleted' THEN
    NEW.deleted_at := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Admin RPC: set active | disabled (deleted stays on admin-delete-account)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_driver_operational_status(
  p_driver_id uuid,
  p_status public.driver_status
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_driver public.drivers%ROWTYPE;
  v_from_intent boolean;
  v_from_online boolean;
  v_reason text;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_driver_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'driver_id_required',
      'message', 'Driver id is required.'
    );
  END IF;

  IF p_status IS NULL OR p_status::text NOT IN ('active', 'disabled') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'invalid_status',
      'message', 'Status must be active or disabled. Use Delete for permanent removal.'
    );
  END IF;

  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'not_found',
      'message', 'Driver not found.'
    );
  END IF;

  IF v_driver.driver_status = 'deleted' AND p_status = 'disabled' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'already_deleted',
      'message', 'Deleted drivers cannot be disabled. Restore or recreate the account.'
    );
  END IF;

  IF v_driver.driver_status IS NOT DISTINCT FROM p_status
     AND (p_status = 'active' OR (
       COALESCE(v_driver.is_online, false) = false
       AND COALESCE(v_driver.driver_online_intent, false) = false
     ))
  THEN
    RETURN jsonb_build_object(
      'ok', true,
      'unchanged', true,
      'driver_status', v_driver.driver_status,
      'is_online', COALESCE(v_driver.is_online, false),
      'driver_online_intent', COALESCE(v_driver.driver_online_intent, false)
    );
  END IF;

  v_from_intent := COALESCE(v_driver.driver_online_intent, false);
  v_from_online := COALESCE(v_driver.is_online, false);
  v_reason := CASE
    WHEN p_status = 'disabled' THEN 'admin_disabled'
    ELSE 'admin_enabled'
  END;

  PERFORM public.allow_driver_availability_write();

  UPDATE public.drivers
  SET
    driver_status = p_status,
    is_online = CASE WHEN p_status = 'active' THEN is_online ELSE false END,
    driver_online_intent = CASE WHEN p_status = 'active' THEN driver_online_intent ELSE false END,
    online_since = CASE WHEN p_status = 'active' THEN online_since ELSE NULL END,
    deleted_at = CASE WHEN p_status = 'active' THEN NULL ELSE deleted_at END,
    updated_at = now()
  WHERE id = p_driver_id
  RETURNING * INTO v_driver;

  IF p_status = 'disabled' THEN
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

    IF v_from_online OR v_from_intent THEN
      PERFORM public.log_driver_availability_event(
        p_driver_id,
        'force_offline',
        v_reason,
        v_from_intent,
        false,
        v_from_online,
        false,
        jsonb_build_object('source', 'admin_set_driver_operational_status')
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'driver_status', v_driver.driver_status,
    'is_online', COALESCE(v_driver.is_online, false),
    'driver_online_intent', COALESCE(v_driver.driver_online_intent, false)
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', SQLSTATE,
      'message', SQLERRM
    );
END;
$fn$;

COMMENT ON FUNCTION public.admin_set_driver_operational_status(uuid, public.driver_status) IS
  'Admin-only: set driver_status to active|disabled, clear presence on disable.';

REVOKE ALL ON FUNCTION public.admin_set_driver_operational_status(uuid, public.driver_status) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_driver_operational_status(uuid, public.driver_status) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_driver_operational_status(uuid, public.driver_status) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_driver_operational_status(uuid, public.driver_status) TO authenticated;

-- One-shot: clear sticky intent on already-disabled drivers (e.g. MK0007)
SELECT public.allow_driver_availability_write();
UPDATE public.drivers
SET
  is_online = false,
  driver_online_intent = false,
  online_since = NULL,
  updated_at = now()
WHERE driver_status = 'disabled'
  AND (
    COALESCE(is_online, false) = true
    OR COALESCE(driver_online_intent, false) = true
    OR online_since IS NOT NULL
  );

COMMIT;
