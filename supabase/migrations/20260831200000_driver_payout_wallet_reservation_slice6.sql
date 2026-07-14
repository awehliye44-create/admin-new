-- P0 Slice 6: driver wallet payout reservation (hold, not debit).
-- LIVE_PAYOUT_EXECUTION_ENABLED / REVOLUT_PAYMENT_TRANSPORT_ENABLED stay false.
-- No Revolut /pay, no provider_payment_id, no permanent debit.

BEGIN;

-- Ensure batch failure columns used by Slice 5/6 status gates exist.
ALTER TABLE public.payout_batches
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- ---------------------------------------------------------------------------
-- Ledger hold types (excluded from live balance)
-- ---------------------------------------------------------------------------
ALTER TABLE public.driver_wallet_ledger DROP CONSTRAINT IF EXISTS driver_wallet_ledger_type_check;
ALTER TABLE public.driver_wallet_ledger ADD CONSTRAINT driver_wallet_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET'::text,
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
    'PAYOUT_RESERVATION_RELEASE'::text
  ]));

-- ---------------------------------------------------------------------------
-- Status widen — Slice 6 lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE public.payout_batches DROP CONSTRAINT IF EXISTS payout_batches_status_check;
ALTER TABLE public.payout_batches ADD CONSTRAINT payout_batches_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'partial', 'PARTIAL_SETTLEMENT',
    'INVALID_ORPHANED', 'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'RETURNED',
    'DRAFT', 'SCHEDULED', 'VALIDATING', 'PROCESSING', 'PARTIALLY_COMPLETED',
    'COMPLETED', 'FAILED', 'CANCELLED',
    'ELIGIBILITY_SNAPSHOTTED', 'ITEMS_CREATED', 'BLOCKED_EXECUTION_DISABLED',
    'FUNDS_RESERVED_EXECUTION_DISABLED',
    'RESERVING', 'RESERVED'
  ]));

ALTER TABLE public.payout_items DROP CONSTRAINT IF EXISTS payout_items_status_check;
ALTER TABLE public.payout_items ADD CONSTRAINT payout_items_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'ledger_sync_failed',
    'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'FAILED', 'RETURNED', 'INVALID_ORPHANED',
    'VALIDATED', 'BLOCKED_EXECUTION_DISABLED', 'INELIGIBLE',
    'RESERVING', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED',
    'RELEASED', 'REVERSED', 'CANCELLED'
  ]));

-- ---------------------------------------------------------------------------
-- Canonical reservation table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_payout_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_item_id UUID NOT NULL REFERENCES public.payout_items(id),
  payout_batch_id UUID NOT NULL REFERENCES public.payout_batches(id),
  driver_id UUID NOT NULL REFERENCES public.drivers(id),
  wallet_account_id UUID NOT NULL,
  reservation_type TEXT NOT NULL DEFAULT 'DRIVER_PAYOUT'
    CHECK (reservation_type = 'DRIVER_PAYOUT'),
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  currency TEXT NOT NULL DEFAULT 'GBP' CHECK (upper(currency) = 'GBP'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status = ANY (ARRAY[
      'PENDING', 'ACTIVE', 'RELEASED', 'CONSUMED', 'FAILED', 'CANCELLED'
    ])),
  idempotency_key TEXT NOT NULL,
  reservation_fingerprint TEXT NOT NULL,
  reserved_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  release_reason TEXT,
  failure_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  hold_ledger_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.driver_payout_reservations IS
  'Slice 6 wallet fund reservations (holds). ACTIVE reduces available; live balance unchanged. Not a debit or payment.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_payout_reservations_idempotency_key
  ON public.driver_payout_reservations (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_payout_reservations_fingerprint
  ON public.driver_payout_reservations (reservation_fingerprint);

-- One ACTIVE reservation per payout item
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_payout_reservations_active_item
  ON public.driver_payout_reservations (payout_item_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_driver_payout_reservations_driver_active
  ON public.driver_payout_reservations (driver_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_driver_payout_reservations_batch
  ON public.driver_payout_reservations (payout_batch_id);

ALTER TABLE public.driver_payout_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS driver_payout_reservations_service_role_all
  ON public.driver_payout_reservations;
CREATE POLICY driver_payout_reservations_service_role_all
  ON public.driver_payout_reservations
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS driver_payout_reservations_admin_select
  ON public.driver_payout_reservations;
CREATE POLICY driver_payout_reservations_admin_select
  ON public.driver_payout_reservations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    )
  );

DROP POLICY IF EXISTS driver_payout_reservations_driver_select
  ON public.driver_payout_reservations;
CREATE POLICY driver_payout_reservations_driver_select
  ON public.driver_payout_reservations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.id = driver_payout_reservations.driver_id
        AND d.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Helpers: live / reserved / available
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_wallet_live_balance_pence(p_driver_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount_pence), 0)::bigint
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND type NOT IN (
      'PLATFORM_COMMISSION',
      'CASH_TRIP_EARNING',
      'PAYOUT_RESERVATION_HOLD',
      'PAYOUT_RESERVATION_RELEASE'
    );
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_active_reservation_pence(p_driver_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount_pence), 0)::bigint
  FROM public.driver_payout_reservations
  WHERE driver_id = p_driver_id
    AND status = 'ACTIVE';
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_other_holds_pence(p_driver_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(requested_cashout_pence), 0)::bigint
  FROM public.driver_early_cashouts
  WHERE driver_id = p_driver_id
    AND status IN ('pending', 'processing');
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_available_for_payout_pence(p_driver_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(
    0,
    public.driver_wallet_live_balance_pence(p_driver_id)
      - public.driver_wallet_active_reservation_pence(p_driver_id)
      - public.driver_wallet_other_holds_pence(p_driver_id)
  )::bigint;
$$;

-- Refresh cache: available_pence = live (liability), pending_pence = active reservations
CREATE OR REPLACE FUNCTION public.refresh_driver_wallet_reservation_cache(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live integer;
  v_reserved integer;
  v_lifetime integer;
BEGIN
  v_live := public.driver_wallet_live_balance_pence(p_driver_id)::integer;
  v_reserved := public.driver_wallet_active_reservation_pence(p_driver_id)::integer;

  SELECT COALESCE(SUM(amount_pence), 0)::integer
  INTO v_lifetime
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND amount_pence > 0
    AND type NOT IN (
      'PLATFORM_COMMISSION',
      'CASH_TRIP_EARNING',
      'PAYOUT_RESERVATION_HOLD',
      'PAYOUT_RESERVATION_RELEASE'
    );

  INSERT INTO public.driver_wallets (
    driver_id, available_pence, pending_pence, lifetime_earned_pence, updated_at
  )
  VALUES (p_driver_id, v_live, v_reserved, v_lifetime, now())
  ON CONFLICT (driver_id) DO UPDATE SET
    available_pence = EXCLUDED.available_pence,
    pending_pence = EXCLUDED.pending_pence,
    lifetime_earned_pence = EXCLUDED.lifetime_earned_pence,
    updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- Atomic reserve RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_driver_payout_item(p_payout_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_batch public.payout_batches%ROWTYPE;
  v_dest public.driver_payout_destinations%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_wallet public.driver_wallets%ROWTYPE;
  v_existing public.driver_payout_reservations%ROWTYPE;
  v_idempotency text;
  v_fingerprint text;
  v_live bigint;
  v_other_holds bigint;
  v_active_other bigint;
  v_available bigint;
  v_amount integer;
  v_currency text;
  v_res_id uuid;
  v_hold_id uuid;
  v_now timestamptz := now();
BEGIN
  -- Lock wallet row first (create if missing) to serialise availability checks.
  BEGIN
    SELECT * INTO v_wallet
    FROM public.driver_wallets
    WHERE driver_id = (
      SELECT driver_id FROM public.payout_items WHERE id = p_payout_item_id
    )
    FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'WALLET_LOCK_TIMEOUT',
      'reservation', NULL
    );
  END;

  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  -- Ensure wallet lock even when cache row was missing at first select.
  IF v_wallet.id IS NULL THEN
    INSERT INTO public.driver_wallets (driver_id, available_pence, pending_pence, lifetime_earned_pence, updated_at)
    VALUES (v_item.driver_id, 0, 0, 0, v_now)
    ON CONFLICT (driver_id) DO NOTHING;

    BEGIN
      SELECT * INTO v_wallet
      FROM public.driver_wallets
      WHERE driver_id = v_item.driver_id
      FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'WALLET_LOCK_TIMEOUT');
    END;
  END IF;

  SELECT * INTO v_batch FROM public.payout_batches WHERE id = v_item.batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
  END IF;

  IF v_batch.kind IS DISTINCT FROM 'WEEKLY_SCHEDULED'
     AND v_batch.kind IS DISTINCT FROM 'WEEKLY_MONDAY' THEN
    -- Slice 6 reserves weekly scheduled batch only (legacy Monday read-only / not altered).
    IF v_batch.kind IS DISTINCT FROM 'WEEKLY_SCHEDULED' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
    END IF;
  END IF;

  IF v_batch.status NOT IN (
    'BLOCKED_EXECUTION_DISABLED',
    'FUNDS_RESERVED_EXECUTION_DISABLED',
    'ITEMS_CREATED',
    'VALIDATED',
    'RESERVED',
    'RESERVING'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
  END IF;

  IF upper(coalesce(v_item.status, '')) IN (
    'PAID', 'COMPLETED', 'SUBMITTED', 'SUBMITTING', 'SENT', 'CANCELLED', 'REVERSED'
  ) OR lower(coalesce(v_item.status, '')) IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF upper(coalesce(v_item.status, '')) NOT IN (
    'VALIDATED', 'BLOCKED_EXECUTION_DISABLED', 'RESERVING', 'RESERVED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  v_amount := COALESCE(v_item.amount_pence, v_item.net_driver_payout_pence, 0);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'AMOUNT_MISMATCH');
  END IF;

  v_currency := upper(COALESCE(NULLIF(trim(v_item.currency), ''), 'GBP'));
  IF v_currency <> 'GBP' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CURRENCY_MISMATCH');
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = v_item.driver_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF COALESCE(v_driver.payouts_enabled, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'DRIVER_PAYOUT_HELD');
  END IF;

  IF v_item.payout_destination_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'DESTINATION_NOT_ACTIVE');
  END IF;

  SELECT * INTO v_dest
  FROM public.driver_payout_destinations
  WHERE id = v_item.payout_destination_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_dest.is_active IS NOT TRUE
     OR v_dest.archived_at IS NOT NULL
     OR v_dest.driver_id IS DISTINCT FROM v_item.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'DESTINATION_NOT_ACTIVE');
  END IF;

  IF upper(COALESCE(v_dest.provider_link_status, '')) <> 'PROVIDER_VERIFIED'
     OR NULLIF(trim(COALESCE(v_dest.provider_counterparty_id, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(v_dest.provider_recipient_account_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PROVIDER_LINK_NOT_VERIFIED');
  END IF;

  v_idempotency := 'driver-payout-reservation:' || v_item.id::text;
  v_fingerprint := 'drv-payout-res-v1:'
    || v_item.id::text || ':'
    || v_item.batch_id::text || ':'
    || v_item.driver_id::text || ':'
    || v_amount::text || ':'
    || v_currency;

  -- Idempotent reuse
  SELECT * INTO v_existing
  FROM public.driver_payout_reservations
  WHERE idempotency_key = v_idempotency;

  IF FOUND THEN
    IF v_existing.reservation_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_existing.amount_pence IS DISTINCT FROM v_amount
       OR v_existing.driver_id IS DISTINCT FROM v_item.driver_id
       OR v_existing.payout_item_id IS DISTINCT FROM v_item.id
       OR upper(v_existing.currency) IS DISTINCT FROM v_currency THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'IDEMPOTENCY_CONFLICT',
        'reservation_id', v_existing.id
      );
    END IF;

    IF v_existing.status = 'ACTIVE' THEN
      UPDATE public.payout_items
      SET status = 'RESERVED',
          execution_status = 'BLOCKED_EXECUTION_DISABLED',
          updated_at = v_now
      WHERE id = v_item.id
        AND status IS DISTINCT FROM 'RESERVED';

      UPDATE public.payout_batches
      SET status = 'FUNDS_RESERVED_EXECUTION_DISABLED',
          failure_code = 'FUNDS_RESERVED_EXECUTION_DISABLED',
          failure_reason = 'Funds reserved; LIVE/TRANSPORT execution disabled',
          updated_at = v_now
      WHERE id = v_batch.id
        AND status IS DISTINCT FROM 'FUNDS_RESERVED_EXECUTION_DISABLED';

      PERFORM public.refresh_driver_wallet_reservation_cache(v_item.driver_id);

      RETURN jsonb_build_object(
        'ok', true,
        'reused', true,
        'error_code', NULL,
        'reservation', jsonb_build_object(
          'id', v_existing.id,
          'payout_item_id', v_existing.payout_item_id,
          'payout_batch_id', v_existing.payout_batch_id,
          'driver_id', v_existing.driver_id,
          'amount_pence', v_existing.amount_pence,
          'currency', v_existing.currency,
          'status', v_existing.status,
          'idempotency_key', v_existing.idempotency_key,
          'reservation_fingerprint', v_existing.reservation_fingerprint,
          'reserved_at', v_existing.reserved_at
        ),
        'live_balance_pence', public.driver_wallet_live_balance_pence(v_item.driver_id),
        'available_pence', public.driver_wallet_available_for_payout_pence(v_item.driver_id),
        'reserved_pence', public.driver_wallet_active_reservation_pence(v_item.driver_id)
      );
    END IF;

    IF v_existing.status IN ('RELEASED', 'CANCELLED', 'FAILED') THEN
      -- Allow re-reserve under same fingerprint only by creating new ACTIVE would violate
      -- idempotency_key UNIQUE — so revive released row atomically.
      NULL; -- handled below after availability check via UPDATE path
    ELSE
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'ACTIVE_RESERVATION_EXISTS',
        'reservation_id', v_existing.id
      );
    END IF;
  END IF;

  -- Mark RESERVING (crash-recoverable)
  UPDATE public.payout_items
  SET status = 'RESERVING',
      execution_status = 'RESERVING',
      updated_at = v_now
  WHERE id = v_item.id
    AND status IN ('VALIDATED', 'BLOCKED_EXECUTION_DISABLED', 'RESERVING', 'RESERVED');

  v_live := public.driver_wallet_live_balance_pence(v_item.driver_id);
  v_other_holds := public.driver_wallet_other_holds_pence(v_item.driver_id);
  SELECT COALESCE(SUM(amount_pence), 0)::bigint INTO v_active_other
  FROM public.driver_payout_reservations
  WHERE driver_id = v_item.driver_id
    AND status = 'ACTIVE'
    AND payout_item_id IS DISTINCT FROM v_item.id;

  v_available := GREATEST(0, v_live - v_active_other - v_other_holds);

  IF v_available < v_amount THEN
    UPDATE public.payout_items
    SET status = 'BLOCKED_EXECUTION_DISABLED',
        execution_status = 'BLOCKED_EXECUTION_DISABLED',
        error_message = 'INSUFFICIENT_AVAILABLE_WALLET',
        updated_at = v_now
    WHERE id = v_item.id AND status = 'RESERVING';

    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'INSUFFICIENT_AVAILABLE_WALLET',
      'available_pence', v_available,
      'required_pence', v_amount,
      'live_balance_pence', v_live
    );
  END IF;

  -- Revive released reservation under same idempotency key, else insert.
  IF v_existing.id IS NOT NULL AND v_existing.status IN ('RELEASED', 'CANCELLED', 'FAILED') THEN
    UPDATE public.driver_payout_reservations
    SET status = 'ACTIVE',
        amount_pence = v_amount,
        reserved_at = v_now,
        released_at = NULL,
        consumed_at = NULL,
        release_reason = NULL,
        failure_code = NULL,
        wallet_account_id = v_wallet.id,
        metadata = jsonb_build_object(
          'slice', 6,
          'hold_model', 'PAYOUT_RESERVATION_HOLD',
          'revived', true
        ),
        updated_at = v_now
    WHERE id = v_existing.id
    RETURNING id INTO v_res_id;
  ELSE
    INSERT INTO public.driver_payout_reservations (
      payout_item_id,
      payout_batch_id,
      driver_id,
      wallet_account_id,
      reservation_type,
      amount_pence,
      currency,
      status,
      idempotency_key,
      reservation_fingerprint,
      reserved_at,
      metadata
    ) VALUES (
      v_item.id,
      v_item.batch_id,
      v_item.driver_id,
      v_wallet.id,
      'DRIVER_PAYOUT',
      v_amount,
      v_currency,
      'ACTIVE',
      v_idempotency,
      v_fingerprint,
      v_now,
      jsonb_build_object('slice', 6, 'hold_model', 'PAYOUT_RESERVATION_HOLD')
    )
    RETURNING id INTO v_res_id;
  END IF;

  -- Audit hold ledger row (excluded from live balance)
  INSERT INTO public.driver_wallet_ledger (
    driver_id, type, amount_pence, currency, description, created_at
  ) VALUES (
    v_item.driver_id,
    'PAYOUT_RESERVATION_HOLD',
    v_amount,
    lower(v_currency),
    'Slice 6 payout reservation hold for item ' || v_item.id::text,
    v_now
  )
  RETURNING id INTO v_hold_id;

  UPDATE public.driver_payout_reservations
  SET hold_ledger_entry_id = v_hold_id,
      updated_at = v_now
  WHERE id = v_res_id;

  UPDATE public.payout_items
  SET status = 'RESERVED',
      execution_status = 'BLOCKED_EXECUTION_DISABLED',
      error_message = NULL,
      updated_at = v_now
  WHERE id = v_item.id;

  UPDATE public.payout_batches
  SET status = 'FUNDS_RESERVED_EXECUTION_DISABLED',
      failure_code = 'FUNDS_RESERVED_EXECUTION_DISABLED',
      failure_reason = 'Funds reserved; LIVE/TRANSPORT execution disabled',
      updated_at = v_now
  WHERE id = v_batch.id;

  PERFORM public.refresh_driver_wallet_reservation_cache(v_item.driver_id);

  RETURN jsonb_build_object(
    'ok', true,
    'reused', false,
    'error_code', NULL,
    'reservation', jsonb_build_object(
      'id', v_res_id,
      'payout_item_id', v_item.id,
      'payout_batch_id', v_item.batch_id,
      'driver_id', v_item.driver_id,
      'amount_pence', v_amount,
      'currency', v_currency,
      'status', 'ACTIVE',
      'idempotency_key', v_idempotency,
      'reservation_fingerprint', v_fingerprint,
      'reserved_at', v_now,
      'hold_ledger_entry_id', v_hold_id
    ),
    'live_balance_pence', public.driver_wallet_live_balance_pence(v_item.driver_id),
    'available_pence', public.driver_wallet_available_for_payout_pence(v_item.driver_id),
    'reserved_pence', public.driver_wallet_active_reservation_pence(v_item.driver_id)
  );
EXCEPTION
  WHEN unique_violation THEN
    -- Concurrent insert lost the race — reuse winner if fingerprint matches.
    SELECT * INTO v_existing
    FROM public.driver_payout_reservations
    WHERE payout_item_id = p_payout_item_id AND status = 'ACTIVE'
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true,
        'reused', true,
        'error_code', NULL,
        'reservation', jsonb_build_object(
          'id', v_existing.id,
          'payout_item_id', v_existing.payout_item_id,
          'amount_pence', v_existing.amount_pence,
          'status', v_existing.status,
          'idempotency_key', v_existing.idempotency_key
        ),
        'live_balance_pence', public.driver_wallet_live_balance_pence(v_existing.driver_id),
        'available_pence', public.driver_wallet_available_for_payout_pence(v_existing.driver_id),
        'reserved_pence', public.driver_wallet_active_reservation_pence(v_existing.driver_id)
      );
    END IF;
    RETURN jsonb_build_object('ok', false, 'error_code', 'ACTIVE_RESERVATION_EXISTS');
END;
$$;

COMMENT ON FUNCTION public.reserve_driver_payout_item(uuid) IS
  'Slice 6: atomically reserve wallet funds for a payout item (ACTIVE hold). Idempotent. No permanent debit.';

-- ---------------------------------------------------------------------------
-- Atomic release RPC (idempotent)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_driver_payout_reservation(
  p_reservation_id uuid DEFAULT NULL,
  p_payout_item_id uuid DEFAULT NULL,
  p_release_reason text DEFAULT 'MANUAL_ADMIN_CANCEL'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res public.driver_payout_reservations%ROWTYPE;
  v_now timestamptz := now();
  v_reason text := COALESCE(NULLIF(trim(p_release_reason), ''), 'MANUAL_ADMIN_CANCEL');
BEGIN
  IF p_reservation_id IS NOT NULL THEN
    SELECT * INTO v_res
    FROM public.driver_payout_reservations
    WHERE id = p_reservation_id
    FOR UPDATE;
  ELSIF p_payout_item_id IS NOT NULL THEN
    SELECT * INTO v_res
    FROM public.driver_payout_reservations
    WHERE payout_item_id = p_payout_item_id
      AND status = 'ACTIVE'
    FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF NOT FOUND THEN
    -- Idempotent: already released / missing
    IF p_payout_item_id IS NOT NULL OR p_reservation_id IS NOT NULL THEN
      SELECT * INTO v_res
      FROM public.driver_payout_reservations
      WHERE (p_reservation_id IS NOT NULL AND id = p_reservation_id)
         OR (p_payout_item_id IS NOT NULL AND payout_item_id = p_payout_item_id)
      ORDER BY created_at DESC
      LIMIT 1;
      IF FOUND AND v_res.status = 'RELEASED' THEN
        RETURN jsonb_build_object(
          'ok', true,
          'already_released', true,
          'reservation_id', v_res.id,
          'status', 'RELEASED',
          'available_pence', public.driver_wallet_available_for_payout_pence(v_res.driver_id),
          'reserved_pence', public.driver_wallet_active_reservation_pence(v_res.driver_id),
          'live_balance_pence', public.driver_wallet_live_balance_pence(v_res.driver_id)
        );
      END IF;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF v_res.status = 'RELEASED' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_released', true,
      'reservation_id', v_res.id,
      'status', 'RELEASED',
      'available_pence', public.driver_wallet_available_for_payout_pence(v_res.driver_id),
      'reserved_pence', public.driver_wallet_active_reservation_pence(v_res.driver_id),
      'live_balance_pence', public.driver_wallet_live_balance_pence(v_res.driver_id)
    );
  END IF;

  IF v_res.status = 'CONSUMED' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF v_res.status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  UPDATE public.driver_payout_reservations
  SET status = 'RELEASED',
      released_at = v_now,
      release_reason = v_reason,
      updated_at = v_now
  WHERE id = v_res.id
    AND status = 'ACTIVE';

  IF NOT FOUND THEN
    -- Lost race — treat as already released
    RETURN jsonb_build_object(
      'ok', true,
      'already_released', true,
      'reservation_id', v_res.id
    );
  END IF;

  INSERT INTO public.driver_wallet_ledger (
    driver_id, type, amount_pence, currency, description, created_at
  ) VALUES (
    v_res.driver_id,
    'PAYOUT_RESERVATION_RELEASE',
    v_res.amount_pence,
    lower(v_res.currency),
    'Slice 6 reservation release ' || v_res.id::text || ' reason=' || v_reason,
    v_now
  );

  UPDATE public.payout_items
  SET status = 'VALIDATED',
      execution_status = 'BLOCKED_EXECUTION_DISABLED',
      updated_at = v_now
  WHERE id = v_res.payout_item_id
    AND status IN ('RESERVED', 'RESERVING', 'BLOCKED_EXECUTION_DISABLED');

  PERFORM public.refresh_driver_wallet_reservation_cache(v_res.driver_id);

  RETURN jsonb_build_object(
    'ok', true,
    'already_released', false,
    'reservation_id', v_res.id,
    'status', 'RELEASED',
    'release_reason', v_reason,
    'live_balance_pence', public.driver_wallet_live_balance_pence(v_res.driver_id),
    'available_pence', public.driver_wallet_available_for_payout_pence(v_res.driver_id),
    'reserved_pence', public.driver_wallet_active_reservation_pence(v_res.driver_id)
  );
END;
$$;

COMMENT ON FUNCTION public.release_driver_payout_reservation(uuid, uuid, text) IS
  'Slice 6: atomically release an ACTIVE reservation. Idempotent second call is no-op.';

GRANT EXECUTE ON FUNCTION public.reserve_driver_payout_item(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_driver_payout_reservation(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_live_balance_pence(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_active_reservation_pence(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_available_for_payout_pence(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Financial summary: CREATE OR REPLACE (same columns) — subtract reservations
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.driver_financial_summary AS
WITH trip_flags AS (
  SELECT
    dwl.driver_id,
    dwl.related_trip_id,
    bool_or(dwl.type = 'CASH_TRIP_EARNING')  AS is_cash,
    bool_or(dwl.type = 'TRIP_EARNING_NET')    AS is_card,
    COALESCE(SUM(CASE WHEN dwl.type = 'CASH_TRIP_EARNING'    THEN dwl.amount_pence END), 0) AS cash_gross,
    COALESCE(SUM(CASE WHEN dwl.type = 'CASH_COMMISSION_DEBT' THEN ABS(dwl.amount_pence) END), 0) AS cash_comm,
    COALESCE(SUM(CASE WHEN dwl.type = 'TRIP_EARNING_NET'     THEN dwl.amount_pence END), 0) AS card_net,
    COALESCE(SUM(CASE WHEN dwl.type = 'PLATFORM_COMMISSION'  THEN dwl.amount_pence END), 0) AS plat_comm,
    COALESCE(SUM(CASE WHEN dwl.type = 'TIP_CREDIT'           THEN dwl.amount_pence END), 0) AS tip,
    MIN(dwl.created_at) AS trip_ts
  FROM driver_wallet_ledger dwl
  WHERE dwl.related_trip_id IS NOT NULL
    AND dwl.type <> ALL (ARRAY['LEDGER_REVERSAL'::text, 'COMMISSION_RECOVERED'::text])
  GROUP BY dwl.driver_id, dwl.related_trip_id
),
trip_totals AS (
  SELECT
    driver_id,
    SUM(cash_gross)::bigint
      + SUM(CASE WHEN is_card THEN card_net + plat_comm ELSE 0 END)::bigint
      AS gross_trip_total,
    SUM(cash_gross)::bigint                                   AS cash_gross_total,
    SUM(cash_comm)::bigint                                    AS cash_commission_total,
    (SUM(cash_gross) - SUM(cash_comm))::bigint                AS cash_net_earnings,
    COUNT(*) FILTER (WHERE is_cash)                           AS cash_trip_count,
    (SUM(CASE WHEN is_card THEN card_net + plat_comm ELSE 0 END))::bigint AS card_gross_total,
    (SUM(CASE WHEN is_card THEN plat_comm ELSE 0 END))::bigint            AS card_commission_total,
    SUM(card_net)::bigint                                     AS card_net_credits,
    COUNT(*) FILTER (WHERE is_card)                           AS card_trip_count,
    (SUM(cash_comm) + SUM(CASE WHEN is_card THEN plat_comm ELSE 0 END))::bigint AS company_commission_total,
    COUNT(*)                                                  AS completed_trips,
    (SUM(CASE WHEN trip_ts >= CURRENT_DATE THEN cash_gross ELSE 0 END)
      + SUM(CASE WHEN trip_ts >= CURRENT_DATE AND is_card THEN card_net + plat_comm ELSE 0 END))::bigint
      AS today_gross_earnings,
    SUM(CASE WHEN trip_ts >= CURRENT_DATE THEN cash_gross ELSE 0 END)::bigint
      AS today_cash_earnings,
    SUM(CASE WHEN trip_ts >= CURRENT_DATE AND is_card THEN card_net ELSE 0 END)::bigint
      AS today_card_earnings,
    COUNT(*) FILTER (WHERE trip_ts >= CURRENT_DATE)           AS today_trip_count
  FROM trip_flags
  GROUP BY driver_id
),
balance_totals AS (
  SELECT
    driver_id,
    COALESCE(SUM(
      CASE WHEN type <> ALL (ARRAY[
        'PLATFORM_COMMISSION'::text,
        'CASH_TRIP_EARNING'::text,
        'PAYOUT_RESERVATION_HOLD'::text,
        'PAYOUT_RESERVATION_RELEASE'::text
      ]) THEN amount_pence ELSE 0 END
    ), 0)::bigint AS wallet_balance,
    COALESCE(SUM(CASE WHEN type = 'CASH_COMMISSION_DEBT' THEN ABS(amount_pence) ELSE 0 END), 0)::bigint AS cash_debt_created,
    COALESCE(SUM(CASE WHEN type = 'DEBT_RECOVERY' THEN ABS(amount_pence) ELSE 0 END), 0)::bigint AS debt_recovery_total,
    COALESCE(SUM(CASE WHEN type = 'COMMISSION_RECOVERED' THEN amount_pence ELSE 0 END), 0)::bigint AS commission_recovered_total,
    COALESCE(SUM(
      CASE WHEN type IN ('ADJUSTMENT', 'BONUS')
           THEN amount_pence ELSE 0 END
    ), 0)::bigint AS adjustments_total,
    COALESCE(SUM(
      CASE WHEN type IN ('PAYOUT', 'EARLY_CASHOUT', 'WEEKLY_PAYOUT', 'MANUAL_PAYOUT')
           THEN ABS(amount_pence) ELSE 0 END
    ), 0)::bigint AS total_payouts_sent,
    COALESCE(SUM(
      CASE WHEN type = 'CASHOUT_FEE'
           THEN ABS(amount_pence) ELSE 0 END
    ), 0)::bigint AS total_fees
  FROM driver_wallet_ledger
  GROUP BY driver_id
),
reserved_cashout_totals AS (
  SELECT
    driver_id,
    COALESCE(SUM(requested_cashout_pence), 0)::bigint AS reserved_cashout_pence
  FROM driver_early_cashouts
  WHERE status IN ('pending', 'processing')
  GROUP BY driver_id
),
reserved_payout_totals AS (
  SELECT
    driver_id,
    COALESCE(SUM(amount_pence), 0)::bigint AS reserved_payout_pence
  FROM driver_payout_reservations
  WHERE status = 'ACTIVE'
  GROUP BY driver_id
)
SELECT
  d.id                                                       AS driver_id,
  d.first_name,
  d.last_name,
  d.email,
  d.phone,
  d.is_online,
  d.rating,
  d.approval_status,
  d.stripe_account_id,
  d.payouts_enabled,
  d.onboarding_complete,
  COALESCE(sa.currency_code, r.currency_code, 'GBP'::text)  AS currency_code,
  d.region_id,
  COALESCE(tt.gross_trip_total, 0::bigint)                   AS gross_trip_total,
  COALESCE(tt.completed_trips, 0)::integer                   AS completed_trips,
  COALESCE(tt.card_net_credits, 0::bigint)                   AS card_net_credits,
  COALESCE(tt.card_gross_total, 0::bigint)                   AS card_gross_total,
  COALESCE(tt.card_commission_total, 0::bigint)              AS card_commission_total,
  COALESCE(tt.card_trip_count, 0)::integer                   AS card_trip_count,
  COALESCE(tt.cash_gross_total, 0::bigint)                   AS cash_gross_total,
  COALESCE(tt.cash_net_earnings, 0::bigint)                  AS cash_net_earnings,
  COALESCE(tt.cash_commission_total, 0::bigint)              AS cash_commission_debits,
  COALESCE(tt.cash_trip_count, 0)::integer                   AS cash_trip_count,
  COALESCE(tt.company_commission_total, 0::bigint)           AS company_commission_total,
  COALESCE(tt.today_gross_earnings, 0::bigint)               AS today_gross_earnings,
  COALESCE(tt.today_cash_earnings, 0::bigint)                AS today_cash_earnings,
  COALESCE(tt.today_card_earnings, 0::bigint)                AS today_card_earnings,
  COALESCE(tt.today_trip_count, 0)::integer                  AS today_trip_count,
  COALESCE(bt.adjustments_total, 0::bigint)                  AS adjustments_total,
  COALESCE(bt.total_payouts_sent, 0::bigint)                 AS total_payouts_sent,
  COALESCE(bt.total_fees, 0::bigint)                         AS total_fees,
  COALESCE(bt.wallet_balance, 0::bigint)                     AS wallet_balance,
  GREATEST(
    COALESCE(bt.wallet_balance, 0::bigint)
      - COALESCE(rc.reserved_cashout_pence, 0::bigint)
      - COALESCE(rp.reserved_payout_pence, 0::bigint),
    0::bigint
  )                                                          AS available_for_payout,
  COALESCE(rc.reserved_cashout_pence, 0::bigint)
    + COALESCE(rp.reserved_payout_pence, 0::bigint)          AS reserved_cashout_pence,
  GREATEST(
    COALESCE(bt.wallet_balance, 0::bigint)
      - COALESCE(rc.reserved_cashout_pence, 0::bigint)
      - COALESCE(rp.reserved_payout_pence, 0::bigint),
    0::bigint
  )                                                          AS net_available_for_payout,
  GREATEST(
    COALESCE(bt.cash_debt_created, 0::bigint)
      - COALESCE(bt.debt_recovery_total, 0::bigint),
    0::bigint
  )                                                          AS amount_owed_to_onecab
FROM drivers d
  LEFT JOIN service_areas sa ON sa.id = d.service_area_id
  LEFT JOIN regions r ON r.id = d.region_id
  LEFT JOIN trip_totals tt ON tt.driver_id = d.id
  LEFT JOIN balance_totals bt ON bt.driver_id = d.id
  LEFT JOIN reserved_cashout_totals rc ON rc.driver_id = d.id
  LEFT JOIN reserved_payout_totals rp ON rp.driver_id = d.id;

COMMENT ON VIEW public.driver_financial_summary IS
  'Slice 6: live wallet_balance (HOLD excluded). net_available = live - early cashout - ACTIVE payout reservations. reserved_cashout_pence includes both hold types.';

-- Update recalculate to exclude hold ledger types; pending = ACTIVE reservations
CREATE OR REPLACE FUNCTION public.recalculate_driver_wallet(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.refresh_driver_wallet_reservation_cache(p_driver_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_recalculate_wallet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_driver_id := OLD.driver_id;
  ELSE
    v_driver_id := NEW.driver_id;
  END IF;
  PERFORM public.refresh_driver_wallet_reservation_cache(v_driver_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$function$;

COMMIT;
