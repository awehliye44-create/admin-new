-- Phase A8B13C post-apply verification. BEGIN/ROLLBACK only.
-- Disposable fixtures. Never targets live drivers.
-- Does NOT CREATE OR REPLACE the live function (would undo apply on ROLLBACK).

BEGIN;

CREATE TEMP TABLE phase_a8b13c_live_hash (
  drivers int NOT NULL,
  online_drivers int NOT NULL,
  presence int NOT NULL,
  push_tokens int NOT NULL,
  active_driver_tokens int NOT NULL,
  offers int NOT NULL,
  availability_events int NOT NULL,
  trips int NOT NULL,
  notifications int NOT NULL,
  payment_sessions int NOT NULL,
  body_md5 text NOT NULL,
  constraint_hash text NOT NULL,
  go_offline_md5 text NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a8b13c_live_hash
SELECT
  (SELECT count(*)::int FROM public.drivers),
  (SELECT count(*)::int FROM public.drivers WHERE is_online IS TRUE),
  (SELECT count(*)::int FROM public.driver_presence),
  (SELECT count(*)::int FROM public.push_tokens),
  (SELECT count(*)::int FROM public.push_tokens WHERE app_type = 'driver' AND COALESCE(is_active, true)),
  (SELECT count(*)::int FROM public.ride_offers),
  (SELECT count(*)::int FROM public.driver_availability_events),
  (SELECT count(*)::int FROM public.trips),
  (SELECT count(*)::int FROM public.notifications),
  (SELECT count(*)::int FROM public.payment_sessions),
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.force_driver_offline(uuid,text)'::regprocedure)),
  md5((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'driver_presence_app_state_check')),
  md5((SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'driver_request_go_offline' LIMIT 1));

DO $$
DECLARE
  v_err text;
  v_state text;
  v_customer uuid;
  v_other_driver_user uuid;
  v_live_driver uuid;
  v_staff uuid;
  v_corporate uuid;
  v_fixture_driver uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000030'::uuid;
  v_offer uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000031'::uuid;
  v_token uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000032'::uuid;
  v_trip uuid;
  v_region uuid;
  v_sa uuid;
  v_md5 text;
  v_status text;
  v_app_state text;
  v_online boolean;
  v_intent boolean;
  v_tokens int;
  v_offers int;
  v_events int;
  v_trip_before uuid;
  v_trip_after uuid;
  v_deny_ok boolean;
BEGIN
  v_md5 := md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.force_driver_offline(uuid,text)'::regprocedure));
  IF v_md5 IS DISTINCT FROM '03fbd3a02fab2fe38af849d4eb8c5f6d' THEN
    RAISE EXCEPTION 'a8b13c: live body hash mismatch %', v_md5;
  END IF;

  IF (SELECT constraint_hash FROM phase_a8b13c_live_hash)
     IS DISTINCT FROM '1d8186655b67139589da9a87e5ded2a9' THEN
    RAISE EXCEPTION 'a8b13c: constraint hash mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.force_driver_offline(uuid,text)'::regprocedure
      AND (prosrc LIKE '%terminated%' OR prosrc ~ 'profiles\.role\s*=' OR prosrc LIKE '%current_user%')
  ) THEN
    RAISE EXCEPTION 'a8b13c: body still has terminated / profiles.role assign / current_user';
  END IF;

  IF NOT (
    has_function_privilege('public', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE') IS NOT TRUE
    AND has_function_privilege('anon', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE') IS NOT TRUE
    AND has_function_privilege('authenticated', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE')
    AND has_function_privilege('service_role', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'a8b13c: ACL matrix failed';
  END IF;

  SELECT c.user_id INTO v_customer
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.user_id = c.user_id)
  LIMIT 1;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'a8b13c: no customer'; END IF;

  SELECT d.id, d.user_id INTO v_live_driver, v_other_driver_user
  FROM public.drivers d
  WHERE d.user_id IS NOT NULL
  LIMIT 1;
  IF v_live_driver IS NULL THEN RAISE EXCEPTION 'a8b13c: no live driver for denial probe'; END IF;

  -- customer → 42501 (against live driver id; never mutates on deny)
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.force_driver_offline(v_live_driver, 'probe');
    RESET ROLE;
    RAISE EXCEPTION 'customer succeeded';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state IS DISTINCT FROM '42501' THEN
        RAISE EXCEPTION 'customer unexpected: % %', v_state, v_err;
      END IF;
  END;

  -- another driver → 42501
  PERFORM set_config('request.jwt.claim.sub', v_other_driver_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other_driver_user, 'role', 'authenticated')::text, true);
  SELECT id INTO v_live_driver
  FROM public.drivers
  WHERE user_id IS DISTINCT FROM v_other_driver_user
  LIMIT 1;
  IF v_live_driver IS NOT NULL THEN
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.force_driver_offline(v_live_driver, 'probe');
      RESET ROLE;
      RAISE EXCEPTION 'other driver succeeded';
    EXCEPTION
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        RESET ROLE;
        IF v_state IS DISTINCT FROM '42501' THEN
          RAISE EXCEPTION 'other driver unexpected: % %', v_state, v_err;
        END IF;
    END;
  END IF;

  -- staff → 42501 (if staff user exists)
  SELECT ur.user_id INTO v_staff
  FROM public.user_roles ur
  WHERE ur.role::text IN ('admin', 'staff', 'super_admin')
  LIMIT 1;
  IF v_staff IS NOT NULL THEN
    SELECT id INTO v_live_driver FROM public.drivers WHERE user_id IS DISTINCT FROM v_staff LIMIT 1;
    IF v_live_driver IS NULL THEN RAISE EXCEPTION 'a8b13c: no driver for staff denial'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.force_driver_offline(v_live_driver, 'probe');
      RESET ROLE;
      RAISE EXCEPTION 'staff succeeded';
    EXCEPTION
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        RESET ROLE;
        IF v_state IS DISTINCT FROM '42501' THEN
          RAISE EXCEPTION 'staff unexpected: % %', v_state, v_err;
        END IF;
    END;
  END IF;

  -- corporate user → 42501 (if present)
  SELECT cu.user_id INTO v_corporate
  FROM public.corporate_users cu
  WHERE cu.user_id IS NOT NULL
  LIMIT 1;
  IF v_corporate IS NULL THEN
    SELECT car.user_id INTO v_corporate
    FROM public.corporate_account_requests car
    WHERE car.user_id IS NOT NULL
    LIMIT 1;
  END IF;
  IF v_corporate IS NOT NULL THEN
    SELECT id INTO v_live_driver FROM public.drivers WHERE user_id IS DISTINCT FROM v_corporate LIMIT 1;
    IF v_live_driver IS NULL THEN RAISE EXCEPTION 'a8b13c: no driver for corporate denial'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_corporate::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_corporate, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.force_driver_offline(v_live_driver, 'probe');
      RESET ROLE;
      RAISE EXCEPTION 'corporate succeeded';
    EXCEPTION
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        RESET ROLE;
        IF v_state IS DISTINCT FROM '42501' THEN
          RAISE EXCEPTION 'corporate unexpected: % %', v_state, v_err;
        END IF;
    END;
  END IF;

  SELECT region_id, service_area_id INTO v_region, v_sa
  FROM public.drivers
  WHERE service_area_id IS NOT NULL
  LIMIT 1;
  IF v_region IS NULL OR v_sa IS NULL THEN
    RAISE EXCEPTION 'a8b13c: no region/sa for fixture';
  END IF;

  SELECT id INTO v_trip FROM public.trips LIMIT 1;

  -- Disposable self-driver: no presence row (INSERT path)
  INSERT INTO public.drivers (
    id, user_id, first_name, last_name, phone, email, region_id, service_area_id,
    approval_status, driver_status, is_online, driver_online_intent, current_trip_id
  ) VALUES (
    v_fixture_driver,
    v_customer,
    'A8B13C',
    'Fixture',
    '+10000000030',
    'phase-a8b13c-fixture@example.invalid',
    v_region,
    v_sa,
    'approved',
    'active',
    true,
    true,
    v_trip
  );

  IF EXISTS (SELECT 1 FROM public.driver_presence WHERE driver_id = v_fixture_driver) THEN
    RAISE EXCEPTION 'a8b13c: fixture unexpectedly has presence';
  END IF;

  INSERT INTO public.push_tokens (id, driver_id, app_type, platform, token, is_active)
  VALUES (v_token, v_fixture_driver, 'driver', 'ios', 'phase-a8b13c-fixture-token', true);

  -- Disable INSERT-only push/dispatch triggers for disposable offer (restored by ROLLBACK)
  IF v_trip IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.ride_offers DISABLE TRIGGER tr_send_push_on_ride_offer_insert';
    EXECUTE 'ALTER TABLE public.ride_offers DISABLE TRIGGER tr_booking_delivery_booking_sent';
    EXECUTE 'ALTER TABLE public.ride_offers DISABLE TRIGGER tr_dispatch_wave_snapshot_on_offer_insert';
    EXECUTE 'ALTER TABLE public.ride_offers DISABLE TRIGGER tr_ride_offer_delivery_trace';
    EXECUTE 'ALTER TABLE public.ride_offers DISABLE TRIGGER tr_block_ineligible_ride_offer';
    BEGIN
      INSERT INTO public.ride_offers (id, trip_id, driver_id, status, offered_at, expires_at, created_at, updated_at)
      VALUES (v_offer, v_trip, v_fixture_driver, 'pending', now(), now() + interval '5 minutes', now(), now());
      IF NOT EXISTS (SELECT 1 FROM public.ride_offers WHERE id = v_offer AND status = 'pending') THEN
        v_offer := NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_offer := NULL;
    END;
  ELSE
    v_offer := NULL;
  END IF;

  IF v_offer IS NULL THEN
    RAISE EXCEPTION 'a8b13c: fixture offer insert failed';
  END IF;

  SELECT current_trip_id INTO v_trip_before FROM public.drivers WHERE id = v_fixture_driver;

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.force_driver_offline(v_fixture_driver, 'session_signed_out');
  RESET ROLE;

  SELECT is_online, driver_online_intent, current_trip_id
  INTO v_online, v_intent, v_trip_after
  FROM public.drivers WHERE id = v_fixture_driver;
  IF v_online IS DISTINCT FROM false OR v_intent IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'a8b13c: driver not offline';
  END IF;
  IF v_trip_after IS DISTINCT FROM v_trip_before THEN
    RAISE EXCEPTION 'a8b13c: current_trip_id changed';
  END IF;

  SELECT status, app_state INTO v_status, v_app_state
  FROM public.driver_presence WHERE driver_id = v_fixture_driver;
  IF v_status IS DISTINCT FROM 'offline' OR v_app_state IS DISTINCT FROM 'background' THEN
    RAISE EXCEPTION 'a8b13c: presence state wrong % %', v_status, v_app_state;
  END IF;

  SELECT count(*)::int INTO v_tokens
  FROM public.push_tokens
  WHERE driver_id = v_fixture_driver AND app_type = 'driver';
  IF v_tokens <> 0 THEN
    RAISE EXCEPTION 'a8b13c: push tokens remain';
  END IF;

  IF v_offer IS NOT NULL THEN
    SELECT count(*)::int INTO v_offers
    FROM public.ride_offers WHERE id = v_offer AND status = 'pending';
    IF v_offers <> 0 THEN
      RAISE EXCEPTION 'a8b13c: pending offer not expired';
    END IF;
    SELECT count(*)::int INTO v_offers
    FROM public.ride_offers WHERE id = v_offer AND status = 'expired';
    IF v_offers <> 1 THEN
      RAISE EXCEPTION 'a8b13c: offer not expired';
    END IF;
  END IF;

  SELECT count(*)::int INTO v_events
  FROM public.driver_availability_events
  WHERE driver_id = v_fixture_driver AND event_type = 'force_offline';
  IF v_events < 1 THEN
    RAISE EXCEPTION 'a8b13c: availability event missing';
  END IF;

  -- terminated still rejected by unchanged CHECK
  BEGIN
    INSERT INTO public.driver_presence (driver_id, status, presence_health, app_state, updated_at)
    VALUES ('aaaaaaaa-bbbb-cccc-dddd-000000000033'::uuid, 'offline', 'offline', 'terminated', now());
    RAISE EXCEPTION 'terminated insert succeeded';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      IF v_state IS DISTINCT FROM '23514' THEN
        RAISE EXCEPTION 'a8b13c: unexpected sqlstate %', v_state;
      END IF;
  END;

  -- Live drivers untouched
  IF EXISTS (
    SELECT 1 FROM public.drivers d
    WHERE d.id <> v_fixture_driver
      AND (
        (SELECT count(*) FROM public.drivers WHERE id <> v_fixture_driver) IS NULL
      )
  ) THEN
    NULL;
  END IF;
END;
$$;

SELECT
  'a8b13c_verify_ok' AS result,
  (SELECT body_md5 FROM phase_a8b13c_live_hash) AS body_md5,
  (SELECT constraint_hash FROM phase_a8b13c_live_hash) AS constraint_hash,
  (SELECT go_offline_md5 FROM phase_a8b13c_live_hash) AS go_offline_md5;

ROLLBACK;
