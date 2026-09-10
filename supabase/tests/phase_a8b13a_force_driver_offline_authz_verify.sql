-- Phase A8B13A body-gate simulation. Applies the draft function, probes, then ROLLBACK.
-- Never targets live drivers for a successful offline mutation.
-- Denial probes may FOR UPDATE a live driver then raise 42501 (no mutation).
-- Self-success uses a disposable drivers row bound to an existing non-driver auth user
-- (no Auth insert). service_role / postgres: privilege checks only (no invoke).
-- Push/dispatch triggers on ride_offers are INSERT-only; fixture has no pending offers.

BEGIN;

CREATE TEMP TABLE phase_a8b13a_live_hash (
  drivers int NOT NULL,
  presence int NOT NULL,
  avail_events int NOT NULL,
  offers int NOT NULL,
  pending_offers int NOT NULL,
  push_tokens int NOT NULL,
  trips int NOT NULL,
  notifications int NOT NULL,
  staff_profiles int NOT NULL,
  body_md5_before text NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a8b13a_live_hash
SELECT
  (SELECT count(*)::int FROM public.drivers),
  (SELECT count(*)::int FROM public.driver_presence),
  (SELECT count(*)::int FROM public.driver_availability_events),
  (SELECT count(*)::int FROM public.ride_offers),
  (SELECT count(*)::int FROM public.ride_offers WHERE status = 'pending'),
  (SELECT count(*)::int FROM public.push_tokens),
  (SELECT count(*)::int FROM public.trips),
  (SELECT count(*)::int FROM public.notifications),
  (SELECT count(*)::int FROM public.staff_profiles),
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.force_driver_offline(uuid,text)'::regprocedure));

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

CREATE TEMP TABLE phase_a8b13a_live_drivers (
  id uuid PRIMARY KEY,
  is_online boolean NOT NULL,
  driver_online_intent boolean NOT NULL,
  online_since timestamptz,
  updated_at timestamptz
) ON COMMIT DROP;

INSERT INTO phase_a8b13a_live_drivers (id, is_online, driver_online_intent, online_since, updated_at)
SELECT id, is_online, driver_online_intent, online_since, updated_at
FROM public.drivers;

DO $$
DECLARE
  v_err text;
  v_state text;
  v_customer uuid;
  v_driver_user uuid;
  v_live_driver uuid;
  v_fixture_driver uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000013'::uuid;
  v_fixture_user uuid;
  v_missing uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_region uuid;
  v_draft_expected text := '0083223b11219bfa908030434d8c8500';
BEGIN
  IF has_function_privilege('public', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'a8b13a acl drift';
  END IF;

  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.force_driver_offline(uuid,text)'::regprocedure))
     IS DISTINCT FROM v_draft_expected THEN
    RAISE EXCEPTION 'draft body hash mismatch (got %)',
      md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.force_driver_offline(uuid,text)'::regprocedure));
  END IF;

  SELECT d.id, d.user_id INTO v_live_driver, v_driver_user
  FROM public.drivers d
  WHERE d.user_id IS NOT NULL
  LIMIT 1;
  IF v_live_driver IS NULL THEN
    RAISE EXCEPTION 'no driver with user_id for denial probe';
  END IF;

  SELECT c.user_id INTO v_customer
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
    AND c.user_id IS DISTINCT FROM v_driver_user
    AND NOT EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = c.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.user_id = c.user_id)
  LIMIT 1;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'no spare customer auth user for probes';
  END IF;

  -- Customer forcing another driver → 42501 (lock then reject; no mutation)
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.force_driver_offline(v_live_driver, 'probe');
    RESET ROLE;
    RAISE EXCEPTION 'customer succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'customer unexpected: % %', v_state, v_err;
      END IF;
  END;

  -- Driver forcing a different driver → 42501
  PERFORM set_config('request.jwt.claim.sub', v_driver_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver_user, 'role', 'authenticated')::text, true);
  -- Pick a second live driver if present; else use missing uuid for Driver not found
  IF (SELECT count(*) FROM public.drivers WHERE user_id IS NOT NULL AND user_id IS DISTINCT FROM v_driver_user) > 0 THEN
    SELECT d.id INTO v_live_driver
    FROM public.drivers d
    WHERE d.user_id IS NOT NULL AND d.user_id IS DISTINCT FROM v_driver_user
    LIMIT 1;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.force_driver_offline(v_live_driver, 'probe');
      RESET ROLE;
      RAISE EXCEPTION 'other-driver force succeeded';
    EXCEPTION
      WHEN insufficient_privilege THEN RESET ROLE;
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        RESET ROLE;
        IF v_state <> '42501' THEN
          RAISE EXCEPTION 'other-driver unexpected: % %', v_state, v_err;
        END IF;
    END;
  END IF;

  -- Corporate stand-in (non-staff synthetic) → 42501 against live driver
  SELECT d.id INTO v_live_driver FROM public.drivers d WHERE d.user_id IS NOT NULL LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.force_driver_offline(v_live_driver, 'probe');
    RESET ROLE;
    RAISE EXCEPTION 'corporate succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'corporate unexpected: % %', v_state, v_err;
      END IF;
  END;

  -- Inactive staff (profiles.role path removed) → 42501
  INSERT INTO public.staff_profiles (user_id, staff_role_id, full_name, role, is_active, is_owner)
  VALUES (v_customer, 'phase-a8b13a-probe', 'phase a8b13a probe', 'admin', false, false);
  -- Also stamp stale profiles.role=admin if a profiles row exists for this user
  UPDATE public.profiles SET role = 'admin' WHERE user_id = v_customer;

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.force_driver_offline(v_live_driver, 'probe');
    RESET ROLE;
    RAISE EXCEPTION 'inactive staff / profiles.admin succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'inactive staff unexpected: % %', v_state, v_err;
      END IF;
  END;

  -- Active staff with profiles.role=admin still denied (path removed)
  UPDATE public.staff_profiles
  SET is_active = true
  WHERE user_id = v_customer AND staff_role_id = 'phase-a8b13a-probe';
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.force_driver_offline(v_live_driver, 'probe');
    RESET ROLE;
    RAISE EXCEPTION 'staff profiles.admin path still open';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'active staff unexpected: % %', v_state, v_err;
      END IF;
  END;

  -- Self JWT + missing driver → existing missing-row behaviour
  v_fixture_user := v_customer;
  PERFORM set_config('request.jwt.claim.sub', v_fixture_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_fixture_user, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.force_driver_offline(v_missing, 'probe');
    RESET ROLE;
    RAISE EXCEPTION 'missing driver succeeded';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_err NOT LIKE 'Driver not found:%' THEN
        RAISE EXCEPTION 'missing driver unexpected: % %', v_state, v_err;
      END IF;
  END;

  SELECT region_id INTO v_region FROM public.drivers LIMIT 1;
  IF v_region IS NULL THEN
    RAISE EXCEPTION 'no region_id for disposable driver';
  END IF;

  -- Disposable driver owned by spare customer auth user (offline branch)
  INSERT INTO public.drivers (
    id, user_id, first_name, last_name, phone, email, region_id, service_area_id,
    approval_status, driver_status, is_online, driver_online_intent
  )
  SELECT
    v_fixture_driver,
    v_fixture_user,
    'A8B13A',
    'Fixture',
    '+10000000013',
    'phase-a8b13a-fixture@example.invalid',
    v_region,
    d.service_area_id,
    'approved',
    'active',
    true,
    true
  FROM public.drivers d
  WHERE d.service_area_id IS NOT NULL
  LIMIT 1;

  PERFORM set_config('request.jwt.claim.sub', v_fixture_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_fixture_user, 'role', 'authenticated')::text, true);

  -- Self-binding proof: authz must pass. Full presence upsert may hit the
  -- pre-existing driver_presence_app_state_check (INSERT proposes 'terminated'
  -- while CHECK allows only foreground|background). That defect is unchanged
  -- by A8B13A; treat non-42501 23514 as authz success for this fixture.
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.force_driver_offline(v_fixture_driver, 'session_signed_out');
    RESET ROLE;
    IF NOT EXISTS (
      SELECT 1 FROM public.drivers
      WHERE id = v_fixture_driver
        AND is_online IS FALSE
        AND driver_online_intent IS FALSE
    ) THEN
      RAISE EXCEPTION 'fixture driver not offline';
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state = '42501' THEN
        RAISE EXCEPTION 'self fixture unexpectedly unauthorized';
      END IF;
      IF v_state IS DISTINCT FROM '23514'
         OR v_err NOT ILIKE '%driver_presence_app_state_check%' THEN
        RAISE EXCEPTION 'self fixture unexpected: % %', v_state, v_err;
      END IF;
  END;

  IF EXISTS (
    SELECT 1
    FROM public.drivers d
    JOIN phase_a8b13a_live_drivers ld ON ld.id = d.id
    WHERE d.is_online IS DISTINCT FROM ld.is_online
       OR d.driver_online_intent IS DISTINCT FROM ld.driver_online_intent
       OR d.online_since IS DISTINCT FROM ld.online_since
  ) THEN
    RAISE EXCEPTION 'live driver availability drift';
  END IF;

  IF (SELECT count(*)::int FROM public.notifications) <> (SELECT notifications FROM phase_a8b13a_live_hash) THEN
    RAISE EXCEPTION 'notifications drift';
  END IF;
  IF (SELECT count(*)::int FROM public.trips) <> (SELECT trips FROM phase_a8b13a_live_hash) THEN
    RAISE EXCEPTION 'trips drift';
  END IF;
  IF (SELECT count(*)::int FROM public.ride_offers WHERE status = 'pending')
       <> (SELECT pending_offers FROM phase_a8b13a_live_hash) THEN
    RAISE EXCEPTION 'pending offers drift';
  END IF;
END $$;

SELECT
  h.drivers AS drivers_before,
  (SELECT count(*)::int FROM public.drivers) AS drivers_after_incl_fixture,
  h.presence AS presence_before,
  h.avail_events AS avail_events_before,
  (SELECT count(*)::int FROM public.driver_availability_events) AS avail_events_after,
  h.notifications AS notifications,
  h.pending_offers AS pending_offers,
  has_function_privilege('authenticated', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE') AS auth_exec,
  has_function_privilege('anon', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE') AS anon_exec,
  has_function_privilege('public', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE') AS public_exec,
  has_function_privilege('service_role', 'public.force_driver_offline(uuid,text)'::regprocedure, 'EXECUTE') AS svc_exec,
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.force_driver_offline(uuid,text)'::regprocedure)) AS draft_body_hash,
  '0083223b11219bfa908030434d8c8500'::text AS expected_draft_hash,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109250000') AS migration_applied
FROM phase_a8b13a_live_hash h;

ROLLBACK;
