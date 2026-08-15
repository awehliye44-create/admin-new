-- Pending = captured PLATFORM_COLLECTED earnings not yet payout-cleared.
-- Cancelled, voided, and authorised-only credits are not Pending.

BEGIN;

CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances(p_driver_id uuid)
RETURNS TABLE (
  live_balance_pence bigint,
  available_balance_pence bigint,
  pending_balance_pence bigint,
  withdrawal_in_progress_pence bigint,
  outstanding_debt_pence bigint,
  eligible_earnings_pence bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_live bigint := 0;
  v_debt bigint := 0;
  v_reserved bigint := 0;
  v_in_flight bigint := 0;
  v_withdrawal bigint := 0;
  v_eligible bigint := 0;
  v_pending bigint := 0;
  v_available bigint := 0;
  v_delay_hours numeric := 48;
  v_payouts_enabled boolean := true;
  r record;
  v_captured bigint;
  v_canonical bigint;
  v_refunded bigint;
  v_session_status text;
  v_allocated bigint;
  v_model text;
  v_method text;
  v_requires_clearing boolean;
  v_cleared boolean;
  v_origin timestamptz;
BEGIN
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
      t.driver_net_pence,
      t.tip_pence,
      t.tip_amount_pence,
      t.provider_available_on AS trip_provider_available_on,
      ps.id AS session_id,
      ps.captured_amount_pence,
      ps.captured_at,
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
      WHERE a.ledger_entry_id = l.id
    ) alloc ON true
    WHERE l.driver_id = p_driver_id
      AND l.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'TIP_CREDIT')
      AND l.amount_pence > 0
  LOOP
    IF r.paid_in_batch_id IS NOT NULL OR r.allocated_to_payout IS TRUE THEN
      CONTINUE;
    END IF;
    v_allocated := GREATEST(
      COALESCE(r.alloc_sum, 0),
      COALESCE(r.allocated_amount_pence, 0)
    );
    IF v_allocated >= r.amount_pence THEN
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

    -- Uncaptured / authorised-only is not settlement Pending.
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
        v_origin := COALESCE(r.captured_at, r.capture_time, r.created_at);
        IF v_origin IS NOT NULL
           AND (v_origin + (v_delay_hours * interval '1 hour')) <= now() THEN
          v_cleared := true;
        END IF;
      END IF;
    END IF;

    IF v_cleared THEN
      v_eligible := v_eligible + r.amount_pence;
    ELSE
      v_pending := v_pending + r.amount_pence;
    END IF;
  END LOOP;

  v_available := GREATEST(
    0,
    LEAST(GREATEST(0, v_live), v_eligible) - GREATEST(0, v_debt) - v_withdrawal
  );

  RETURN QUERY SELECT
    v_live,
    v_available,
    GREATEST(0, v_pending)::bigint,
    v_withdrawal,
    GREATEST(0, v_debt)::bigint,
    GREATEST(0, v_eligible)::bigint;
END;
$$;

GRANT EXECUTE ON FUNCTION public.driver_wallet_eligibility_balances(uuid) TO authenticated, service_role;

COMMIT;
