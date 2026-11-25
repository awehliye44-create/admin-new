-- #93B / #98 — TRIP_EARNING_PENDING → RELEASE → TEN (append-only).
-- PENDING is visible earned entitlement awaiting payment confirmation.
-- Never payout-eligible; never starts 27h clearing. No historical backfill.

BEGIN;

ALTER TABLE public.driver_wallet_ledger DROP CONSTRAINT IF EXISTS driver_wallet_ledger_type_check;
ALTER TABLE public.driver_wallet_ledger ADD CONSTRAINT driver_wallet_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET'::text,
    'TRIP_EARNING_PENDING'::text,
    'TRIP_EARNING_PENDING_RELEASE'::text,
    'CASH_TRIP_EARNING'::text,
    'CASH_COMMISSION_DEBT'::text,
    'DRIVER_TIP_CREDIT'::text,
    'TIP_CREDIT'::text,
    'PLATFORM_COMMISSION'::text,
    'COMPANY_COMMISSION'::text,
    'WEEKLY_PAYOUT'::text,
    'EARLY_CASHOUT'::text,
    'CASHOUT_FEE'::text,
    'ADJUSTMENT'::text,
    'REFUND_DEBIT'::text,
    'PAYOUT'::text,
    'MANUAL_PAYOUT'::text,
    'BONUS'::text,
    'DEBT_RECOVERY'::text,
    'COMMISSION_RECOVERED'::text,
    'LEDGER_REVERSAL'::text,
    'PAYOUT_FAILED_RETURN'::text,
    'PAYOUT_RESERVATION_HOLD'::text,
    'PAYOUT_RESERVATION_RELEASE'::text,
    'ADMIN_WALLET_CREDIT'::text,
    'ADMIN_WALLET_DEBIT'::text,
    'NO_SHOW_FEE'::text,
    'DRIVER_COMPENSATION_CREDIT'::text
  ]));

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_trip_earning_pending_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'TRIP_EARNING_PENDING' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_trip_earning_pending_release_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'TRIP_EARNING_PENDING_RELEASE' AND related_trip_id IS NOT NULL;

COMMENT ON COLUMN public.driver_wallet_ledger.type IS
  'Append-only ledger type. TRIP_EARNING_PENDING = pre-capture earned net (not withdrawable). '
  'TRIP_EARNING_PENDING_RELEASE offsets PENDING before TRIP_EARNING_NET. Never DELETE history.';

-- Refuse PENDING when TEN already exists; refuse RELEASE without matching PENDING amount.
CREATE OR REPLACE FUNCTION public.driver_wallet_ledger_pending_entitlement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_ten_count int;
  v_pending_amount int;
BEGIN
  IF NEW.type = 'TRIP_EARNING_PENDING' AND NEW.related_trip_id IS NOT NULL THEN
    IF COALESCE(NEW.amount_pence, 0) <= 0 THEN
      RAISE EXCEPTION 'TRIP_EARNING_PENDING_AMOUNT_INVALID'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*)::int INTO v_ten_count
    FROM public.driver_wallet_ledger
    WHERE related_trip_id = NEW.related_trip_id
      AND type = 'TRIP_EARNING_NET';
    IF v_ten_count > 0 THEN
      RAISE EXCEPTION 'TRIP_EARNING_PENDING_AFTER_TEN_FORBIDDEN'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.type = 'TRIP_EARNING_PENDING_RELEASE' AND NEW.related_trip_id IS NOT NULL THEN
    IF COALESCE(NEW.amount_pence, 0) >= 0 THEN
      RAISE EXCEPTION 'TRIP_EARNING_PENDING_RELEASE_MUST_BE_NEGATIVE'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT amount_pence INTO v_pending_amount
    FROM public.driver_wallet_ledger
    WHERE related_trip_id = NEW.related_trip_id
      AND type = 'TRIP_EARNING_PENDING'
    LIMIT 1;
    IF v_pending_amount IS NULL THEN
      RAISE EXCEPTION 'TRIP_EARNING_PENDING_RELEASE_WITHOUT_PENDING'
        USING ERRCODE = 'check_violation';
    END IF;
    IF ABS(NEW.amount_pence) IS DISTINCT FROM ABS(v_pending_amount) THEN
      RAISE EXCEPTION 'TRIP_EARNING_PENDING_RELEASE_AMOUNT_MISMATCH'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_driver_wallet_ledger_pending_entitlement_guard
  ON public.driver_wallet_ledger;

CREATE TRIGGER trg_driver_wallet_ledger_pending_entitlement_guard
  BEFORE INSERT ON public.driver_wallet_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.driver_wallet_ledger_pending_entitlement_guard();

REVOKE ALL ON FUNCTION public.driver_wallet_ledger_pending_entitlement_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_ledger_pending_entitlement_guard() FROM anon, authenticated;

-- Idempotent PENDING credit (service_role). Amount = driver_net + airport (same as TEN).
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
  IF lower(COALESCE(v_trip.status, '')) <> 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_completed');
  END IF;
  IF upper(COALESCE(v_trip.financial_model, '')) <> 'PLATFORM_COLLECTED' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_financial_model');
  END IF;
  IF COALESCE(v_trip.driver_id, v_trip.confirmed_driver_id) IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'driver_mismatch');
  END IF;

  -- Already confirmed TEN → no PENDING.
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
END;
$$;

REVOKE ALL ON FUNCTION public.credit_trip_earning_pending(uuid, uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.credit_trip_earning_pending(uuid, uuid, integer, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_trip_earning_pending(uuid, uuid, integer, text, text) TO service_role;


-- #98: include PENDING/RELEASE in driver earning rows RPC
-- auto patch fragment
CREATE OR REPLACE FUNCTION public.get_driver_own_wallet_earning_rows(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS TABLE(ledger_entry_id uuid, related_trip_id uuid, amount_pence bigint, type text, description text, posting_created_at timestamp with time zone, economic_earned_at timestamp with time zone, economic_date_status text, captured_at timestamp with time zone, eligible_at timestamp with time zone, clearing_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_role text := public.driver_wallet_jwt_role();
  v_driver_id uuid;
  v_pad interval := interval '45 days';
BEGIN
  IF v_role IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    dwl.id::uuid AS ledger_entry_id,
    dwl.related_trip_id::uuid AS related_trip_id,
    dwl.amount_pence::bigint AS amount_pence,
    dwl.type::text AS type,
    dwl.description::text AS description,
    r.posting_created_at,
    r.economic_earned_at,
    r.economic_date_status::text AS economic_date_status,
    r.captured_at,
    r.eligible_at,
    r.clearing_status::text AS clearing_status
  FROM public.driver_wallet_ledger dwl
  CROSS JOIN LATERAL public.driver_wallet_resolve_economic_date(
    dwl.type, dwl.related_trip_id, dwl.created_at
  ) r
  WHERE dwl.driver_id = v_driver_id
    AND dwl.type IN ('TRIP_EARNING_NET', 'TRIP_EARNING_PENDING', 'TRIP_EARNING_PENDING_RELEASE', 'DRIVER_TIP_CREDIT', 'NO_SHOW_FEE', 'BONUS', 'REFUND_DEBIT')
    AND dwl.created_at >= (p_start - v_pad)
    AND dwl.created_at < (p_end + v_pad);
END;
$function$
;

COMMIT;
