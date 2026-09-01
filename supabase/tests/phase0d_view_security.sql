-- Phase 0d — model-scoped view security + isolation tests.

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'platform_collected_driver_financial_summary'
  ) THEN
    RAISE EXCEPTION 'platform_collected_driver_financial_summary missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'commission_wallet_driver_financial_summary'
  ) THEN
    RAISE EXCEPTION 'commission_wallet_driver_financial_summary missing';
  END IF;
  RAISE NOTICE 'views exist PASS';
END $$;

-- Seed both models
DO $$
DECLARE
  v_pc uuid := gen_random_uuid();
  v_cw uuid := gen_random_uuid();
  v_t_pc uuid := gen_random_uuid();
  v_t_cw uuid := gen_random_uuid();
  v_t_null uuid := gen_random_uuid();
  v_pc_rows integer;
  v_cw_rows integer;
  v_pc_balance bigint;
  v_cw_balance bigint;
  v_admin_in_cw integer;
  v_pc_has_cw integer;
BEGIN
  INSERT INTO drivers (id, first_name, email) VALUES
    (v_pc, 'Platform', 'pc@test.local'),
    (v_cw, 'Commission', 'cw@test.local');

  INSERT INTO trips (id, driver_id, financial_model) VALUES
    (v_t_pc, v_pc, 'PLATFORM_COLLECTED'),
    (v_t_cw, v_cw, 'DRIVER_COLLECTED_COMMISSION_WALLET'),
    (v_t_null, v_cw, NULL);

  INSERT INTO driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence)
    VALUES (v_pc, v_t_pc, 'TRIP_EARNING_NET', 500);

  INSERT INTO commission_wallet_ledger (driver_id, trip_id, entry_type, amount_pence)
    VALUES (v_cw, NULL, 'ADMIN_CREDIT', 999);

  SELECT count(*) INTO v_pc_rows FROM platform_collected_driver_financial_summary WHERE driver_id = v_pc;
  IF v_pc_rows <> 1 THEN RAISE EXCEPTION 'platform view missing PC driver'; END IF;

  SELECT wallet_balance_pence INTO v_pc_balance FROM platform_collected_driver_financial_summary WHERE driver_id = v_pc;
  IF v_pc_balance <> 500 THEN RAISE EXCEPTION 'platform balance expected 500 got %', v_pc_balance; END IF;

  SELECT count(*) INTO v_pc_rows FROM platform_collected_driver_financial_summary WHERE driver_id = v_cw;
  IF v_pc_rows <> 0 THEN RAISE EXCEPTION 'commission driver must not appear in platform view'; END IF;

  SELECT count(*) INTO v_cw_rows FROM commission_wallet_driver_financial_summary WHERE driver_id = v_cw;
  IF v_cw_rows <> 1 THEN RAISE EXCEPTION 'commission view missing CW driver'; END IF;

  SELECT admin_credit_total_pence INTO v_admin_in_cw
  FROM commission_wallet_driver_financial_summary WHERE driver_id = v_cw;
  IF v_admin_in_cw <> 999 THEN RAISE EXCEPTION 'ADMIN_CREDIT expected 999 got %', v_admin_in_cw; END IF;

  SELECT count(*) INTO v_pc_has_cw FROM commission_wallet_driver_financial_summary WHERE driver_id = v_pc;
  IF v_pc_has_cw <> 0 THEN RAISE EXCEPTION 'platform driver must not appear in commission view'; END IF;

  RAISE NOTICE 'model isolation PASS';
  RAISE EXCEPTION 'ROLLBACK_SCENARIO';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SCENARIO' THEN RAISE; END IF;
END $$;

DO $$
DECLARE
  v_public boolean; v_anon boolean; v_auth boolean; v_service boolean;
BEGIN
  SELECT has_table_privilege('public', 'public.platform_collected_driver_financial_summary', 'SELECT') INTO v_public;
  SELECT has_table_privilege('anon', 'public.platform_collected_driver_financial_summary', 'SELECT') INTO v_anon;
  SELECT has_table_privilege('authenticated', 'public.platform_collected_driver_financial_summary', 'SELECT') INTO v_auth;
  SELECT has_table_privilege('service_role', 'public.platform_collected_driver_financial_summary', 'SELECT') INTO v_service;
  IF v_public OR v_anon OR v_auth THEN RAISE EXCEPTION 'platform view exposed to public roles'; END IF;
  IF NOT v_service THEN RAISE EXCEPTION 'service_role cannot read platform view'; END IF;
  RAISE NOTICE 'platform view grant security PASS';
END $$;

DO $$ BEGIN RAISE NOTICE 'view security tests ALL PASS'; END $$;
