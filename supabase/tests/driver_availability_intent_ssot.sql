-- Read-only production contract assertions for Driver availability SSOT.
-- Safe to run against a linked project: no fixture rows are created or changed.

BEGIN;

DO $$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'driver_request_go_online';

  IF v_definition IS NULL
     OR v_definition !~* 'driver_online_intent\s*=\s*true'
  THEN
    RAISE EXCEPTION 'driver_request_go_online must persist intent=true';
  END IF;

  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'driver_request_go_offline';

  IF v_definition IS NULL
     OR v_definition !~* 'driver_online_intent\s*=\s*false'
  THEN
    RAISE EXCEPTION 'driver_request_go_offline must persist intent=false';
  END IF;

  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'expire_stale_drivers';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'expire_stale_drivers is missing';
  END IF;

  IF v_definition ~* 'set\s+driver_online_intent\s*=\s*false'
     OR v_definition ~* 'driver_online_intent\s*=\s*false\s*,'
  THEN
    RAISE EXCEPTION 'expire_stale_drivers must never clear online intent';
  END IF;

  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'upsert_driver_presence';

  IF v_definition IS NULL
     OR v_definition !~ 'USE_DRIVER_REQUEST_GO_ONLINE'
     OR v_definition !~ 'USE_DRIVER_REQUEST_GO_OFFLINE'
  THEN
    RAISE EXCEPTION 'presence upsert must reject intent transitions';
  END IF;

  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'tr_driver_status_enforce';

  IF v_definition IS NULL
     OR v_definition ~* 'Cannot disable .* active trip'
  THEN
    RAISE EXCEPTION 'admin disable must preserve an active trip';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_guard_driver_availability_columns'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'direct availability write guard trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_block_ineligible_ride_offer'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'ineligible ride-offer guard trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_audit_effective_driver_availability'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'effective availability audit trigger is missing';
  END IF;
END;
$$;

ROLLBACK;
