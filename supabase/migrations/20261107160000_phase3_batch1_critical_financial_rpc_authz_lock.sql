-- ============================================================
-- Phase 3 Batch 1: CRITICAL financial RPC authz lock
-- NOT APPLIED until explicitly approved.
--
-- Precise staff permission SSOT:
--   public.staff_has_company_funds_read_access(page_slug)
--   roles: super_admin | admin | finance_manager + role_page_permissions
-- Callers:
--   PayoutLedgerActions.tsx → page payout-ledger
--   useDriverWalletSsot.ts → driver-wallet-ledger / financial-reconciliation / payout-ledger
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.assert_finance_payout_ledger_access()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN;
  END IF;

  IF public.staff_has_company_funds_read_access('payout-ledger') THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
END;
$fn$;

COMMENT ON FUNCTION public.assert_finance_payout_ledger_access() IS
  'Batch1: service_role OR staff_has_company_funds_read_access(payout-ledger). Fail closed.';

REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM anon;
GRANT EXECUTE ON FUNCTION public.assert_finance_payout_ledger_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_finance_payout_ledger_access() TO service_role;

CREATE OR REPLACE FUNCTION public.assert_driver_wallet_read_access(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'p_driver_id is required' USING ERRCODE = '22023';
  END IF;

  IF auth.role() = 'service_role' THEN
    RETURN;
  END IF;

  IF v_uid IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.drivers d
    WHERE d.id = p_driver_id
      AND d.user_id = v_uid
  ) THEN
    RETURN;
  END IF;

  IF public.staff_has_company_funds_read_access('driver-wallet-ledger')
     OR public.staff_has_company_funds_read_access('financial-reconciliation')
     OR public.staff_has_company_funds_read_access('payout-ledger')
  THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
END;
$fn$;

COMMENT ON FUNCTION public.assert_driver_wallet_read_access(uuid) IS
  'Batch1: service_role OR owning driver OR company-funds page access. Fail closed.';

REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.assert_driver_wallet_read_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_driver_wallet_read_access(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.ops_retry_failed_payout(p_payout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payout RECORD;
BEGIN
  PERFORM public.assert_finance_payout_ledger_access();

  SELECT id, status INTO v_payout FROM payout_batches WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout not found');
  END IF;
  IF v_payout.status NOT IN ('failed', 'error') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout status is ' || v_payout.status || ', not eligible for retry');
  END IF;

  UPDATE payout_batches SET status = 'pending', updated_at = now() WHERE id = p_payout_id;

  RETURN jsonb_build_object('success', true, 'message', 'Payout reset to pending', 'affected_rows', 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ops_retry_failed_payout_item(p_payout_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item payout_items%ROWTYPE;
BEGIN
  PERFORM public.assert_finance_payout_ledger_access();

  SELECT * INTO v_item FROM payout_items WHERE id = p_payout_item_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout item not found');
  END IF;

  IF v_item.status NOT IN ('failed', 'ledger_sync_failed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Item status is ' || v_item.status || ', not eligible for retry');
  END IF;

  UPDATE payout_items SET
    status = 'pending',
    error_message = NULL,
    failure_reason = NULL,
    failed_at = NULL,
    provider_status = NULL,
    updated_at = now()
  WHERE id = p_payout_item_id;

  RETURN jsonb_build_object('success', true, 'message', 'Payout item reset to pending', 'payout_item_id', p_payout_item_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.return_failed_payout_to_wallet(p_payout_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item payout_items%ROWTYPE;
  v_batch payout_batches%ROWTYPE;
  v_return_pence BIGINT;
  v_ledger_id UUID;
  v_currency TEXT := 'gbp';
BEGIN
  PERFORM public.assert_finance_payout_ledger_access();

  SELECT * INTO v_item FROM payout_items WHERE id = p_payout_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_item_not_found');
  END IF;

  IF v_item.return_ledger_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_returned', true,
      'return_ledger_entry_id', v_item.return_ledger_entry_id,
      'returned_to_wallet_pence', v_item.returned_to_wallet_pence
    );
  END IF;

  IF v_item.status NOT IN ('failed', 'ledger_sync_failed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'item_not_failed', 'status', v_item.status);
  END IF;

  v_return_pence := COALESCE(
    v_item.failed_payout_amount_pence,
    v_item.net_driver_payout_pence,
    v_item.amount_pence,
    0
  );

  IF v_return_pence <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'nothing_to_return');
  END IF;

  SELECT currency_code INTO v_currency
  FROM driver_financial_summary
  WHERE driver_id = v_item.driver_id
  LIMIT 1;

  IF v_currency IS NULL OR v_currency = '' THEN
    v_currency := 'gbp';
  END IF;

  INSERT INTO driver_wallet_ledger (
    driver_id, type, amount_pence, currency, description, created_at
  ) VALUES (
    v_item.driver_id,
    'PAYOUT_FAILED_RETURN',
    v_return_pence,
    v_currency,
    'Payout failed — funds returned to wallet',
    now()
  )
  RETURNING id INTO v_ledger_id;

  PERFORM recalculate_driver_wallet(v_item.driver_id);

  UPDATE payout_items SET
    returned_to_wallet_pence = v_return_pence,
    return_ledger_entry_id = v_ledger_id,
    driver_paid_out_pence = 0,
    failed_payout_amount_pence = COALESCE(failed_payout_amount_pence, v_return_pence),
    settlement_status = CASE
      WHEN COALESCE(cash_commission_recovered_pence, 0) > 0 THEN 'PARTIAL_SETTLEMENT'
      ELSE 'FAILED'
    END,
    updated_at = now()
  WHERE id = p_payout_item_id;

  IF v_item.batch_id IS NOT NULL THEN
    SELECT * INTO v_batch FROM payout_batches WHERE id = v_item.batch_id;
    IF FOUND AND v_batch.kind = 'WEEKLY_MONDAY' THEN
      UPDATE payout_batches SET
        status = CASE
          WHEN status = 'completed' THEN status
          ELSE 'PARTIAL_SETTLEMENT'
        END,
        notes = COALESCE(notes, '') || ' ONECAB commission recovered; one or more driver payouts failed.',
        updated_at = now()
      WHERE id = v_item.batch_id
        AND EXISTS (
          SELECT 1 FROM payout_items pi
          WHERE pi.batch_id = v_item.batch_id
            AND pi.settlement_status = 'PARTIAL_SETTLEMENT'
        );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'return_ledger_entry_id', v_ledger_id,
    'returned_to_wallet_pence', v_return_pence
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_wallet_balance(p_driver_id uuid)
 RETURNS TABLE(available_pence bigint, can_payout boolean, can_early_cashout boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet    bigint;
  v_available bigint;
BEGIN
  PERFORM public.assert_driver_wallet_read_access(p_driver_id);

  SELECT
    COALESCE(net_available_for_payout, 0),   -- GREATEST(wallet_balance − reserved_cashout, 0)
    COALESCE(wallet_balance, 0)
  INTO v_available, v_wallet
  FROM public.driver_financial_summary
  WHERE driver_id = p_driver_id;

  -- If driver not found, return safe zeros (no row = no wallet = no payout)
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::bigint, false, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    GREATEST(COALESCE(v_available, 0), 0)::bigint,   -- net available, always >= 0
    (COALESCE(v_wallet, 0) > 0),                     -- can_payout = false when wallet <= 0
    (COALESCE(v_available, 0) > 50);                  -- early cashout min (50p net threshold)
END;
$function$;

CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances(p_driver_id uuid)
 RETURNS TABLE(live_balance_pence bigint, available_balance_pence bigint, pending_balance_pence bigint, withdrawal_in_progress_pence bigint, outstanding_debt_pence bigint, eligible_earnings_pence bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live bigint := 0;
  v_debt bigint := 0;
  v_reserved bigint := 0;
  v_in_flight bigint := 0;
  v_withdrawal bigint := 0;
  v_eligible bigint := 0;
  v_pending bigint := 0;
  v_unpaid_eligible bigint := 0;
  v_available bigint := 0;
  v_delay_hours numeric := 48;
  v_payouts_enabled boolean := true;
  r record;
  v_captured bigint;
  v_canonical bigint;
  v_refunded bigint;
  v_session_status text;
  v_allocated bigint;
  v_unpaid bigint;
  v_model text;
  v_method text;
  v_requires_clearing boolean;
  v_cleared boolean;
  v_origin timestamptz;
  v_first_captured timestamptz;
BEGIN
  PERFORM public.assert_driver_wallet_read_access(p_driver_id);

  v_live := public.driver_wallet_live_balance_pence(p_driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(p_driver_id);
  v_in_flight := public.driver_wallet_other_holds_pence(p_driver_id);
  v_withdrawal := GREATEST(0, v_reserved) + GREATEST(0, v_in_flight);
  v_delay_hours := public.driver_wallet_payout_clearing_delay_hours();

  SELECT COALESCE(payouts_enabled, true)
  INTO v_payouts_enabled
  FROM public.drivers
  WHERE id = p_driver_id;

  SELECT GREATEST(
    0,
    COALESCE(SUM(CASE WHEN type = 'CASH_COMMISSION_DEBT' THEN abs(amount_pence) ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN type = 'DEBT_RECOVERY' THEN abs(amount_pence) ELSE 0 END), 0)
  )::bigint
  INTO v_debt
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id;

  IF v_payouts_enabled IS NOT TRUE THEN
    RETURN QUERY SELECT
      v_live,
      0::bigint,
      GREATEST(0, v_live)::bigint,
      v_withdrawal,
      GREATEST(0, v_debt)::bigint,
      0::bigint;
    RETURN;
  END IF;

  FOR r IN
    SELECT
      l.id AS ledger_id,
      l.type,
      l.amount_pence,
      l.related_trip_id,
      l.created_at,
      t.payment_collection_model::text AS payment_collection_model,
      t.financial_model::text AS financial_model,
      t.payment_method AS trip_payment_method,
      t.status::text AS trip_status,
      t.cancelled_at AS trip_cancelled_at,
      t.completed_at AS trip_completed_at,
      t.driver_net_pence,
      t.tip_pence,
      t.tip_amount_pence,
      t.provider_available_on AS trip_provider_available_on,
      ps.id AS session_id,
      ps.captured_amount_pence,
      ps.captured_at,
      ps.metadata AS session_metadata,
      ps.refunded_amount_pence,
      ps.status::text AS session_status,
      ps.provider_state,
      ps.payment_method AS session_payment_method,
      des.settled_at,
      des.settlement_status,
      des.provider_available_on AS des_provider_available_on,
      des.capture_time,
      des.allocated_to_payout,
      des.allocated_amount_pence,
      des.paid_in_batch_id,
      des.paid_in_payout_item_id,
      COALESCE(alloc.allocated_sum, 0)::bigint AS alloc_sum
    FROM public.driver_wallet_ledger l
    LEFT JOIN public.trips t ON t.id = l.related_trip_id
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM public.payment_sessions s
      WHERE s.id = t.payment_session_id
         OR s.trip_id = t.id
      ORDER BY COALESCE(s.captured_amount_pence, 0) DESC, s.captured_at DESC NULLS LAST
      LIMIT 1
    ) ps ON true
    LEFT JOIN LATERAL (
      SELECT d.*
      FROM public.driver_earning_settlement d
      WHERE d.ledger_entry_id = l.id
      ORDER BY d.updated_at DESC NULLS LAST
      LIMIT 1
    ) des ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.amount_pence), 0) AS allocated_sum
      FROM public.payout_item_ledger_allocations a
      INNER JOIN public.payout_items pi ON pi.id = a.payout_item_id
      WHERE a.ledger_entry_id = l.id
        AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status)
    ) alloc ON true
    WHERE l.driver_id = p_driver_id
      AND l.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'TIP_CREDIT')
      AND l.amount_pence > 0
  LOOP
    IF r.paid_in_batch_id IS NOT NULL
       OR r.allocated_to_payout IS TRUE
       OR r.paid_in_payout_item_id IS NOT NULL THEN
      CONTINUE;
    END IF;

    v_allocated := GREATEST(
      COALESCE(r.alloc_sum, 0),
      COALESCE(r.allocated_amount_pence, 0)
    );
    v_unpaid := GREATEST(0, r.amount_pence - v_allocated);
    IF v_unpaid <= 0 THEN
      CONTINUE;
    END IF;

    IF r.related_trip_id IS NULL THEN
      CONTINUE;
    END IF;
    IF r.trip_cancelled_at IS NOT NULL THEN
      CONTINUE;
    END IF;
    IF lower(COALESCE(r.trip_status, '')) LIKE '%cancel%' THEN
      CONTINUE;
    END IF;
    IF lower(btrim(COALESCE(r.trip_status, ''))) <> 'completed'
       AND r.trip_completed_at IS NULL THEN
      CONTINUE;
    END IF;

    v_session_status := lower(COALESCE(r.session_status::text, ''));
    v_refunded := GREATEST(0, COALESCE(r.refunded_amount_pence, 0));
    IF v_refunded > 0
       OR v_session_status LIKE '%refund%'
       OR v_session_status LIKE '%chargeback%'
       OR v_session_status LIKE '%dispute%'
       OR v_session_status LIKE '%cancel%'
       OR v_session_status LIKE '%void%'
       OR lower(COALESCE(r.provider_state, '')) IN ('cancelled', 'canceled', 'failed', 'void') THEN
      CONTINUE;
    END IF;

    v_captured := CASE
      WHEN r.captured_amount_pence IS NULL THEN NULL
      ELSE round(r.captured_amount_pence)::bigint
    END;

    IF r.session_id IS NULL OR v_captured IS NULL OR v_captured <= 0 THEN
      CONTINUE;
    END IF;

    IF upper(r.type) = 'TRIP_EARNING_NET' THEN
      v_canonical := GREATEST(0, COALESCE(r.driver_net_pence, 0));
    ELSE
      v_canonical := GREATEST(0, COALESCE(r.tip_pence, r.tip_amount_pence, 0));
    END IF;

    IF v_canonical <= 0 OR r.amount_pence <> v_canonical THEN
      CONTINUE;
    END IF;

    IF v_captured < v_canonical THEN
      CONTINUE;
    END IF;

    v_model := upper(btrim(COALESCE(
      r.payment_collection_model::text,
      r.financial_model::text,
      'PLATFORM_COLLECTED'
    )));
    v_method := lower(btrim(COALESCE(r.trip_payment_method, r.session_payment_method, '')));
    v_requires_clearing := (v_model NOT LIKE '%DRIVER_COLLECTED%')
      AND v_method NOT LIKE '%cash%';

    v_cleared := NOT v_requires_clearing;
    IF v_requires_clearing THEN
      IF COALESCE(r.des_provider_available_on, r.trip_provider_available_on) IS NOT NULL
         AND COALESCE(r.des_provider_available_on, r.trip_provider_available_on) <= now() THEN
        v_cleared := true;
      ELSIF public.driver_wallet_provider_funds_cleared(r.provider_state) THEN
        v_cleared := true;
      ELSE
        v_first_captured := NULL;
        IF r.session_metadata IS NOT NULL
           AND jsonb_typeof(r.session_metadata) = 'object'
           AND NULLIF(btrim(r.session_metadata->>'first_captured_at'), '') IS NOT NULL THEN
          BEGIN
            v_first_captured := (r.session_metadata->>'first_captured_at')::timestamptz;
          EXCEPTION WHEN OTHERS THEN
            v_first_captured := NULL;
          END;
        END IF;

        v_origin := public.driver_wallet_stable_clearing_origin(
          r.captured_at,
          r.trip_completed_at,
          r.capture_time,
          r.created_at,
          v_first_captured
        );
        IF v_origin IS NOT NULL
           AND (v_origin + (v_delay_hours * interval '1 hour')) <= now() THEN
          v_cleared := true;
        END IF;
      END IF;
    END IF;

    IF v_cleared THEN
      v_eligible := v_eligible + v_unpaid;
    ELSE
      v_pending := v_pending + v_unpaid;
    END IF;
  END LOOP;

  v_unpaid_eligible := LEAST(
    GREATEST(0, v_eligible),
    GREATEST(0, GREATEST(0, v_live) - GREATEST(0, v_pending))
  );
  v_available := GREATEST(
    0,
    v_unpaid_eligible - GREATEST(0, v_debt) - v_withdrawal
  );

  RETURN QUERY SELECT
    v_live,
    v_available,
    GREATEST(0, v_pending)::bigint,
    v_withdrawal,
    GREATEST(0, v_debt)::bigint,
    GREATEST(0, v_unpaid_eligible)::bigint;
END;
$function$;


-- Edge payout state machine: service_role (+ postgres owner) only
REVOKE ALL ON FUNCTION public.claim_driver_payout_submission(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_driver_payout_submission(uuid, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_driver_payout_submission(uuid, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_driver_payout_submission(uuid, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_driver_payout_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_driver_payout_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_driver_payout_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_driver_payout_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.abort_driver_payout_submission_claim(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.abort_driver_payout_submission_claim(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.abort_driver_payout_submission_claim(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.abort_driver_payout_submission_claim(uuid, uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.reserve_driver_payout_item(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_driver_payout_item(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_driver_payout_item(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_driver_payout_item(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.release_driver_payout_reservation(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_driver_payout_reservation(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.release_driver_payout_reservation(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_driver_payout_reservation(uuid, uuid, text) TO service_role;

-- Keep finalize_driver_payout_completion authenticated-denied (already); reinforce grants
REVOKE ALL ON FUNCTION public.finalize_driver_payout_completion(uuid, text, text, timestamp with time zone, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_driver_payout_completion(uuid, text, text, timestamp with time zone, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_driver_payout_completion(uuid, text, text, timestamp with time zone, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_driver_payout_completion(uuid, text, text, timestamp with time zone, jsonb) TO service_role;

-- Cron money triggers: postgres owner only (no proven service_role SQL caller)
REVOKE ALL ON FUNCTION public.invoke_weekly_payout_scheduler() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_weekly_payout_scheduler() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_weekly_payout_scheduler() FROM authenticated;
REVOKE ALL ON FUNCTION public.invoke_weekly_payout_scheduler() FROM service_role;

REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM anon;
REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM authenticated;
REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM service_role;

COMMIT;
