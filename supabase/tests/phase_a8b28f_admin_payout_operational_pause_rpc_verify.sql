-- ============================================================
-- A8B28F Stage B1 — BEGIN/ROLLBACK verification + role matrix
-- Always ROLLBACK. No PII / bank / provider IDs printed.
-- ============================================================

BEGIN;

-- Preconditions
DO $$
BEGIN
  IF to_regprocedure('public.driver_effective_payout_allowed(uuid)') IS NULL THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: Stage A helper missing';
  END IF;
  IF to_regprocedure('public.admin_set_driver_payout_operational_pause(uuid,boolean,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: B1 RPC already present';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109440000') THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: Stage C present';
  END IF;
END $$;

-- Fleet fingerprint before
DO $$
DECLARE
  v_fp text;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT md5(string_agg(x.row_txt, '|' ORDER BY x.row_txt))
  INTO v_fp
  FROM (
    SELECT md5(
      coalesce((b).live_balance_pence::text, '') || ':' ||
      coalesce((b).available_balance_pence::text, '') || ':' ||
      coalesce((b).pending_balance_pence::text, '') || ':' ||
      coalesce(d.payouts_enabled::text, '') || ':' ||
      coalesce(d.payout_operational_paused::text, '') || ':' ||
      coalesce(public.driver_has_provider_verified_payout_destination(d.id)::text, '') || ':' ||
      coalesce(public.driver_effective_payout_allowed(d.id)::text, '')
    ) AS row_txt
    FROM public.drivers d
    CROSS JOIN LATERAL public.driver_wallet_eligibility_balances(d.id) AS b
    WHERE d.deleted_at IS NULL
  ) x;
  RESET ROLE;
  PERFORM set_config('a8b28f.b1_fp_before', coalesce(v_fp, 'empty'), true);
END $$;

-- MK0006 before
DO $$
DECLARE
  v_enabled boolean; v_paused boolean; v_verified boolean; v_effective boolean;
  v_failed int; v_refs int; v_avail bigint; v_pend bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT d.payouts_enabled, d.payout_operational_paused,
         public.driver_has_provider_verified_payout_destination(d.id),
         public.driver_effective_payout_allowed(d.id),
         (SELECT count(*)::int FROM public.driver_payout_destinations p
           WHERE p.driver_id=d.id AND p.is_active AND p.archived_at IS NULL
             AND upper(coalesce(p.provider_link_status,''))='FAILED'),
         (SELECT count(*)::int FROM public.driver_payout_destinations p
           WHERE p.driver_id=d.id
             AND (p.provider_counterparty_id IS NOT NULL OR p.provider_recipient_account_id IS NOT NULL)),
         (public.driver_wallet_eligibility_balances(d.id)).available_balance_pence,
         (public.driver_wallet_eligibility_balances(d.id)).pending_balance_pence
  INTO v_enabled, v_paused, v_verified, v_effective, v_failed, v_refs, v_avail, v_pend
  FROM public.drivers d WHERE upper(d.driver_code)='MK0006' LIMIT 1;
  RESET ROLE;
  IF NOT FOUND THEN RAISE EXCEPTION 'B1 SIM HARD STOP: MK0006 missing'; END IF;
  IF v_enabled IS DISTINCT FROM false OR v_paused IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: MK0006 pause/legacy drift';
  END IF;
  IF v_verified OR v_effective OR v_refs > 0 OR v_failed < 1 THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: MK0006 destination invariant';
  END IF;
  IF v_avail IS DISTINCT FROM 0 OR v_pend IS DISTINCT FROM 425 THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: MK0006 balance drift';
  END IF;
END $$;

-- Install proposed RPC (rolled back with txn)
CREATE OR REPLACE FUNCTION public.admin_set_driver_payout_operational_pause(
  p_driver_id uuid,
  p_paused boolean,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := trim(coalesce(p_reason, ''));
  v_before_paused boolean;
  v_before_legacy boolean;
  v_after_legacy boolean;
  v_unchanged boolean := false;
BEGIN
  -- Established finance ACL (active staff + payout-ledger company-funds page).
  -- Raises 42501 when unauthorized. Do not trust current_user / metadata roles.
  PERFORM public.assert_finance_payout_ledger_access();

  -- Actor is always JWT auth.uid(). Callers cannot supply/spoof actor.
  -- Also rejects service_role JWT even if assert short-circuits service_role.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_id_required' USING ERRCODE = '22023';
  END IF;

  IF p_paused IS NULL THEN
    RAISE EXCEPTION 'paused_required' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_required_3_to_500_chars' USING ERRCODE = '22023';
  END IF;

  -- Concurrency-safe row lock; existence check.
  SELECT
    coalesce(d.payout_operational_paused, false),
    coalesce(d.payouts_enabled, false)
  INTO v_before_paused, v_before_legacy
  FROM public.drivers d
  WHERE d.id = p_driver_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Temporary compatibility dual-write (Stage B only; Stage D deprecates legacy).
  v_after_legacy := NOT p_paused;

  IF v_before_paused IS NOT DISTINCT FROM p_paused
     AND v_before_legacy IS NOT DISTINCT FROM v_after_legacy THEN
    v_unchanged := true;
  ELSE
    UPDATE public.drivers d
    SET
      payout_operational_paused = p_paused,
      payouts_enabled = v_after_legacy,
      updated_at = now()
    WHERE d.id = p_driver_id;
  END IF;

  -- Audit only on state change — avoid misleading duplicate pause events on idempotent repeats.
  IF NOT v_unchanged THEN
    INSERT INTO public.payout_audit_log (
      driver_id,
      payout_type,
      event_type,
      metadata
    ) VALUES (
      p_driver_id,
      'operational_pause',
      CASE
        WHEN p_paused THEN 'DRIVER_PAYOUT_OPERATIONAL_PAUSE'
        ELSE 'DRIVER_PAYOUT_OPERATIONAL_RESUME'
      END,
      jsonb_build_object(
        'actor_user_id', v_actor,
        'reason', v_reason,
        'before', jsonb_build_object(
          'payout_operational_paused', v_before_paused,
          'payouts_enabled', v_before_legacy
        ),
        'after', jsonb_build_object(
          'payout_operational_paused', p_paused,
          'payouts_enabled', v_after_legacy
        ),
        'destination_mutated', false,
        'wallet_mutated', false,
        'provider_mutated', false
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'payout_operational_paused', p_paused,
    'payouts_enabled', v_after_legacy,
    'unchanged', v_unchanged
  );
END;
$function$;

COMMENT ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) IS
  'A8B28F Stage B1: authorised Admin pause/resume via authenticated finance staff JWT. Actor=auth.uid() only. Dual-writes payout_operational_paused + legacy payouts_enabled. service_role EXECUTE denied. Never verifies destinations or mutates wallet/ledger/provider refs.';

ALTER FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) TO authenticated;
-- postgres retains privilege as owner; do not GRANT service_role.


-- ACL privilege matrix (EXECUTE grants)
DO $$
DECLARE
  v_oid oid := 'public.admin_set_driver_payout_operational_pause(uuid,boolean,text)'::regprocedure;
BEGIN
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: authenticated missing EXECUTE';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: anon has EXECUTE';
  END IF;
  IF has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: service_role has EXECUTE';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: PUBLIC has EXECUTE';
  END IF;
END $$;

ALTER TABLE public.staff_profiles DISABLE TRIGGER USER;
ALTER TABLE public.user_roles DISABLE TRIGGER USER;

-- Role + disposable driver fixtures
DO $$
DECLARE
  v_user_staff_ok uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb945';
  v_user_staff_no uuid := 'dddddddd-dddd-dddd-dddd-ddddddddd945';
  v_user_inactive uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee945';
  v_user_driver uuid := 'cccccccc-cccc-cccc-cccc-ccccccccc945';
  v_user_cust uuid := 'ffffffff-ffff-ffff-ffff-fffffffff945';
  v_user_corp uuid := '11111111-1111-1111-1111-111111111945';
  v_user_none uuid := '22222222-2222-2222-2222-222222222945';
  v_drv_unverified uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa945';
  v_drv_verified uuid := '99999999-9999-9999-9999-999999999945';
  v_dest_verified uuid := '88888888-8888-8888-8888-888888888945';
  v_region uuid;
  v_sa uuid;
  v_res jsonb;
  v_audit_count int;
  v_err text;
  v_state text;
  v_live_staff uuid;
  v_denied uuid;
BEGIN
  SELECT sp.user_id INTO v_live_staff
  FROM public.staff_profiles sp
  JOIN public.role_page_permissions rpp
    ON rpp.role = sp.role AND rpp.page_slug = 'payout-ledger' AND rpp.can_access
  WHERE sp.is_active
    AND sp.role = ANY (ARRAY['super_admin','admin','finance_manager']::public.staff_role[])
  LIMIT 1;
  IF v_live_staff IS NULL THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: no live finance staff';
  END IF;

  SELECT region_id, service_area_id INTO v_region, v_sa
  FROM public.drivers WHERE region_id IS NOT NULL AND service_area_id IS NOT NULL LIMIT 1;
  IF v_region IS NULL OR v_sa IS NULL THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: no region/sa for fixtures';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_user_staff_ok, 'authenticated', 'authenticated', 'a8b28f-b1-staff-ok@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_staff_no, 'authenticated', 'authenticated', 'a8b28f-b1-staff-no@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_inactive, 'authenticated', 'authenticated', 'a8b28f-b1-inactive@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_driver, 'authenticated', 'authenticated', 'a8b28f-b1-driver@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_cust, 'authenticated', 'authenticated', 'a8b28f-b1-cust@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_corp, 'authenticated', 'authenticated', 'a8b28f-b1-corp@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_none, 'authenticated', 'authenticated', 'a8b28f-b1-none@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id, role) VALUES
    (v_user_driver, 'driver'::app_role),
    (v_user_cust, 'customer'::app_role)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.staff_profiles (user_id, staff_role_id, full_name, role, is_active, is_owner)
  VALUES
    (v_user_staff_ok, 'phase-a8b28f-b1-ok', 'A8B28F B1 Staff Ok', 'finance_manager'::staff_role, true, false),
    (v_user_staff_no, 'phase-a8b28f-b1-no', 'A8B28F B1 Staff No', 'operator'::staff_role, true, false),
    (v_user_inactive, 'phase-a8b28f-b1-in', 'A8B28F B1 Inactive', 'finance_manager'::staff_role, false, false);

  -- Disposable drivers
  INSERT INTO public.drivers (
    id, user_id, first_name, last_name, phone, email, region_id, service_area_id,
    approval_status, driver_status, payouts_enabled, payout_operational_paused, deleted_at
  ) VALUES
    (v_drv_unverified, v_user_driver, 'B1', 'Unverified', '+10000000945', 'a8b28f-b1-unverified@example.invalid', v_region, v_sa,
     'approved', 'active', false, false, NULL),
    (v_drv_verified, v_user_cust, 'B1', 'Verified', '+10000000946', 'a8b28f-b1-verified@example.invalid', v_region, v_sa,
     'approved', 'active', false, false, NULL);

  INSERT INTO public.driver_payout_destinations (
    id, driver_id, provider, destination_type, verification_status, provider_link_status,
    provider_counterparty_id, provider_recipient_account_id, is_active, destination_last4
  ) VALUES (
    v_dest_verified, v_drv_verified, 'revolut', 'uk_bank_account', 'PROVIDER_VERIFIED', 'PROVIDER_VERIFIED',
    'fixture_cp', 'fixture_rcpt', true, '0000'
  );

  -- Authorized pause unverified
  PERFORM set_config('request.jwt.claim.sub', v_user_staff_ok::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_staff_ok::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_res := public.admin_set_driver_payout_operational_pause(v_drv_unverified, true, 'B1 sim pause unverified');
  RESET ROLE;
  IF (v_res->>'ok')::boolean IS NOT TRUE OR (v_res->>'payout_operational_paused')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: pause unverified failed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.drivers WHERE id=v_drv_unverified AND (payouts_enabled IS DISTINCT FROM false OR payout_operational_paused IS DISTINCT FROM true)) THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: pause dual-write mismatch';
  END IF;

  -- Idempotent repeat — no new audit
  SELECT count(*)::int INTO v_audit_count FROM public.payout_audit_log
  WHERE driver_id=v_drv_unverified AND event_type='DRIVER_PAYOUT_OPERATIONAL_PAUSE';
  PERFORM set_config('request.jwt.claim.sub', v_user_staff_ok::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_staff_ok::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_res := public.admin_set_driver_payout_operational_pause(v_drv_unverified, true, 'B1 sim pause repeat');
  RESET ROLE;
  IF (v_res->>'unchanged')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: idempotent not unchanged';
  END IF;
  IF (SELECT count(*)::int FROM public.payout_audit_log WHERE driver_id=v_drv_unverified AND event_type='DRIVER_PAYOUT_OPERATIONAL_PAUSE') IS DISTINCT FROM v_audit_count THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: duplicate audit on idempotent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payout_audit_log
    WHERE driver_id=v_drv_unverified AND event_type='DRIVER_PAYOUT_OPERATIONAL_PAUSE'
      AND metadata->>'actor_user_id' = v_user_staff_ok::text
      AND metadata->>'reason' = 'B1 sim pause unverified'
  ) THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: audit actor/reason missing';
  END IF;

  -- Resume unverified → legacy true but still not effective / not provider verified
  PERFORM set_config('request.jwt.claim.sub', v_user_staff_ok::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_staff_ok::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_res := public.admin_set_driver_payout_operational_pause(v_drv_unverified, false, 'B1 sim resume unverified');
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM public.drivers WHERE id=v_drv_unverified AND (payouts_enabled IS DISTINCT FROM true OR payout_operational_paused IS DISTINCT FROM false)) THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: resume dual-write mismatch';
  END IF;
  IF public.driver_has_provider_verified_payout_destination(v_drv_unverified) THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: unverified became provider verified';
  END IF;
  IF public.driver_effective_payout_allowed(v_drv_unverified) THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: unverified became effective';
  END IF;

  -- Resume verified disposable
  PERFORM set_config('request.jwt.claim.sub', v_user_staff_ok::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_staff_ok::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_res := public.admin_set_driver_payout_operational_pause(v_drv_verified, false, 'B1 sim resume verified');
  RESET ROLE;
  IF NOT public.driver_has_provider_verified_payout_destination(v_drv_verified) THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: verified fixture lost provider verify';
  END IF;
  -- Pause verified → legacy false blocks
  PERFORM set_config('request.jwt.claim.sub', v_user_staff_ok::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_staff_ok::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_res := public.admin_set_driver_payout_operational_pause(v_drv_verified, true, 'B1 sim pause verified');
  RESET ROLE;
  IF public.driver_effective_payout_allowed(v_drv_verified) THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: paused verified still effective';
  END IF;
  -- Destination fields unchanged by pause
  IF EXISTS (
    SELECT 1 FROM public.driver_payout_destinations
    WHERE id=v_dest_verified AND (
      upper(provider_link_status) IS DISTINCT FROM 'PROVIDER_VERIFIED'
      OR provider_counterparty_id IS DISTINCT FROM 'fixture_cp'
    )
  ) THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: destination mutated by pause';
  END IF;

  -- Denied roles
  FOR v_denied IN SELECT unnest(ARRAY[v_user_staff_no, v_user_inactive, v_user_driver, v_user_cust, v_user_corp, v_user_none])
  LOOP
    PERFORM set_config('request.jwt.claim.sub', v_denied::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_denied::text, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      PERFORM public.admin_set_driver_payout_operational_pause(v_drv_unverified, true, 'should deny');
      RAISE EXCEPTION 'B1 SIM HARD STOP: unauthorized allowed';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    RESET ROLE;
  END LOOP;

  -- service_role EXECUTE denied (privilege), and even with JWT still no EXECUTE
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM public.admin_set_driver_payout_operational_pause(v_drv_unverified, true, 'service role deny');
    RAISE EXCEPTION 'B1 SIM HARD STOP: service_role EXECUTE allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  -- anon EXECUTE denied
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.admin_set_driver_payout_operational_pause(v_drv_unverified, true, 'anon deny');
    RAISE EXCEPTION 'B1 SIM HARD STOP: anon EXECUTE allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  -- Live finance staff can call (no mutation of live drivers — use disposable)
  PERFORM set_config('request.jwt.claim.sub', (SELECT sp.user_id::text FROM public.staff_profiles sp
    JOIN public.role_page_permissions rpp ON rpp.role=sp.role AND rpp.page_slug='payout-ledger' AND rpp.can_access
    WHERE sp.is_active AND sp.role = ANY (ARRAY['super_admin','admin','finance_manager']::public.staff_role[])
    LIMIT 1), true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object(
    'sub', (SELECT sp.user_id::text FROM public.staff_profiles sp
      JOIN public.role_page_permissions rpp ON rpp.role=sp.role AND rpp.page_slug='payout-ledger' AND rpp.can_access
      WHERE sp.is_active AND sp.role = ANY (ARRAY['super_admin','admin','finance_manager']::public.staff_role[])
      LIMIT 1),
    'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_res := public.admin_set_driver_payout_operational_pause(v_drv_unverified, true, 'B1 live staff disposable');
  RESET ROLE;
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: live staff call failed';
  END IF;
END $$;

ALTER TABLE public.staff_profiles ENABLE TRIGGER USER;
ALTER TABLE public.user_roles ENABLE TRIGGER USER;

-- Dual-write withdraw gate still present in live summary SSOT
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='driver_wallet_summary_ssot' LIMIT 1;
  IF position('PAYOUT_ACCOUNT_NOT_VERIFIED' in v_def)=0 OR position('PROVIDER_VERIFIED' in v_def)=0 THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: summary SSOT lost provider gate';
  END IF;
END $$;

-- Fleet fingerprint after must equal before for non-fixture live drivers:
-- Recompute excluding fixture driver ids
DO $$
DECLARE
  v_fp text;
  v_before text := current_setting('a8b28f.b1_fp_before', true);
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE 'SET LOCAL ROLE service_role';
  SELECT md5(string_agg(x.row_txt, '|' ORDER BY x.row_txt))
  INTO v_fp
  FROM (
    SELECT md5(
      coalesce((b).live_balance_pence::text, '') || ':' ||
      coalesce((b).available_balance_pence::text, '') || ':' ||
      coalesce((b).pending_balance_pence::text, '') || ':' ||
      coalesce(d.payouts_enabled::text, '') || ':' ||
      coalesce(d.payout_operational_paused::text, '') || ':' ||
      coalesce(public.driver_has_provider_verified_payout_destination(d.id)::text, '') || ':' ||
      coalesce(public.driver_effective_payout_allowed(d.id)::text, '')
    ) AS row_txt
    FROM public.drivers d
    CROSS JOIN LATERAL public.driver_wallet_eligibility_balances(d.id) AS b
    WHERE d.deleted_at IS NULL
      AND d.id NOT IN (
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa945'::uuid,
        '99999999-9999-9999-9999-999999999945'::uuid
      )
  ) x;
  RESET ROLE;
  -- Compare against before fingerprint recomputed the same way excluding fixtures (before had no fixtures)
  IF v_fp IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: live fleet fingerprint changed';
  END IF;
END $$;

-- Confirm RPC exists in-txn then roll back
DO $$
BEGIN
  IF to_regprocedure('public.admin_set_driver_payout_operational_pause(uuid,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'B1 SIM HARD STOP: RPC missing in sim';
  END IF;
END $$;

SELECT 'B1_SIM_OK' AS status;

ROLLBACK;
