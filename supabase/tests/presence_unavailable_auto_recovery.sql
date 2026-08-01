-- Contract assertions for presence_unavailable auto-recovery SSOT.
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
    AND p.proname = 'expire_stale_drivers';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'expire_stale_drivers is missing';
  END IF;

  -- 1) Never clear online intent
  IF v_definition ~* 'set\s+driver_online_intent\s*=\s*false'
     OR v_definition ~* 'driver_online_intent\s*=\s*false\s*,'
  THEN
    RAISE EXCEPTION 'expire_stale_drivers must never clear online intent';
  END IF;

  -- 2) Must restore effective online on repair (auto-recovery without Go Online)
  IF v_definition !~* 'is_online\s*=\s*true' THEN
    RAISE EXCEPTION 'expire_stale_drivers must restore is_online=true on fresh heartbeat repair';
  END IF;

  -- 3) Must degrade effective online on stale heartbeat
  IF v_definition !~* 'is_online\s*=\s*false' THEN
    RAISE EXCEPTION 'expire_stale_drivers must set is_online=false when heartbeat is stale';
  END IF;

  -- 4) Must not stamp manual offline on the stale path body markers
  IF v_definition ~* 'offline_reason\s*=\s*''manual_go_offline'''
     AND v_definition !~* 'driver_online_intent, false\) = false' THEN
    RAISE EXCEPTION 'expire_stale_drivers stale path must not force manual_go_offline';
  END IF;

  -- 5) Must not touch trip identity columns
  IF v_definition ~* 'current_trip_id\s*=' THEN
    RAISE EXCEPTION 'expire_stale_drivers must never write current_trip_id';
  END IF;

  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'upsert_driver_presence'
  ORDER BY p.oid
  LIMIT 1;

  IF v_definition IS NULL
     OR v_definition !~ 'USE_DRIVER_REQUEST_GO_ONLINE'
     OR v_definition !~ 'USE_DRIVER_REQUEST_GO_OFFLINE'
  THEN
    RAISE EXCEPTION 'presence upsert must reject intent transitions';
  END IF;

  -- 6) Upsert must restore healthy presence on fresh HB with intent
  IF v_definition !~* 'presence_health' THEN
    RAISE EXCEPTION 'upsert_driver_presence must refresh presence_health on heartbeat';
  END IF;

  -- 7) Upsert must never clear intent
  IF v_definition ~* 'driver_online_intent\s*=\s*false'
     OR v_definition ~* 'driver_online_intent\s*=\s*true' THEN
    RAISE EXCEPTION 'upsert_driver_presence must never write driver_online_intent';
  END IF;

  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'tr_audit_effective_driver_availability';

  IF v_definition IS NULL OR v_definition !~ 'presence_unavailable' THEN
    RAISE EXCEPTION 'effective availability audit must record presence_unavailable';
  END IF;

  IF v_definition ~* 'manual_go_offline' THEN
    RAISE EXCEPTION 'effective availability audit must not label presence flips as manual_go_offline';
  END IF;
END;
$$;

ROLLBACK;
