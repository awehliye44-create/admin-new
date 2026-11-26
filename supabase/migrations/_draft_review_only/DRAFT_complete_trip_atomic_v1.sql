-- ============================================================================
-- DRAFT / REVIEW ONLY — #110 P2 atomic completion architecture.
--
--   *** STOP BEFORE PROD. DO NOT APPLY TO PRODUCTION. DO NOT DEPLOY. ***
--
-- This file lives in migrations/_draft_review_only/ so the migration runner
-- never picks it up. It is applied ONLY to the LOCAL isolated Postgres
-- (127.0.0.1:54329) by supabase/tests/complete_trip_atomic_v1_110_local.sh.
-- Cutover requires: stop-workflow wiring + Stage D parity proof + owner sign-off
-- (see blockers in the #110 P2 report). stop-workflow does NOT call this RPC yet.
--
-- WHAT ONE TRANSACTION DOES (all-or-nothing):
--   1. Row-lock the trip (FOR UPDATE) — serialises with tip submit / expiry /
--      invoice writers; they see either pre- or post-complete state, never half.
--   2. Mark trip completed (status + dispatch_status + completed_at + fare cols).
--      Idempotent: already-completed trip skips every trips write.
--   3. Stamp the tip window (TIP_WINDOW_MS = 20 min) ONLY when requested, the
--      fare is not already captured (MK-260926-001), and no window was ever
--      stamped. A stamped window is never reopened or extended.
--   4. Persist tripSettlementDbColumns(settlement) + tip columns.
--   5. Optionally stamp capture_requested (non-tip-window card path), never
--      regressing a finalised payment_status.
--   6. Insert exactly ONE TRIP_EARNING_PENDING by calling the existing
--      public.credit_trip_earning_pending (idempotent, PLATFORM_COLLECTED only).
--
-- WHAT IT NEVER DOES:
--   * No provider (Revolut) call — capture/increment stay in edge functions,
--     OUTSIDE this transaction.
--   * No Available/TEN write, no PENDING_RELEASE, no payout/ledger release.
--   * No rating / Rate Trip state — Driver Rate is independent of capture.
--   * No invoice columns, no RLS change, no guard removal, no payment_session
--     write, no payment_ssot_cutover change (Stage D stays true/true).
--   * No PENDING for DRIVER_COLLECTED_COMMISSION_WALLET (financial isolation).
--
-- The caller (edge function) still computes settlement via the TS SSOT
-- (calculateTripSettlementFromTripRow / tripSettlementDbColumns) and passes it
-- in p_settlement; SQL does not re-derive commission. The PENDING amount IS
-- derived in SQL from the persisted columns using the pendingEntitlementAmountPence
-- formula: max(0, driver_net_pence + airport_charge_pence).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_trip_atomic_v1(
  p_trip_id uuid,
  p_driver_id uuid,
  p_completed_at timestamptz,
  p_completion jsonb,
  p_settlement jsonb,
  p_tip_window_enabled boolean DEFAULT false,
  p_capture_mode text DEFAULT 'tip_window_defer',
  p_currency text DEFAULT 'GBP'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  -- TIP_WINDOW_MS (tipWindowConstants.ts) = 20 * 60 * 1000.
  c_tip_window interval := interval '20 minutes';
  v_trip record;
  v_after record;
  v_completed_at timestamptz := COALESCE(p_completed_at, now());
  v_already_completed boolean := false;
  v_tip_action text := 'not_requested';
  v_pending jsonb := NULL;
  v_pending_amount int := 0;
  v_financial_model text;
  v_payment_status text;
  v_finalised boolean;
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_ids');
  END IF;
  IF p_capture_mode NOT IN ('tip_window_defer', 'capture_requested', 'none') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_capture_mode');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_found');
  END IF;
  IF COALESCE(v_trip.driver_id, v_trip.confirmed_driver_id) IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'driver_mismatch');
  END IF;

  v_financial_model := upper(COALESCE(v_trip.financial_model::text, ''));
  IF v_financial_model NOT IN ('PLATFORM_COLLECTED', 'DRIVER_COLLECTED_COMMISSION_WALLET') THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: trip % has no valid financial_model', p_trip_id;
  END IF;

  v_payment_status := lower(COALESCE(v_trip.payment_status::text, ''));
  v_finalised := v_payment_status IN ('captured', 'paid', 'collected_cash');

  IF lower(COALESCE(v_trip.status::text, '')) = 'completed' THEN
    v_already_completed := true;
  ELSIF lower(COALESCE(v_trip.status::text, '')) IN
        ('cancelled', 'canceled', 'expired', 'no_show', 'rejected') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_completable',
                              'status', v_trip.status);
  END IF;
  -- Mirrors stop-workflow NOT_STARTED (an already-completed replay passes through).
  IF NOT v_already_completed AND v_trip.started_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_started');
  END IF;

  -- ── Steps 2–5: single trips UPDATE (was 2 sequential PostgREST UPDATEs) ──
  IF NOT v_already_completed THEN
    IF p_tip_window_enabled THEN
      IF v_trip.tip_window_opened_at IS NOT NULL OR v_trip.tip_window_expires_at IS NOT NULL THEN
        v_tip_action := 'already_stamped_kept'; -- never reopen / extend
      ELSIF v_finalised THEN
        v_tip_action := 'skipped_fare_captured'; -- MK-260926-001
      ELSE
        v_tip_action := 'opened';
      END IF;
    END IF;

    UPDATE public.trips t SET
      status = 'completed',
      dispatch_status = 'completed',
      completed_at = v_completed_at,
      -- completion (from resolvedFare in stop-workflow)
      fare = COALESCE((p_completion->>'fare')::numeric, t.fare),
      estimated_fare = COALESCE((p_completion->>'estimated_fare')::numeric, t.estimated_fare),
      final_fare_pence = COALESCE((p_settlement->>'final_fare_pence')::int,
                                  (p_completion->>'final_fare_pence')::int, t.final_fare_pence),
      final_customer_fare_pence = COALESCE((p_completion->>'final_customer_fare_pence')::int,
                                           t.final_customer_fare_pence),
      pickup_waiting_charge_pence = COALESCE((p_completion->>'pickup_waiting_charge_pence')::int,
                                             t.pickup_waiting_charge_pence),
      stop_waiting_charge_pence = COALESCE((p_completion->>'stop_waiting_charge_pence')::int,
                                           t.stop_waiting_charge_pence),
      stop_charge_total_pence = COALESCE((p_completion->>'stop_charge_total_pence')::int,
                                         t.stop_charge_total_pence),
      total_waiting_charge_pence = COALESCE((p_completion->>'total_waiting_charge_pence')::int,
                                            t.total_waiting_charge_pence),
      waiting_charge_pence = COALESCE((p_completion->>'waiting_charge_pence')::int,
                                      t.waiting_charge_pence),
      provider_order_id = CASE
        WHEN NULLIF(trim(COALESCE(t.provider_order_id, '')), '') IS NULL
          THEN COALESCE(NULLIF(trim(p_completion->>'provider_order_id'), ''), t.provider_order_id)
        ELSE t.provider_order_id END,
      -- settlement (tripSettlementDbColumns)
      commissionable_fare_pence = COALESCE((p_settlement->>'commissionable_fare_pence')::int,
                                           t.commissionable_fare_pence),
      commission_pence = COALESCE((p_settlement->>'commission_pence')::int, t.commission_pence),
      driver_net_pence = COALESCE((p_settlement->>'driver_net_pence')::int, t.driver_net_pence),
      driver_net_before_tip_pence = COALESCE((p_settlement->>'driver_net_before_tip_pence')::int,
                                             t.driver_net_before_tip_pence),
      driver_total_earnings_pence = COALESCE((p_settlement->>'driver_total_earnings_pence')::int,
                                             t.driver_total_earnings_pence),
      airport_charge_pence = COALESCE((p_settlement->>'airport_charge_pence')::int,
                                      t.airport_charge_pence),
      tip_pence = COALESCE((p_settlement->>'tip_pence')::int, t.tip_pence),
      tip_amount_pence = COALESCE((p_settlement->>'tip_amount_pence')::int, t.tip_amount_pence),
      commission_pct = COALESCE((p_settlement->>'commission_pct')::numeric, t.commission_pct),
      driver_tier_commission_percent = COALESCE(
        (p_settlement->>'driver_tier_commission_percent')::numeric,
        t.driver_tier_commission_percent),
      gross_fare_pence = COALESCE((p_settlement->>'gross_fare_pence')::int, t.gross_fare_pence),
      provider_fee_pence = CASE WHEN p_settlement ? 'provider_fee_pence'
        THEN (p_settlement->>'provider_fee_pence')::int ELSE t.provider_fee_pence END,
      onecab_net_pence = COALESCE((p_settlement->>'onecab_net_pence')::int, t.onecab_net_pence),
      platform_gross_revenue_pence = COALESCE((p_settlement->>'platform_gross_revenue_pence')::int,
                                              t.platform_gross_revenue_pence),
      platform_net_revenue_pence = COALESCE((p_settlement->>'platform_net_revenue_pence')::int,
                                            t.platform_net_revenue_pence),
      settlement_formula_version = COALESCE(p_settlement->>'settlement_formula_version',
                                            t.settlement_formula_version),
      -- tip window (only when 'opened'; otherwise columns untouched)
      tip_window_opened_at = CASE WHEN v_tip_action = 'opened' THEN v_completed_at
                                  ELSE t.tip_window_opened_at END,
      tip_window_expires_at = CASE WHEN v_tip_action = 'opened' THEN v_completed_at + c_tip_window
                                   ELSE t.tip_window_expires_at END,
      tip_window_status = CASE WHEN v_tip_action = 'opened' THEN 'open'
                               ELSE t.tip_window_status END,
      tip_window_closed_at = CASE WHEN v_tip_action = 'opened' THEN NULL
                                  ELSE t.tip_window_closed_at END,
      -- durable capture queue stamp (non-tip-window card path); never regress finalised
      payment_status = CASE WHEN p_capture_mode = 'capture_requested' AND NOT v_finalised
                            THEN 'capture_requested' ELSE t.payment_status END,
      payment_hold_status = CASE WHEN p_capture_mode = 'capture_requested' AND NOT v_finalised
                                 THEN 'capture_requested' ELSE t.payment_hold_status END,
      updated_at = now()
    WHERE t.id = p_trip_id;
  END IF;

  SELECT id, status, dispatch_status, completed_at, driver_net_pence, airport_charge_pence,
         tip_window_opened_at, tip_window_expires_at, tip_window_status, tip_window_closed_at,
         payment_status
  INTO v_after FROM public.trips WHERE id = p_trip_id;

  -- ── Step 6: exactly one PENDING via the existing idempotent RPC ──
  IF v_financial_model = 'PLATFORM_COLLECTED' THEN
    v_pending_amount := GREATEST(
      0,
      COALESCE(v_after.driver_net_pence, 0) + COALESCE(v_after.airport_charge_pence, 0)
    );
    IF v_pending_amount > 0 THEN
      v_pending := public.credit_trip_earning_pending(
        p_trip_id, p_driver_id, v_pending_amount, p_currency,
        'Trip earning pending payment confirmation'
      );
      -- Soft failure rolls the whole transaction back: never completed-without-PENDING
      -- for a platform-collected trip. Caller may retry or fall back to legacy path.
      IF COALESCE((v_pending->>'ok')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'COMPLETE_TRIP_ATOMIC_PENDING_FAILED: %', v_pending
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', v_already_completed,
    'trip_id', p_trip_id,
    'status', v_after.status,
    'completed_at', v_after.completed_at,
    'tip_window_action', v_tip_action,
    'tip_window_expires_at', v_after.tip_window_expires_at,
    'tip_window_status', v_after.tip_window_status,
    'pending_amount_pence', v_pending_amount,
    'pending', v_pending,
    'financial_model', v_financial_model
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_trip_atomic_v1(uuid, uuid, timestamptz, jsonb, jsonb, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_trip_atomic_v1(uuid, uuid, timestamptz, jsonb, jsonb, boolean, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_trip_atomic_v1(uuid, uuid, timestamptz, jsonb, jsonb, boolean, text, text) TO service_role;

COMMENT ON FUNCTION public.complete_trip_atomic_v1(uuid, uuid, timestamptz, jsonb, jsonb, boolean, text, text) IS
  'DRAFT #110 P2 — atomic trip completion + settlement + tip-window stamp + single PENDING. LOCAL ONLY. No provider calls. Not wired into stop-workflow.';
