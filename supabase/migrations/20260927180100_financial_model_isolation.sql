-- Hard isolation of PLATFORM_COLLECTED vs DRIVER_COLLECTED_COMMISSION_WALLET.
-- Trip model is stamped at insert, then immutable. No live SA fallback on writes.
-- 80050 may already have installed trg_00 while the column was still nullable.
-- This file backfills remaining nulls, then NOT NULL + immutability + guards.
-- Development/test data: reverse Banadir DWL cash anomalies,
-- do not auto-deduct historical completed trips, do not touch ADMIN_CREDIT.
-- Requires 20260927180000_commission_subsidy_credit_enum.sql.

-- ── 1) Kampala: intended Driver-Collected pairing ───────────────────────────
UPDATE public.service_areas
SET
  customer_payment_policy = 'DRIVER_COLLECTS_UPFRONT',
  commission_wallet_enabled = true,
  financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET',
  updated_at = now()
WHERE name = 'Kampala'
  AND (
    customer_payment_policy IS DISTINCT FROM 'DRIVER_COLLECTS_UPFRONT'
    OR commission_wallet_enabled IS DISTINCT FROM true
    OR financial_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET'
  );

-- ── 2) Valid SA pairing CHECK ───────────────────────────────────────────────
-- Normalize live SA rows to the two legal pairings before tightening CHECK.
UPDATE public.service_areas
SET
  customer_payment_policy = 'PLATFORM_PREPAID',
  commission_wallet_enabled = false,
  commission_reserve_enabled = false,
  updated_at = now()
WHERE financial_model = 'PLATFORM_COLLECTED'
  AND (
    customer_payment_policy IS DISTINCT FROM 'PLATFORM_PREPAID'
    OR commission_wallet_enabled IS DISTINCT FROM false
    OR commission_reserve_enabled IS DISTINCT FROM false
  );

UPDATE public.service_areas
SET
  customer_payment_policy = 'DRIVER_COLLECTS_UPFRONT',
  commission_wallet_enabled = true,
  updated_at = now()
WHERE financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
  AND (
    customer_payment_policy IS DISTINCT FROM 'DRIVER_COLLECTS_UPFRONT'
    OR commission_wallet_enabled IS DISTINCT FROM true
  );

ALTER TABLE public.service_areas
  DROP CONSTRAINT IF EXISTS service_areas_commission_wallet_model_consistency;

ALTER TABLE public.service_areas
  ADD CONSTRAINT service_areas_commission_wallet_model_consistency
  CHECK (
    (
      financial_model = 'PLATFORM_COLLECTED'
      AND customer_payment_policy = 'PLATFORM_PREPAID'
      AND commission_wallet_enabled = false
      AND commission_reserve_enabled = false
    )
    OR (
      financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
      AND customer_payment_policy = 'DRIVER_COLLECTS_UPFRONT'
      AND commission_wallet_enabled = true
    )
  );

-- ── 3) Backfill development/test trips from SA at this moment ───────────────
UPDATE public.trips t
SET
  financial_model = sa.financial_model,
  payment_collection_model = sa.customer_payment_policy,
  commission_wallet_enabled = sa.commission_wallet_enabled,
  updated_at = now()
FROM public.service_areas sa
WHERE t.service_area_id = sa.id
  AND t.financial_model IS NULL;

DO $$
DECLARE
  v_null integer;
BEGIN
  SELECT count(*) INTO v_null FROM public.trips WHERE financial_model IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'financial_model backfill left % trips null', v_null;
  END IF;
END $$;

ALTER TABLE public.trips
  ALTER COLUMN financial_model SET NOT NULL;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_financial_model_valid_chk;
ALTER TABLE public.trips
  ADD CONSTRAINT trips_financial_model_valid_chk
  CHECK (
    financial_model IN (
      'PLATFORM_COLLECTED',
      'DRIVER_COLLECTED_COMMISSION_WALLET'
    )
  );

COMMENT ON COLUMN public.trips.financial_model IS
  'Immutable pipeline stamp at trip insert. PLATFORM_COLLECTED | DRIVER_COLLECTED_COMMISSION_WALLET. Never null. Never derived later from live SA.';

-- ── 4) Insert stamp + immutability ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stamp_trip_financial_model_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sa public.service_areas%ROWTYPE;
BEGIN
  IF NEW.service_area_id IS NULL THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: service_area_id required to stamp financial_model'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = NEW.service_area_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: service area not found'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.financial_model IS NULL THEN
    NEW.financial_model := v_sa.financial_model;
    NEW.payment_collection_model := COALESCE(NEW.payment_collection_model, v_sa.customer_payment_policy);
    NEW.commission_wallet_enabled := COALESCE(NEW.commission_wallet_enabled, v_sa.commission_wallet_enabled);
  END IF;

  IF NEW.financial_model IS DISTINCT FROM v_sa.financial_model THEN
    RAISE EXCEPTION
      'FINANCIAL_MODEL_VIOLATION: trip financial_model % does not match service area % at insert',
      NEW.financial_model, v_sa.financial_model
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.financial_model = 'PLATFORM_COLLECTED' THEN
    NEW.payment_collection_model := 'PLATFORM_PREPAID';
    NEW.commission_wallet_enabled := false;
  ELSIF NEW.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    NEW.payment_collection_model := 'DRIVER_COLLECTS_UPFRONT';
    NEW.commission_wallet_enabled := true;
  ELSE
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: invalid financial_model %', NEW.financial_model
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Alphabetical BEFORE INSERT order: stamp (00) must run before reserve (10).
DROP TRIGGER IF EXISTS trg_stamp_trip_financial_model_on_insert ON public.trips;
DROP TRIGGER IF EXISTS trg_00_stamp_trip_financial_model_on_insert ON public.trips;
CREATE TRIGGER trg_00_stamp_trip_financial_model_on_insert
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_trip_financial_model_on_insert();

CREATE OR REPLACE FUNCTION public.enforce_trip_financial_model_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.financial_model IS DISTINCT FROM OLD.financial_model
     OR NEW.payment_collection_model IS DISTINCT FROM OLD.payment_collection_model
     OR NEW.commission_wallet_enabled IS DISTINCT FROM OLD.commission_wallet_enabled THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: trip financial model is immutable after insert'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_trip_cw_snapshot_immutable ON public.trips;
DROP TRIGGER IF EXISTS trg_enforce_trip_financial_model_immutable ON public.trips;
CREATE TRIGGER trg_enforce_trip_financial_model_immutable
  BEFORE UPDATE OF financial_model, payment_collection_model, commission_wallet_enabled
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trip_financial_model_immutable();

-- Snapshot-only classifier. Never reads live service_areas.
CREATE OR REPLACE FUNCTION public.trip_row_is_commission_wallet_driver_collected(p_row trips)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_row.financial_model::text, '') = 'DRIVER_COLLECTED_COMMISSION_WALLET'
     AND COALESCE(p_row.commission_wallet_enabled, false) IS TRUE;
$$;

-- ── 5) Balance parts: reserves reduce usable; subsidy is promotional credit ─
CREATE OR REPLACE FUNCTION public.driver_commission_wallet_balance_parts(
  p_driver_id uuid,
  p_service_area_id uuid
)
RETURNS TABLE (
  purchased_balance_minor integer,
  promotional_balance_minor integer,
  reserved_balance_minor integer,
  usable_commission_balance_minor integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_purchased integer := 0;
  v_promotional integer := 0;
  v_reserved integer := 0;
  v_amount integer;
  v_promo_part integer;
  v_purchased_part integer;
  v_need integer;
  v_from_promo integer;
BEGIN
  IF p_driver_id IS NULL OR p_service_area_id IS NULL THEN
    purchased_balance_minor := 0;
    promotional_balance_minor := 0;
    reserved_balance_minor := 0;
    usable_commission_balance_minor := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR r IN
    SELECT
      entry_type::text AS entry_type,
      amount_minor,
      direction,
      COALESCE(promotional_portion_minor, 0) AS promotional_portion_minor,
      COALESCE(purchased_portion_minor, 0) AS purchased_portion_minor
    FROM public.driver_commission_wallet_ledger
    WHERE driver_id = p_driver_id
      AND service_area_id = p_service_area_id
    ORDER BY created_at ASC, id ASC
  LOOP
    v_amount := GREATEST(0, COALESCE(r.amount_minor, 0));

    IF r.entry_type = 'TOP_UP_CREDIT' THEN
      v_purchased := v_purchased + v_amount;
    ELSIF r.entry_type = 'TOP_UP_REVERSAL' THEN
      v_purchased := v_purchased - v_amount;
    ELSIF r.entry_type IN ('WELCOME_CREDIT', 'PROMOTIONAL_CREDIT', 'ADMIN_CREDIT', 'COMMISSION_SUBSIDY_CREDIT') THEN
      IF r.direction = 'debit' THEN
        v_promotional := v_promotional - v_amount;
      ELSE
        v_promotional := v_promotional + v_amount;
      END IF;
    ELSIF r.entry_type = 'ADMIN_CORRECTION' THEN
      IF r.direction = 'debit' THEN
        v_promotional := v_promotional - v_amount;
      ELSE
        v_promotional := v_promotional + v_amount;
      END IF;
    ELSIF r.entry_type = 'COMMISSION_RESERVE' THEN
      v_reserved := v_reserved + v_amount;
    ELSIF r.entry_type = 'COMMISSION_RESERVE_RELEASE' THEN
      v_reserved := GREATEST(0, v_reserved - v_amount);
    ELSIF r.entry_type = 'COMMISSION_DEDUCTION' THEN
      v_promo_part := GREATEST(0, r.promotional_portion_minor);
      v_purchased_part := GREATEST(0, r.purchased_portion_minor);
      IF v_promo_part + v_purchased_part > 0 THEN
        v_promotional := v_promotional - v_promo_part;
        v_purchased := v_purchased - v_purchased_part;
      ELSE
        v_need := v_amount;
        v_from_promo := LEAST(v_need, GREATEST(0, v_promotional));
        v_promotional := v_promotional - v_from_promo;
        v_purchased := v_purchased - (v_need - v_from_promo);
      END IF;
    ELSIF r.entry_type = 'COMMISSION_DEDUCTION_REVERSAL' THEN
      v_promo_part := GREATEST(0, r.promotional_portion_minor);
      v_purchased_part := GREATEST(0, r.purchased_portion_minor);
      v_promotional := v_promotional + COALESCE(NULLIF(v_promo_part, 0), v_amount);
      v_purchased := v_purchased + v_purchased_part;
    END IF;
  END LOOP;

  purchased_balance_minor := v_purchased;
  promotional_balance_minor := v_promotional;
  reserved_balance_minor := v_reserved;
  usable_commission_balance_minor := (v_purchased + v_promotional) - v_reserved;
  RETURN NEXT;
END;
$$;

-- ── 6) Atomic reservation ───────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_reserves_active_trip_uidx
  ON public.driver_commission_wallet_reserves (trip_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_ledger_trip_reserve_uidx
  ON public.driver_commission_wallet_ledger (trip_id)
  WHERE entry_type = 'COMMISSION_RESERVE' AND trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_ledger_trip_deduction_uidx
  ON public.driver_commission_wallet_ledger (trip_id)
  WHERE entry_type = 'COMMISSION_DEDUCTION' AND trip_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.is_commission_wallet_reserve_enabled(p_service_area_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Reservation is a trip-pipeline operation. SA helper kept for dispatch listing
  -- only; assignment uses the trip stamp.
  SELECT EXISTS (
    SELECT 1 FROM public.service_areas sa
    WHERE sa.id = p_service_area_id
      AND sa.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
      AND sa.commission_wallet_enabled = true
      AND sa.customer_payment_policy = 'DRIVER_COLLECTS_UPFRONT'
  );
$$;

CREATE OR REPLACE FUNCTION public.reserve_driver_commission_wallet(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_sa public.service_areas%ROWTYPE;
  v_existing uuid;
  v_fare_minor integer;
  v_pct numeric;
  v_rate_bps integer;
  v_required integer;
  v_balance integer;
  v_currency text;
  v_ledger_id uuid;
  v_parts record;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS');
  END IF;

  PERFORM 1 FROM public.drivers WHERE id = p_driver_id FOR UPDATE;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TRIP_NOT_FOUND');
  END IF;

  IF v_trip.financial_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: Commission Wallet reservation forbidden on %',
      v_trip.financial_model
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = v_trip.service_area_id;

  INSERT INTO public.driver_commission_wallet_accounts (
    driver_id, service_area_id, region_id, currency, source
  )
  SELECT
    p_driver_id,
    v_trip.service_area_id,
    COALESCE(v_sa.region_id, v_trip.region_id),
    UPPER(COALESCE(NULLIF(v_sa.commission_wallet_currency, ''), NULLIF(v_sa.currency_code, ''), 'USD')),
    'auto_assignment'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.driver_commission_wallet_accounts a
    WHERE a.driver_id = p_driver_id AND a.service_area_id = v_trip.service_area_id
  );

  PERFORM 1
  FROM public.driver_commission_wallet_accounts
  WHERE driver_id = p_driver_id
    AND service_area_id = v_trip.service_area_id
  FOR UPDATE;

  SELECT id INTO v_existing
  FROM public.driver_commission_wallet_reserves
  WHERE trip_id = p_trip_id
    AND status = 'active'
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'code', 'ALREADY_RESERVED', 'reserve_id', v_existing);
  END IF;

  v_fare_minor := public.trip_commission_reserve_fare_minor(v_trip);
  v_pct := COALESCE(
    NULLIF(v_trip.accepted_commission_percent, 0),
    NULLIF(v_trip.driver_tier_commission_percent, 0),
    public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id),
    0
  );
  v_rate_bps := GREATEST(
    0,
    COALESCE(NULLIF(v_trip.snapshotted_commission_rate_bps, 0), ROUND(v_pct * 100)::integer)
  );
  v_required := public.required_commission_reserve_minor(v_fare_minor, v_rate_bps);

  SELECT * INTO v_parts
  FROM public.driver_commission_wallet_balance_parts(p_driver_id, v_trip.service_area_id);
  v_balance := COALESCE(v_parts.usable_commission_balance_minor, 0);

  IF v_required > 0 AND v_balance < v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INSUFFICIENT_COMMISSION_WALLET_BALANCE',
      'required_minor', v_required,
      'usable_minor', v_balance
    );
  END IF;

  IF v_required <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'ZERO_RESERVE');
  END IF;

  v_currency := UPPER(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    NULLIF(v_trip.snapshotted_commission_currency, ''),
    'USD'
  ));

  INSERT INTO public.driver_commission_wallet_ledger (
    driver_id, service_area_id, region_id, currency, entry_type, amount_minor, direction,
    trip_id, reason, promotional_portion_minor, purchased_portion_minor, idempotency_key, metadata
  ) VALUES (
    p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
    'COMMISSION_RESERVE', v_required, 'debit', p_trip_id,
    'Atomic assignment reservation',
    0, 0,
    left('cw_reserve_' || p_trip_id::text || '_' || (
      SELECT (count(*) + 1)::text
      FROM public.driver_commission_wallet_ledger
      WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_RESERVE'
    ), 180),
    jsonb_build_object('required_minor', v_required, 'usable_before_minor', v_balance)
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_ledger_id;

  INSERT INTO public.driver_commission_wallet_reserves (
    driver_id, service_area_id, trip_id, currency, reserved_amount_minor, status, reserve_ledger_entry_id
  ) VALUES (
    p_driver_id, v_trip.service_area_id, p_trip_id, v_currency, v_required, 'active', v_ledger_id
  )
  ON CONFLICT (driver_id, trip_id) DO UPDATE SET
    status = 'active',
    reserved_amount_minor = EXCLUDED.reserved_amount_minor,
    currency = EXCLUDED.currency,
    reserve_ledger_entry_id = COALESCE(EXCLUDED.reserve_ledger_entry_id, public.driver_commission_wallet_reserves.reserve_ledger_entry_id),
    updated_at = now()
  WHERE public.driver_commission_wallet_reserves.status IS DISTINCT FROM 'active';

  RETURN jsonb_build_object(
    'ok', true,
    'amount_minor', v_required,
    'ledger_entry_id', v_ledger_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_driver_commission_wallet(
  p_driver_id uuid,
  p_trip_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_sa public.service_areas%ROWTYPE;
  v_reserve public.driver_commission_wallet_reserves%ROWTYPE;
  v_currency text;
  v_ledger_id uuid;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TRIP_NOT_FOUND');
  END IF;

  SELECT * INTO v_reserve
  FROM public.driver_commission_wallet_reserves
  WHERE trip_id = p_trip_id
    AND status = 'active'
  FOR UPDATE
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'NO_ACTIVE_RESERVE');
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = v_trip.service_area_id;
  v_currency := v_reserve.currency;

  INSERT INTO public.driver_commission_wallet_ledger (
    driver_id, service_area_id, region_id, currency, entry_type, amount_minor, direction,
    trip_id, reason, promotional_portion_minor, purchased_portion_minor, idempotency_key, metadata
  ) VALUES (
    v_reserve.driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
    'COMMISSION_RESERVE_RELEASE', v_reserve.reserved_amount_minor, 'credit', p_trip_id,
    COALESCE(p_reason, 'Reservation released'),
    0, 0,
    left('cw_reserve_release_' || v_reserve.id::text, 180),
    jsonb_build_object('released_minor', v_reserve.reserved_amount_minor)
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_ledger_id;

  UPDATE public.driver_commission_wallet_reserves
  SET
    status = 'released',
    release_ledger_entry_id = v_ledger_id,
    updated_at = now()
  WHERE id = v_reserve.id
    AND status = 'active';

  RETURN jsonb_build_object('ok', true, 'amount_minor', v_reserve.reserved_amount_minor);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_commission_wallet_on_trip_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NEW.driver_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.driver_id IS NOT DISTINCT FROM NEW.driver_id THEN
    RETURN NEW;
  END IF;
  IF NEW.financial_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN NEW;
  END IF;

  v_result := public.reserve_driver_commission_wallet(NEW.driver_id, NEW.id);
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '%', COALESCE(v_result->>'code', 'COMMISSION_WALLET_RESERVE_FAILED')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_wallet_on_trip_assignment ON public.trips;
DROP TRIGGER IF EXISTS trg_10_commission_wallet_on_trip_assignment ON public.trips;
CREATE TRIGGER trg_10_commission_wallet_on_trip_assignment
  BEFORE INSERT OR UPDATE OF driver_id
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_commission_wallet_on_trip_assignment();

-- ── 7) Completion: convert reserve → one deduction or subsidy. No swallow. ──
CREATE OR REPLACE FUNCTION public.convert_driver_commission_wallet_on_trip_complete(
  p_driver_id uuid,
  p_trip_id uuid,
  p_commission_minor integer DEFAULT NULL::integer,
  p_commissionable_fare_minor integer DEFAULT NULL::integer,
  p_commission_rate_bps integer DEFAULT NULL::integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_sa public.service_areas%ROWTYPE;
  v_existing_deduction_id uuid;
  v_existing_subsidy_id uuid;
  v_fare_minor integer;
  v_airport integer;
  v_pass_through integer;
  v_commissionable integer;
  v_rate_bps integer;
  v_pct numeric;
  v_gross integer;
  v_promo integer;
  v_effect integer;
  v_parts record;
  v_from_promo integer;
  v_from_purchased integer;
  v_currency text;
  v_ledger_id uuid;
  v_balance_before integer;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'skipped', true, 'code', 'INVALID_ARGS');
  END IF;

  PERFORM 1 FROM public.drivers WHERE id = p_driver_id FOR UPDATE;
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TRIP_NOT_FOUND');
  END IF;

  IF NOT public.trip_row_is_commission_wallet_driver_collected(v_trip) THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: Commission Wallet deduction/subsidy forbidden on %',
      COALESCE(v_trip.financial_model::text, 'null')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_existing_deduction_id
  FROM public.driver_commission_wallet_ledger
  WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_DEDUCTION'
  LIMIT 1;
  SELECT id INTO v_existing_subsidy_id
  FROM public.driver_commission_wallet_ledger
  WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_SUBSIDY_CREDIT'
  LIMIT 1;
  IF v_existing_deduction_id IS NOT NULL OR v_existing_subsidy_id IS NOT NULL THEN
    PERFORM public.release_driver_commission_wallet(p_driver_id, p_trip_id, 'already_settled');
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'code', 'ALREADY_DEDUCTED');
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = v_trip.service_area_id;

  -- Customer trip promotion is NOT Admin Commission Wallet credit.
  -- gross = pre-promotion commissionable × rate; effect = gross − locked promo.
  v_promo := GREATEST(0, COALESCE(v_trip.offer_discount_pence, 0), COALESCE(v_trip.discount_pence, 0));
  v_fare_minor := GREATEST(
    0,
    COALESCE(
      NULLIF(v_trip.final_customer_fare_pence, 0),
      NULLIF(v_trip.final_fare_pence, 0),
      public.trip_commission_reserve_fare_minor(v_trip)
    )
  );
  v_airport := GREATEST(0, COALESCE(v_trip.airport_charge_pence, 0));
  v_pass_through := GREATEST(0, COALESCE(v_trip.other_pass_through_charges_pence, 0));
  -- Always reconstruct pre-promotion commissionable from payable + locked promo.
  -- Ignore p_commissionable_fare_minor / p_commission_minor (post-promo settlement).
  v_commissionable := GREATEST(0, v_fare_minor + v_promo - v_airport - v_pass_through);
  v_pct := COALESCE(
    NULLIF(v_trip.accepted_commission_percent, 0),
    NULLIF(v_trip.driver_tier_commission_percent, 0),
    public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id),
    0
  );
  v_rate_bps := GREATEST(
    0,
    COALESCE(
      NULLIF(p_commission_rate_bps, 0),
      NULLIF(v_trip.snapshotted_commission_rate_bps, 0),
      ROUND(v_pct * 100)::integer
    )
  );
  v_gross := public.required_commission_reserve_minor(v_commissionable, v_rate_bps);
  v_effect := v_gross - v_promo;

  PERFORM public.release_driver_commission_wallet(p_driver_id, p_trip_id, 'converted_on_completion');

  SELECT * INTO v_parts
  FROM public.driver_commission_wallet_balance_parts(p_driver_id, v_trip.service_area_id);
  v_balance_before := COALESCE(v_parts.usable_commission_balance_minor, 0);
  v_currency := UPPER(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    'USD'
  ));

  IF v_effect = 0 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'ZERO_COMMISSION', 'gross_minor', v_gross);
  END IF;

  IF v_effect < 0 THEN
    INSERT INTO public.driver_commission_wallet_ledger (
      driver_id, service_area_id, region_id, currency, entry_type, amount_minor, direction,
      trip_id, reason, promotional_portion_minor, purchased_portion_minor, idempotency_key, metadata
    ) VALUES (
      p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
      'COMMISSION_SUBSIDY_CREDIT', -v_effect, 'credit', p_trip_id,
      'ONECAB customer-promotion subsidy',
      -v_effect, 0,
      left('cw_subsidy_' || p_trip_id::text, 180),
      jsonb_build_object(
        'gross_commission_minor', v_gross,
        'locked_customer_promotion_minor', v_promo,
        'subsidy_minor', -v_effect,
        'not_admin_credit', true,
        'not_customer_capture', true
      )
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_ledger_id;

    RETURN jsonb_build_object(
      'ok', true,
      'outcome', 'subsidy',
      'ledger_entry_id', v_ledger_id,
      'subsidy_minor', -v_effect,
      'gross_commission_minor', v_gross
    );
  END IF;

  v_from_promo := LEAST(v_effect, GREATEST(0, COALESCE(v_parts.promotional_balance_minor, 0)));
  v_from_purchased := v_effect - v_from_promo;

  INSERT INTO public.driver_commission_wallet_ledger (
    driver_id, service_area_id, region_id, currency, entry_type, amount_minor, direction,
    trip_id, reason, promotional_portion_minor, purchased_portion_minor, idempotency_key, metadata
  ) VALUES (
    p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
    'COMMISSION_DEDUCTION', v_effect, 'debit', p_trip_id,
    'Completed-trip commission deduction',
    v_from_promo, v_from_purchased,
    left('cw_deduction_' || p_trip_id::text, 180),
    jsonb_build_object(
      'gross_commission_minor', v_gross,
      'locked_customer_promotion_minor', v_promo,
      'commission_wallet_effect_minor', v_effect,
      'forced_overdraft', v_balance_before < v_effect,
      'allows_negative', true
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_ledger_id;

  UPDATE public.driver_commission_wallet_reserves
  SET status = 'converted_to_deduction', updated_at = now()
  WHERE trip_id = p_trip_id
    AND status IN ('released', 'active');

  RETURN jsonb_build_object(
    'ok', true,
    'outcome', 'deduction',
    'ledger_entry_id', v_ledger_id,
    'amount_minor', v_effect,
    'gross_commission_minor', v_gross,
    'shortfall_minor', GREATEST(0, v_effect - GREATEST(v_balance_before, 0))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_commission_wallet_on_trip_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id uuid;
  v_result jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;
  IF NOT public.trip_row_is_commission_wallet_driver_collected(NEW) THEN
    RETURN NEW;
  END IF;
  v_driver_id := COALESCE(NEW.driver_id, NEW.confirmed_driver_id);
  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: Driver-Collected completion missing driver'
      USING ERRCODE = 'check_violation';
  END IF;
  v_result := public.convert_driver_commission_wallet_on_trip_complete(
    v_driver_id,
    NEW.id,
    NEW.commission_pence,
    NEW.commissionable_fare_pence,
    NEW.snapshotted_commission_rate_bps
  );
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Commission Wallet completion failed: %', COALESCE(v_result->>'code', 'UNKNOWN')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_wallet_on_trip_complete ON public.trips;
CREATE TRIGGER trg_commission_wallet_on_trip_complete
  AFTER UPDATE OF status ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_commission_wallet_on_trip_complete();

CREATE OR REPLACE FUNCTION public.trg_commission_wallet_release_on_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  IF NEW.status NOT IN ('cancelled', 'customer_cancelled', 'expired', 'no_show') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF NOT public.trip_row_is_commission_wallet_driver_collected(NEW) THEN
    RETURN NEW;
  END IF;
  v_driver_id := COALESCE(NEW.driver_id, NEW.confirmed_driver_id, OLD.driver_id);
  IF v_driver_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM public.release_driver_commission_wallet(v_driver_id, NEW.id, 'trip_' || NEW.status);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_wallet_on_trip_complete ON public.trips;
CREATE TRIGGER trg_commission_wallet_on_trip_complete
  AFTER UPDATE OF status ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_commission_wallet_on_trip_complete();

DROP TRIGGER IF EXISTS trg_commission_wallet_release_on_cancel ON public.trips;
CREATE TRIGGER trg_commission_wallet_release_on_cancel
  AFTER UPDATE OF status ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_commission_wallet_release_on_cancel();

-- ── 8) FINANCIAL_MODEL_VIOLATION guards — never silent drop ─────────────────
CREATE OR REPLACE FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_model text;
BEGIN
  IF NEW.related_trip_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT financial_model::text INTO v_model FROM public.trips WHERE id = NEW.related_trip_id;
  -- LEDGER_REVERSAL is the only allowed DWL write on a Driver-Collected trip
  -- (append-only cleanup of historical mix). Every other type is pipeline 1.
  IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
     AND UPPER(COALESCE(NEW.type, '')) IS DISTINCT FROM 'LEDGER_REVERSAL' THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: % forbidden on DRIVER_COLLECTED_COMMISSION_WALLET', NEW.type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_payment_session_financial_model()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_model text;
BEGIN
  v_model := NULL;
  IF NEW.trip_id IS NOT NULL THEN
    SELECT financial_model::text INTO v_model FROM public.trips WHERE id = NEW.trip_id;
  ELSIF NEW.service_area_id IS NOT NULL THEN
    -- Quote-time preauth has no trip_id yet. SA stamp still forbids pipeline 1.
    SELECT financial_model::text INTO v_model FROM public.service_areas WHERE id = NEW.service_area_id;
  END IF;
  IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: Payment Session forbidden on DRIVER_COLLECTED_COMMISSION_WALLET'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
     AND (
       COALESCE(NEW.captured_amount_pence, 0) > 0
       OR UPPER(COALESCE(NEW.provider_state, '')) IN ('CAPTURED', 'COMPLETED', 'REFUNDED', 'RELEASED')
     ) THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: platform capture/refund/release forbidden on DRIVER_COLLECTED_COMMISSION_WALLET'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payment_session_financial_model ON public.payment_sessions;
CREATE TRIGGER trg_enforce_payment_session_financial_model
  BEFORE INSERT OR UPDATE ON public.payment_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_payment_session_financial_model();

CREATE OR REPLACE FUNCTION public.enforce_payout_item_financial_model()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_model text;
BEGIN
  IF NEW.trip_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT financial_model::text INTO v_model FROM public.trips WHERE id = NEW.trip_id;
  IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: Payout Ledger item forbidden on DRIVER_COLLECTED_COMMISSION_WALLET'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payout_item_financial_model ON public.payout_items;
CREATE TRIGGER trg_enforce_payout_item_financial_model
  BEFORE INSERT OR UPDATE ON public.payout_items
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_payout_item_financial_model();

CREATE OR REPLACE FUNCTION public.enforce_commission_wallet_ledger_financial_model()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_model text;
BEGIN
  IF NEW.entry_type::text IN ('ADMIN_CREDIT', 'TOP_UP_CREDIT', 'WELCOME_CREDIT', 'PROMOTIONAL_CREDIT', 'TOP_UP_REVERSAL', 'ADMIN_CORRECTION')
     AND NEW.trip_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.entry_type::text IN (
       'COMMISSION_RESERVE',
       'COMMISSION_RESERVE_RELEASE',
       'COMMISSION_DEDUCTION',
       'COMMISSION_DEDUCTION_REVERSAL',
       'COMMISSION_SUBSIDY_CREDIT'
     ) THEN
    IF NEW.trip_id IS NULL THEN
      RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: % requires trip_id', NEW.entry_type
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT financial_model::text INTO v_model FROM public.trips WHERE id = NEW.trip_id;
    IF v_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
      RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: % forbidden on %', NEW.entry_type, COALESCE(v_model, 'null')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_commission_wallet_ledger_financial_model
  ON public.driver_commission_wallet_ledger;
CREATE TRIGGER trg_enforce_commission_wallet_ledger_financial_model
  BEFORE INSERT ON public.driver_commission_wallet_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_commission_wallet_ledger_financial_model();

-- ── 9) Dispatch gate uses trip stamp, not live SA ───────────────────────────
CREATE OR REPLACE FUNCTION public.driver_passes_commission_wallet_dispatch_gate(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_fare_minor integer;
  v_pct numeric;
  v_rate_bps integer;
  v_required integer;
  v_balance integer;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_trip.financial_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN true;
  END IF;
  v_fare_minor := public.trip_commission_reserve_fare_minor(v_trip);
  v_pct := COALESCE(
    NULLIF(v_trip.driver_tier_commission_percent, 0),
    public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id),
    0
  );
  v_rate_bps := GREATEST(
    0,
    COALESCE(NULLIF(v_trip.snapshotted_commission_rate_bps, 0), ROUND(v_pct * 100)::integer)
  );
  v_required := public.required_commission_reserve_minor(v_fare_minor, v_rate_bps);
  IF v_required <= 0 THEN
    RETURN true;
  END IF;
  v_balance := public.driver_commission_wallet_usable_balance_minor(p_driver_id, v_trip.service_area_id);
  RETURN v_balance >= v_required;
END;
$$;

-- ── 10) Payment gate: Driver-Collected trips do not require a Payment Session ─
CREATE OR REPLACE FUNCTION public.payment_authorisation_valid(p_trip_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_ps RECORD;
  v_method text;
  v_provider_state text;
  v_required integer;
  v_authorised integer;
BEGIN
  SELECT id, payment_method, payment_session_id, payment_provider, financial_model,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence, gross_fare_pence, offer_discount_pence
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_trip.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN true;
  END IF;

  v_method := UPPER(COALESCE(v_trip.payment_method,''));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN true;
  END IF;

  IF v_trip.payment_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id, status, provider_state, authorised_amount_pence, total_authorised_amount_pence,
         currency, released_at, captured_at, trip_id, metadata
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_ps.trip_id IS NOT NULL AND v_ps.trip_id <> p_trip_id THEN
    RETURN false;
  END IF;

  IF COALESCE(v_ps.metadata->>'never_capture','') = 'true'
     OR COALESCE(v_ps.metadata->>'orphan_reason','') <> '' THEN
    IF v_ps.status::text IN ('payment_orphaned','orphan_authorisation') THEN
      RETURN false;
    END IF;
  END IF;

  IF v_ps.status::text IN (
    'cancelled','failed','payment_orphaned','orphan_authorisation',
    'released','RECOVERY_CANCELLED','RECOVERY_DECLINED','RECOVERY_EXPIRED'
  ) THEN
    RETURN false;
  END IF;

  IF v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL THEN
    RETURN false;
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RETURN false;
  END IF;

  v_authorised := COALESCE(
    NULLIF(v_ps.total_authorised_amount_pence, 0),
    NULLIF(v_ps.authorised_amount_pence, 0),
    NULLIF(v_trip.authorised_amount_pence, 0),
    0
  );
  IF v_authorised <= 0 THEN
    RETURN false;
  END IF;

  v_required := COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    0
  );
  IF v_required <= 0 THEN
    RETURN false;
  END IF;

  RETURN v_authorised >= v_required;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_payment_gate(p_trip_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_ps RECORD;
  v_method text;
  v_provider_state text;
  v_required integer;
  v_authorised integer;
BEGIN
  SELECT id, payment_method, payment_session_id, currency_code, financial_model,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % not found', p_trip_id USING ERRCODE='P0001';
  END IF;

  IF v_trip.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN;
  END IF;

  v_method := UPPER(COALESCE(v_trip.payment_method,''));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN;
  END IF;

  IF v_trip.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % has no payment_session_id', p_trip_id
      USING ERRCODE='P0001';
  END IF;

  SELECT id, status, provider_state, authorised_amount_pence, total_authorised_amount_pence,
         currency, released_at, captured_at, trip_id, metadata
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session missing' USING ERRCODE='P0001';
  END IF;

  IF v_ps.trip_id IS NOT NULL AND v_ps.trip_id <> p_trip_id THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session bound to different trip'
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'payment_orphaned','orphan_authorisation'
  ) OR COALESCE(v_ps.metadata->>'never_capture','') = 'true' THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session orphaned/superseded'
      USING ERRCODE='P0001';
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'cancelled','failed','released',
    'RECOVERY_CANCELLED','RECOVERY_DECLINED','RECOVERY_EXPIRED'
  ) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=%', v_ps.status
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: hold released without capture'
      USING ERRCODE='P0001';
  END IF;

  v_authorised := COALESCE(
    NULLIF(v_ps.total_authorised_amount_pence, 0),
    NULLIF(v_ps.authorised_amount_pence, 0),
    NULLIF(v_trip.authorised_amount_pence, 0),
    0
  );
  IF v_authorised <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=%', v_authorised
      USING ERRCODE='P0001';
  END IF;

  v_required := COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    0
  );
  IF v_required <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: locked customer payable missing'
      USING ERRCODE='P0001';
  END IF;

  IF v_authorised < v_required THEN
    RAISE EXCEPTION
      'PAYMENT_GATE_NOT_SATISFIED: PAYMENT_AUTHORISATION_INSUFFICIENT authorised=% required=%',
      v_authorised, v_required
      USING ERRCODE='P0001';
  END IF;
END;
$function$;

-- ── 11) Dev reversal of Banadir Driver Wallet mix (append-only). No deletes.
-- CASH_COMMISSION_DEBT is the live-wallet mix on these trips; reporting-only
-- CASH_TRIP_EARNING / PLATFORM_COMMISSION stay as historical evidence.
-- CASH_TRIP_EARNING / PLATFORM_COMMISSION are reporting-only (BALANCE_EXCLUDED);
-- reversing them with LEDGER_REVERSAL would incorrectly change live wallet.
-- They remain as historical evidence and are not payout-allocatable.
-- ADMIN_CREDIT Commission Wallet rows are intentionally unchanged.
-- One LEDGER_REVERSAL per trip (unique_trip_ledger_entry).
INSERT INTO public.driver_wallet_ledger (
  driver_id, related_trip_id, type, amount_pence, description
)
SELECT
  dw.driver_id,
  dw.related_trip_id,
  'LEDGER_REVERSAL',
  -SUM(dw.amount_pence) FILTER (
    WHERE dw.type NOT IN (
      'PLATFORM_COMMISSION',
      'PLATFORM_COMMISSION_GROSS',
      'PLATFORM_COMMISSION_NET',
      'COMPANY_COMMISSION',
      'COMMISSION_REVERSAL',
      'PAYMENT_PROVIDER_FEE',
      'PAYMENT_PROVIDER_FEE_ADJUSTMENT',
      'PROVIDER_FEE_REVERSAL',
      'CASH_TRIP_EARNING',
      'PAYOUT_RESERVATION_HOLD',
      'PAYOUT_RESERVATION_RELEASE'
    )
  ),
  'Dev isolation: reverse every balance-affecting DWL effect on DRIVER_COLLECTED test trip; sources='
    || string_agg(dw.id::text || ':' || dw.type, ',')
FROM public.driver_wallet_ledger dw
JOIN public.trips t ON t.id = dw.related_trip_id
WHERE t.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
  AND NOT EXISTS (
    SELECT 1
    FROM public.driver_wallet_ledger rev
    WHERE rev.related_trip_id = dw.related_trip_id
      AND rev.type = 'LEDGER_REVERSAL'
  )
GROUP BY dw.driver_id, dw.related_trip_id
HAVING coalesce(
  SUM(dw.amount_pence) FILTER (
    WHERE dw.type NOT IN (
      'PLATFORM_COMMISSION',
      'PLATFORM_COMMISSION_GROSS',
      'PLATFORM_COMMISSION_NET',
      'COMPANY_COMMISSION',
      'COMMISSION_REVERSAL',
      'PAYMENT_PROVIDER_FEE',
      'PAYMENT_PROVIDER_FEE_ADJUSTMENT',
      'PROVIDER_FEE_REVERSAL',
      'CASH_TRIP_EARNING',
      'PAYOUT_RESERVATION_HOLD',
      'PAYOUT_RESERVATION_RELEASE'
    )
  ),
  0
) <> 0;
