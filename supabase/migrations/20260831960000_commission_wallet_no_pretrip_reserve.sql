-- P0: No pre-trip Commission Wallet reservation.
-- Accept/assignment must not lock, reserve, or mutate CW balance.
-- Dispatch gate is read-only: commission_wallet_balance >= estimated commission.
-- UK/EU PLATFORM_COLLECTED unchanged (gates remain off).

-- ── 0) Reserves metadata for audit void payload ──────────────────────────────
ALTER TABLE public.driver_commission_wallet_reserves
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── 1) Explicit top-up enable flag (separate from provider) ───────────────────
ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS commission_wallet_topup_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.service_areas.commission_wallet_topup_enabled IS
  'Driver Top Up CTA. Requires commission_wallet_enabled=true AND a configured top-up provider. Provider alone does not enable top-up.';

ALTER TABLE public.service_areas
  DROP CONSTRAINT IF EXISTS service_areas_commission_wallet_topup_requires_wallet;
ALTER TABLE public.service_areas
  ADD CONSTRAINT service_areas_commission_wallet_topup_requires_wallet
  CHECK (
    commission_wallet_topup_enabled = false
    OR commission_wallet_enabled = true
  );

-- Banadir pilot only — already approved for Waafi top-up.
UPDATE public.service_areas
SET commission_wallet_topup_enabled = true,
    updated_at = now()
WHERE id = '29259edf-80eb-4c08-9089-352b8a305b81'
  AND financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
  AND commission_wallet_enabled = true
  AND COALESCE(NULLIF(btrim(commission_topup_provider), ''), '') <> '';

-- Turn off reserve flag everywhere (eligibility no longer depends on it).
UPDATE public.service_areas
SET commission_reserve_enabled = false,
    updated_at = now()
WHERE commission_reserve_enabled = true;

-- ── 2) Allow legacy void status on reserves (audit only) ─────────────────────
ALTER TABLE public.driver_commission_wallet_reserves
  DROP CONSTRAINT IF EXISTS driver_commission_wallet_reserves_status_check;

ALTER TABLE public.driver_commission_wallet_reserves
  ADD CONSTRAINT driver_commission_wallet_reserves_status_check
  CHECK (status IN (
    'active',
    'released',
    'converted_to_deduction',
    'legacy_reservation_voided'
  ));

-- ── 3) Idempotent void of open reserves (no compensating credits) ────────────
-- Reserves never affected display SSOT (credits − deductions only). Void only.
UPDATE public.driver_commission_wallet_reserves
SET
  status = 'legacy_reservation_voided',
  updated_at = now(),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'legacy_void_reason', 'no_pretrip_reservation_correction',
    'voided_at', now(),
    'prior_status', 'active'
  )
WHERE status = 'active';

-- ── 4) Balance SSOT helpers — ignore historical reserves; allow negative ─────
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
    ELSIF r.entry_type IN ('WELCOME_CREDIT', 'PROMOTIONAL_CREDIT', 'ADMIN_CREDIT') THEN
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
    ELSIF r.entry_type IN ('COMMISSION_RESERVE', 'COMMISSION_RESERVE_RELEASE') THEN
      NULL;
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
      IF v_promo_part + v_purchased_part > 0 THEN
        v_promotional := v_promotional + v_promo_part;
        v_purchased := v_purchased + v_purchased_part;
      ELSE
        v_promotional := v_promotional + v_amount;
      END IF;
    END IF;
  END LOOP;

  purchased_balance_minor := v_purchased;
  promotional_balance_minor := v_promotional;
  reserved_balance_minor := 0;
  usable_commission_balance_minor := v_purchased + v_promotional;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.driver_commission_wallet_balance_parts(uuid, uuid) IS
  'CW balance SSOT: credits − confirmed deductions. Reserves ignored. May be negative.';

CREATE OR REPLACE FUNCTION public.driver_commission_wallet_usable_balance_minor(
  p_driver_id uuid,
  p_service_area_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT usable_commission_balance_minor
      FROM public.driver_commission_wallet_balance_parts(p_driver_id, p_service_area_id)
      LIMIT 1
    ),
    0
  );
$$;

COMMENT ON FUNCTION public.driver_commission_wallet_usable_balance_minor(uuid, uuid) IS
  'Alias of live commission_wallet_balance (non-locking). Reserves ignored.';

-- ── 5) Soft gate uses workflow (not reserve flag) + current balance ──────────
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
    RETURN true;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN true;
  END IF;

  IF NOT public.is_commission_wallet_workflow_enabled(v_trip.service_area_id) THEN
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

COMMENT ON FUNCTION public.driver_passes_commission_wallet_dispatch_gate(uuid, uuid) IS
  'Read-only CW eligibility: balance >= estimated commission. Never mutates wallet.';

CREATE OR REPLACE FUNCTION public.is_commission_wallet_reserve_enabled(p_service_area_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT false;
$$;

COMMENT ON FUNCTION public.is_commission_wallet_reserve_enabled(uuid) IS
  'Deprecated: pre-trip reservation removed. Always false. Eligibility uses is_commission_wallet_workflow_enabled.';

-- ── 6) No-op reserve / release writers ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_driver_commission_wallet(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'ok', true,
    'skipped', true,
    'code', 'RESERVATION_DISABLED',
    'error', 'Pre-trip Commission Wallet reservation is disabled; eligibility is read-only'
  );
END;
$$;

COMMENT ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) IS
  'No-op. Pre-trip CW reservation removed — acceptance must not lock balance.';

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
BEGIN
  UPDATE public.driver_commission_wallet_reserves
  SET
    status = 'legacy_reservation_voided',
    updated_at = now(),
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_void_reason', COALESCE(p_reason, 'release_noop_after_reservation_disabled'),
      'voided_at', now()
    )
  WHERE driver_id = p_driver_id
    AND trip_id = p_trip_id
    AND status = 'active';

  RETURN jsonb_build_object(
    'ok', true,
    'skipped', true,
    'code', 'RESERVATION_DISABLED'
  );
END;
$$;

COMMENT ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) IS
  'No-op writer. Voids leftover active reserve rows without ledger mutation.';

-- ── 7) Disable assignment / fare-recalc reserve triggers ─────────────────────
CREATE OR REPLACE FUNCTION public.trg_commission_wallet_on_trip_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_commission_wallet_on_trip_assignment() IS
  'No-op. Pre-trip Commission Wallet reservation disabled.';

CREATE OR REPLACE FUNCTION public.trg_trips_cw_reserve_recalc_on_fare()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_trips_cw_reserve_recalc_on_fare() IS
  'No-op. Pre-trip Commission Wallet reservation disabled.';

-- ── 8) Completion deduction — full earned amount; no reserve convert credit ──
CREATE OR REPLACE FUNCTION public.convert_driver_commission_wallet_on_trip_complete(
  p_driver_id uuid,
  p_trip_id uuid,
  p_commission_minor integer DEFAULT NULL,
  p_commissionable_fare_minor integer DEFAULT NULL,
  p_commission_rate_bps integer DEFAULT NULL
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
  v_fare_minor integer;
  v_airport integer;
  v_pass_through integer;
  v_commissionable integer;
  v_rate_bps integer;
  v_pct numeric;
  v_earned integer;
  v_parts record;
  v_promo integer;
  v_purchased integer;
  v_from_promo integer;
  v_from_purchased integer;
  v_currency text;
  v_deduction_idempotency text;
  v_deduction_ledger_id uuid;
  v_trip_code text;
  v_balance_before integer;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'skipped', true, 'code', 'INVALID_ARGS');
  END IF;

  PERFORM 1 FROM public.drivers WHERE id = p_driver_id FOR UPDATE;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TRIP_NOT_FOUND', 'error', 'Trip not found');
  END IF;

  IF v_trip.service_area_id IS NULL
     OR NOT public.is_commission_wallet_workflow_enabled(v_trip.service_area_id) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'WALLET_GATE_OFF');
  END IF;

  IF v_trip.financial_model IS NOT NULL
     AND v_trip.commission_wallet_enabled IS NOT NULL
     AND NOT (
       v_trip.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
       AND v_trip.commission_wallet_enabled IS TRUE
     ) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'TRIP_SNAPSHOT_GATE_OFF');
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = v_trip.service_area_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_AREA_NOT_FOUND', 'error', 'Service area not found');
  END IF;

  SELECT id INTO v_existing_deduction_id
  FROM public.driver_commission_wallet_ledger
  WHERE trip_id = p_trip_id
    AND entry_type = 'COMMISSION_DEDUCTION'
  LIMIT 1;

  IF v_existing_deduction_id IS NOT NULL THEN
    UPDATE public.driver_commission_wallet_reserves
    SET status = 'legacy_reservation_voided', updated_at = now()
    WHERE driver_id = p_driver_id
      AND trip_id = p_trip_id
      AND status = 'active';

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_existing_deduction_id,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  UPDATE public.driver_commission_wallet_reserves
  SET
    status = 'legacy_reservation_voided',
    updated_at = now(),
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_void_reason', 'voided_on_completion_no_pretrip_reserve',
      'voided_at', now()
    )
  WHERE driver_id = p_driver_id
    AND trip_id = p_trip_id
    AND status = 'active';

  IF p_commission_minor IS NOT NULL THEN
    v_earned := GREATEST(0, p_commission_minor);
  ELSE
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
    v_commissionable := GREATEST(
      0,
      COALESCE(NULLIF(p_commissionable_fare_minor, 0), v_fare_minor - v_airport - v_pass_through)
    );
    v_pct := COALESCE(
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
    v_earned := public.required_commission_reserve_minor(v_commissionable, v_rate_bps);
  END IF;

  IF v_earned <= 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'code', 'ZERO_COMMISSION',
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  SELECT * INTO v_parts
  FROM public.driver_commission_wallet_balance_parts(p_driver_id, v_trip.service_area_id);

  v_balance_before := COALESCE(v_parts.usable_commission_balance_minor, 0);
  v_promo := COALESCE(v_parts.promotional_balance_minor, 0);
  v_purchased := COALESCE(v_parts.purchased_balance_minor, 0);

  v_from_promo := LEAST(v_earned, GREATEST(0, v_promo));
  v_from_purchased := v_earned - v_from_promo;

  v_currency := UPPER(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    NULLIF(v_trip.snapshotted_commission_currency, ''),
    'USD'
  ));

  v_trip_code := NULLIF(btrim(COALESCE(v_trip.trip_code, '')), '');
  v_deduction_idempotency := left('cw_deduction_' || p_trip_id::text, 180);

  INSERT INTO public.driver_commission_wallet_ledger (
    driver_id, service_area_id, region_id, currency, entry_type, amount_minor, direction,
    trip_id, reason, promotional_portion_minor, purchased_portion_minor, idempotency_key, metadata
  ) VALUES (
    p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
    'COMMISSION_DEDUCTION', v_earned, 'debit', p_trip_id,
    'Completed-trip commission deduction',
    v_from_promo, v_from_purchased, v_deduction_idempotency,
    jsonb_build_object(
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION',
      'phase', 'no_pretrip_reserve',
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'trip_id', p_trip_id,
      'public_trip_id', v_trip_code,
      'trip_code', v_trip_code,
      'driver_id', p_driver_id,
      'service_area_id', v_trip.service_area_id,
      'final_fare_minor', COALESCE(v_fare_minor, v_commissionable),
      'commissionable_fare_minor', COALESCE(p_commissionable_fare_minor, v_commissionable),
      'commission_rate_bps', COALESCE(p_commission_rate_bps, v_rate_bps),
      'commission_amount_minor', v_earned,
      'currency', v_currency,
      'completion_at', now(),
      'balance_before_minor', v_balance_before,
      'balance_after_minor', v_balance_before - v_earned,
      'allows_negative', true
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_deduction_ledger_id;

  IF v_deduction_ledger_id IS NULL THEN
    SELECT id INTO v_deduction_ledger_id
    FROM public.driver_commission_wallet_ledger
    WHERE idempotency_key = v_deduction_idempotency;

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_deduction_ledger_id,
      'amount_minor', v_earned,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  UPDATE public.trips
  SET
    financial_model = COALESCE(financial_model, 'DRIVER_COLLECTED_COMMISSION_WALLET'),
    commission_wallet_enabled = COALESCE(commission_wallet_enabled, true),
    snapshotted_commission_rate_bps = COALESCE(
      NULLIF(snapshotted_commission_rate_bps, 0),
      COALESCE(p_commission_rate_bps, v_rate_bps)
    ),
    snapshotted_commission_currency = COALESCE(
      NULLIF(snapshotted_commission_currency, ''),
      v_currency
    ),
    updated_at = now()
  WHERE id = p_trip_id
    AND public.is_commission_wallet_workflow_enabled(service_area_id);

  RETURN jsonb_build_object(
    'ok', true,
    'ledger_entry_id', v_deduction_ledger_id,
    'amount_minor', v_earned,
    'commission_earned_minor', v_earned,
    'shortfall_minor', GREATEST(0, v_earned - GREATEST(v_balance_before, 0)),
    'forced_overdraft', v_balance_before < v_earned,
    'promotional_portion_minor', v_from_promo,
    'purchased_portion_minor', v_from_purchased,
    'balance_before_minor', v_balance_before,
    'balance_after_minor', v_balance_before - v_earned,
    'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
    'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id, amount_minor INTO v_deduction_ledger_id, v_earned
    FROM public.driver_commission_wallet_ledger
    WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_DEDUCTION'
    LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_deduction_ledger_id,
      'amount_minor', v_earned,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
END;
$$;

COMMENT ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer) IS
  'Completed-trip CW deduction only. No pre-trip reserve. Full confirmed commission; balance may go negative. Idempotent per trip.';

-- Unique protection: one COMMISSION_DEDUCTION per trip (skip if duplicates already exist).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.driver_commission_wallet_ledger
    WHERE entry_type = 'COMMISSION_DEDUCTION'
      AND trip_id IS NOT NULL
    GROUP BY trip_id
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_ledger_trip_deduction_uidx
      ON public.driver_commission_wallet_ledger (trip_id)
      WHERE entry_type = 'COMMISSION_DEDUCTION' AND trip_id IS NOT NULL;
  END IF;
END $$;
