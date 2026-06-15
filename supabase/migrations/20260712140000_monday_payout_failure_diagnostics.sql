-- Monday payout failure diagnostics — SSOT fields on payout_items + wallet return ledger type.

-- 1) Ledger type for failed payout fund return
ALTER TABLE public.driver_wallet_ledger DROP CONSTRAINT IF EXISTS driver_wallet_ledger_type_check;
ALTER TABLE public.driver_wallet_ledger ADD CONSTRAINT driver_wallet_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET', 'CASH_TRIP_EARNING', 'CASH_COMMISSION_DEBT',
    'DRIVER_TIP_CREDIT', 'TIP_CREDIT', 'PLATFORM_COMMISSION', 'COMPANY_COMMISSION',
    'WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'CASHOUT_FEE',
    'ADJUSTMENT', 'REFUND_DEBIT', 'PAYOUT', 'MANUAL_PAYOUT',
    'BONUS', 'DEBT_RECOVERY', 'PAYOUT_FAILED_RETURN'
  ]));

-- 2) Payout item diagnostics (Monday + all admin payouts)
ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS settlement_status TEXT,
  ADD COLUMN IF NOT EXISTS gross_payable_pence BIGINT,
  ADD COLUMN IF NOT EXISTS cash_commission_recovered_pence BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_driver_payout_pence BIGINT,
  ADD COLUMN IF NOT EXISTS driver_paid_out_pence BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_payout_amount_pence BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS returned_to_wallet_pence BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_reference TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS return_ledger_entry_id UUID REFERENCES public.driver_wallet_ledger(id);

ALTER TABLE public.payout_items DROP CONSTRAINT IF EXISTS payout_items_settlement_status_check;
ALTER TABLE public.payout_items ADD CONSTRAINT payout_items_settlement_status_check
  CHECK (
    settlement_status IS NULL
    OR settlement_status = ANY (ARRAY[
      'PENDING', 'PROCESSING', 'COMPLETE', 'FAILED', 'PARTIAL_SETTLEMENT'
    ])
  );

COMMENT ON COLUMN public.payout_items.settlement_status IS
  'PARTIAL_SETTLEMENT when ONECAB commission was recovered but driver bank payout did not complete.';
COMMENT ON COLUMN public.payout_items.failed_payout_amount_pence IS
  'Net driver payout that failed — driver_paid_out_pence must be 0 when this is set.';
COMMENT ON COLUMN public.payout_items.returned_to_wallet_pence IS
  'Amount credited back to driver wallet after provider payout failure.';

-- 3) Batch-level partial settlement marker
ALTER TABLE public.payout_batches DROP CONSTRAINT IF EXISTS payout_batches_status_check;
ALTER TABLE public.payout_batches ADD CONSTRAINT payout_batches_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'partial', 'PARTIAL_SETTLEMENT'
  ]));

-- 4) Return failed payout amount to driver wallet (idempotent)
CREATE OR REPLACE FUNCTION public.return_failed_payout_to_wallet(p_payout_item_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item payout_items%ROWTYPE;
  v_batch payout_batches%ROWTYPE;
  v_return_pence BIGINT;
  v_ledger_id UUID;
  v_currency TEXT := 'gbp';
BEGIN
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
$$;

COMMENT ON FUNCTION public.return_failed_payout_to_wallet IS
  'Credits failed net driver payout back to wallet. Idempotent — safe to retry.';

-- 5) Retry payout item (resets failed item to pending for admin-driver-payout retry)
CREATE OR REPLACE FUNCTION public.ops_retry_failed_payout_item(p_payout_item_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item payout_items%ROWTYPE;
BEGIN
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
$$;
