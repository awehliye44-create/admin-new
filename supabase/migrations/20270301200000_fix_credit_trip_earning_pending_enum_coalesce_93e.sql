-- #93E / #98 — Fix credit_trip_earning_pending enum COALESCE 22P02.
--
-- Root cause (MK-261126-003): trips.financial_model is enum
-- service_area_financial_model. COALESCE(enum_col, '') type-resolves by casting
-- '' → enum → invalid_text_representation (22P02). Primary stop-workflow and
-- #94A missing-PENDING recovery share this RPC, so both produced zero PENDING.
--
-- Safe: CREATE OR REPLACE only. No ledger backfill. No historical PENDING insert.

BEGIN;

CREATE OR REPLACE FUNCTION public.credit_trip_earning_pending(
  p_trip_id uuid,
  p_driver_id uuid,
  p_amount_pence integer,
  p_currency text DEFAULT 'GBP',
  p_description text DEFAULT 'Trip earning pending payment confirmation'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_trip record;
  v_existing uuid;
  v_id uuid;
  v_amount int := GREATEST(0, COALESCE(p_amount_pence, 0));
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_ids');
  END IF;
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_non_positive');
  END IF;

  SELECT
    id, status, driver_id, confirmed_driver_id, financial_model,
    driver_net_pence, airport_charge_pence, payment_status
  INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR SHARE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_found');
  END IF;
  -- Cast enum/text status + financial_model before COALESCE with '' (MK-261126-003 / #93E).
  IF lower(COALESCE(v_trip.status::text, '')) <> 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_completed');
  END IF;
  IF upper(COALESCE(v_trip.financial_model::text, '')) <> 'PLATFORM_COLLECTED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_financial_model');
  END IF;
  IF COALESCE(v_trip.driver_id, v_trip.confirmed_driver_id) IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'driver_mismatch');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.driver_wallet_ledger
    WHERE related_trip_id = p_trip_id AND type = 'TRIP_EARNING_NET'
  ) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'ten_already_exists', 'inserted', false);
  END IF;

  SELECT id INTO v_existing
  FROM public.driver_wallet_ledger
  WHERE related_trip_id = p_trip_id AND type = 'TRIP_EARNING_PENDING'
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'reason', 'already_exists', 'inserted', false, 'ledger_id', v_existing
    );
  END IF;

  INSERT INTO public.driver_wallet_ledger (
    driver_id, related_trip_id, type, amount_pence, currency, description, metadata
  ) VALUES (
    p_driver_id,
    p_trip_id,
    'TRIP_EARNING_PENDING',
    v_amount,
    upper(COALESCE(NULLIF(trim(p_currency), ''), 'GBP')),
    COALESCE(NULLIF(trim(p_description), ''), 'Trip earning pending payment confirmation'),
    jsonb_build_object(
      'source', 'credit_trip_earning_pending',
      'awaiting_payment_confirmation', true,
      'driver_net_pence', COALESCE(v_trip.driver_net_pence, 0),
      'airport_charge_pence', COALESCE(v_trip.airport_charge_pence, 0)
    )
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'ok', true, 'reason', 'inserted', 'inserted', true, 'ledger_id', v_id, 'amount_pence', v_amount
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id INTO v_existing
    FROM public.driver_wallet_ledger
    WHERE related_trip_id = p_trip_id AND type = 'TRIP_EARNING_PENDING'
    LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true, 'reason', 'already_exists_race', 'inserted', false, 'ledger_id', v_existing
    );
  WHEN check_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'check_violation', 'message', SQLERRM);
  WHEN invalid_text_representation THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'invalid_text_representation', 'message', SQLERRM
    );
END;
$$;

REVOKE ALL ON FUNCTION public.credit_trip_earning_pending(uuid, uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_trip_earning_pending(uuid, uuid, integer, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_trip_earning_pending(uuid, uuid, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_trip_earning_pending(uuid, uuid, integer, text, text) TO postgres;

-- Deploy-contract helper: non-monetary probe (never inserts ledger rows).
CREATE OR REPLACE FUNCTION public.assert_credit_trip_earning_pending_contract()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_probe jsonb;
  v_grants text[];
  v_idx_pending boolean;
  v_idx_release boolean;
  v_type_ok boolean;
BEGIN
  -- Fake UUIDs → must return trip_not_found (not 22P02).
  v_probe := public.credit_trip_earning_pending(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000000002'::uuid,
    425,
    'GBP',
    'deploy-contract-probe'
  );
  IF COALESCE(v_probe->>'reason', '') IS DISTINCT FROM 'trip_not_found' THEN
    RAISE EXCEPTION 'CREDIT_TRIP_EARNING_PENDING_CONTRACT_PROBE_FAILED: %', v_probe;
  END IF;

  SELECT coalesce(array_agg(grantee::text ORDER BY grantee::text), ARRAY[]::text[])
  INTO v_grants
  FROM information_schema.role_routine_grants
  WHERE specific_schema = 'public'
    AND routine_name = 'credit_trip_earning_pending'
    AND privilege_type = 'EXECUTE';

  IF NOT ('service_role' = ANY (v_grants)) THEN
    RAISE EXCEPTION 'CREDIT_TRIP_EARNING_PENDING_MISSING_SERVICE_ROLE_GRANT';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'driver_wallet_ledger_trip_earning_pending_unique'
  ) INTO v_idx_pending;
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'driver_wallet_ledger_trip_earning_pending_release_unique'
  ) INTO v_idx_release;
  IF NOT v_idx_pending OR NOT v_idx_release THEN
    RAISE EXCEPTION 'CREDIT_TRIP_EARNING_PENDING_UNIQUE_INDEX_MISSING';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'driver_wallet_ledger'
      AND c.conname = 'driver_wallet_ledger_type_check'
      AND pg_get_constraintdef(c.oid) LIKE '%TRIP_EARNING_PENDING%'
  ) INTO v_type_ok;
  IF NOT v_type_ok THEN
    RAISE EXCEPTION 'TRIP_EARNING_PENDING_TYPE_CHECK_MISSING';
  END IF;

  -- Definer body must cast financial_model::text (regression lock for MK-261126-003).
  IF position('financial_model::text' in pg_get_functiondef(
    'public.credit_trip_earning_pending(uuid,uuid,integer,text,text)'::regprocedure
  )) = 0 THEN
    RAISE EXCEPTION 'CREDIT_TRIP_EARNING_PENDING_MISSING_ENUM_TEXT_CAST';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'probe_reason', v_probe->>'reason',
    'grants', to_jsonb(v_grants),
    'pending_unique_index', v_idx_pending,
    'release_unique_index', v_idx_release,
    'type_check_includes_pending', v_type_ok
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assert_credit_trip_earning_pending_contract() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_credit_trip_earning_pending_contract() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_credit_trip_earning_pending_contract() TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_credit_trip_earning_pending_contract() TO postgres;

COMMENT ON FUNCTION public.credit_trip_earning_pending(uuid, uuid, integer, text, text) IS
  '#98/#93E idempotent TRIP_EARNING_PENDING credit. Casts financial_model::text before COALESCE.';

COMMENT ON FUNCTION public.assert_credit_trip_earning_pending_contract() IS
  '#93E non-monetary deploy contract probe for pending entitlement RPC.';

COMMIT;
