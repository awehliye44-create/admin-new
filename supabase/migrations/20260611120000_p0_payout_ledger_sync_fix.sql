-- P0: Payout ledger sync — idempotency, ledger_sync_failed status, backfill + recalculate wallet.
-- Fixes completed provider payout without negative driver_wallet_ledger debit.

-- 1) Expand payout_items status
ALTER TABLE public.payout_items DROP CONSTRAINT IF EXISTS payout_items_status_check;
ALTER TABLE public.payout_items ADD CONSTRAINT payout_items_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'ledger_sync_failed'));

ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS wallet_recalculated_at timestamptz,
  ADD COLUMN IF NOT EXISTS ledger_sync_error text;

COMMENT ON COLUMN public.payout_items.wallet_recalculated_at IS
  'Set when recalculate_driver_wallet succeeded after ledger debit.';
COMMENT ON COLUMN public.payout_items.ledger_sync_error IS
  'Last ledger insert or wallet recalc failure when status = ledger_sync_failed.';

-- 2) Clear provider refs on reversed duplicate ledger rows (allows unique indexes)
UPDATE public.driver_wallet_ledger
SET stripe_transfer_id = NULL
WHERE description LIKE '[REVERSED duplicate finalization]%'
  AND stripe_transfer_id IS NOT NULL;

-- 3) Idempotency — prevent duplicate payout ledger debits
CREATE UNIQUE INDEX IF NOT EXISTS idx_dwl_payout_stripe_payout_unique
  ON public.driver_wallet_ledger (stripe_payout_id)
  WHERE type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT')
    AND stripe_payout_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dwl_payout_stripe_transfer_unique
  ON public.driver_wallet_ledger (stripe_transfer_id)
  WHERE type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    AND stripe_transfer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_items_batch_driver_amount_completed
  ON public.payout_items (batch_id, driver_id, amount_pence)
  WHERE status IN ('completed', 'ledger_sync_failed');

-- 4) Map batch kind → ledger type
CREATE OR REPLACE FUNCTION public.payout_batch_kind_to_ledger_type(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_kind = 'EARLY_CASHOUT' THEN 'EARLY_CASHOUT'
    WHEN p_kind = 'WEEKLY_MONDAY' THEN 'WEEKLY_PAYOUT'
    WHEN p_kind = 'MANUAL_ADMIN' THEN 'MANUAL_PAYOUT'
    ELSE 'PAYOUT'
  END;
$$;

-- 5) Idempotent ledger debit insert (by provider reference)
CREATE OR REPLACE FUNCTION public.insert_payout_ledger_debit_if_missing(
  p_driver_id uuid,
  p_amount_pence integer,
  p_ledger_type text,
  p_currency text,
  p_description text,
  p_stripe_transfer_id text,
  p_stripe_payout_id text,
  p_paid_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_id uuid;
  v_new_id uuid;
  v_debit integer;
BEGIN
  IF p_amount_pence >= 0 THEN
    RAISE EXCEPTION 'Payout ledger debit must be negative, got %', p_amount_pence;
  END IF;

  v_debit := p_amount_pence;

  IF p_stripe_payout_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM driver_wallet_ledger
    WHERE stripe_payout_id = p_stripe_payout_id
      AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  IF p_stripe_transfer_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM driver_wallet_ledger
    WHERE stripe_transfer_id = p_stripe_transfer_id
      AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  INSERT INTO driver_wallet_ledger (
    driver_id,
    type,
    amount_pence,
    currency,
    description,
    stripe_transfer_id,
    stripe_payout_id,
    created_at
  ) VALUES (
    p_driver_id,
    p_ledger_type,
    v_debit,
    COALESCE(NULLIF(upper(p_currency), ''), 'GBP'),
    p_description,
    p_stripe_transfer_id,
    p_stripe_payout_id,
    COALESCE(p_paid_at, now())
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- 6) Sync ledger + recalculate wallet for a payout_item
CREATE OR REPLACE FUNCTION public.sync_payout_item_ledger_debit(p_payout_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item payout_items%ROWTYPE;
  v_batch payout_batches%ROWTYPE;
  v_ledger_id uuid;
  v_ledger_type text;
  v_currency text;
  v_debit integer;
  v_driver_region text;
BEGIN
  SELECT * INTO v_item FROM payout_items WHERE id = p_payout_item_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_item_not_found');
  END IF;

  IF v_item.ledger_entry_id IS NOT NULL THEN
    PERFORM recalculate_driver_wallet(v_item.driver_id);
    UPDATE payout_items SET
      status = 'completed',
      wallet_recalculated_at = COALESCE(wallet_recalculated_at, now()),
      ledger_sync_error = NULL,
      updated_at = now()
    WHERE id = p_payout_item_id;

    RETURN jsonb_build_object(
      'success', true,
      'ledger_entry_id', v_item.ledger_entry_id,
      'already_synced', true
    );
  END IF;

  IF v_item.stripe_transfer_id IS NULL AND v_item.stripe_payout_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'missing_provider_reference',
      'detail', 'stripe_transfer_id or stripe_payout_id required'
    );
  END IF;

  SELECT * INTO v_batch FROM payout_batches WHERE id = v_item.batch_id;
  v_ledger_type := payout_batch_kind_to_ledger_type(COALESCE(v_batch.kind, 'MANUAL_ADMIN'));
  v_debit := -ABS(COALESCE(v_item.driver_amount_pence, v_item.amount_pence, 0));

  IF v_debit = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'zero_payout_amount');
  END IF;

  SELECT COALESCE(r.currency_code, 'gbp') INTO v_currency
  FROM drivers d
  LEFT JOIN regions r ON r.id = d.region_id
  WHERE d.id = v_item.driver_id;

  v_ledger_id := insert_payout_ledger_debit_if_missing(
    v_item.driver_id,
    v_debit,
    v_ledger_type,
    v_currency,
    CASE
      WHEN v_ledger_type = 'WEEKLY_PAYOUT' THEN 'Weekly payout to bank'
      WHEN v_ledger_type = 'MANUAL_PAYOUT' THEN 'Manual payout to bank'
      ELSE 'Payout to bank'
    END,
    v_item.stripe_transfer_id,
    v_item.stripe_payout_id,
    COALESCE(v_item.completed_at, now())
  );

  PERFORM recalculate_driver_wallet(v_item.driver_id);

  UPDATE payout_items SET
    status = 'completed',
    ledger_entry_id = v_ledger_id,
    wallet_recalculated_at = now(),
    ledger_sync_error = NULL,
    completed_at = COALESCE(completed_at, now()),
    updated_at = now()
  WHERE id = p_payout_item_id;

  IF v_batch.id IS NOT NULL THEN
    UPDATE payout_batches SET
      status = 'completed',
      successful_payouts = GREATEST(COALESCE(successful_payouts, 0), 1),
      failed_payouts = 0,
      completed_at = COALESCE(completed_at, now()),
      updated_at = now()
    WHERE id = v_batch.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'ledger_entry_id', v_ledger_id,
    'driver_id', v_item.driver_id,
    'amount_pence', v_debit,
    'wallet_recalculated', true
  );
EXCEPTION WHEN OTHERS THEN
  UPDATE payout_items SET
    status = 'ledger_sync_failed',
    ledger_sync_error = SQLERRM,
    updated_at = now()
  WHERE id = p_payout_item_id;

  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_payout_item_ledger_debit(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.insert_payout_ledger_debit_if_missing(uuid, integer, text, text, text, text, text, timestamptz) TO service_role;

-- 7) Backfill payout_items that have provider refs but no ledger
DO $$
DECLARE
  r record;
  v_result jsonb;
BEGIN
  FOR r IN
    SELECT pi.id
    FROM payout_items pi
    WHERE pi.ledger_entry_id IS NULL
      AND pi.status IN ('completed', 'ledger_sync_failed')
      AND (pi.stripe_transfer_id IS NOT NULL OR pi.stripe_payout_id IS NOT NULL)
  LOOP
    v_result := sync_payout_item_ledger_debit(r.id);
    RAISE NOTICE 'sync_payout_item_ledger_debit % => %', r.id, v_result;
  END LOOP;
END $$;
