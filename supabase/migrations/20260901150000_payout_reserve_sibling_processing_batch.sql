-- Allow reserve_driver_payout_item to reserve sibling items while batch is PROCESSING.
-- Fixes BATCH_NOT_ELIGIBLE when item 1 is already submitted and batch moved to PROCESSING.
-- Enforces lineage, no duplicate provider intent, and preserves PROCESSING batch status.

BEGIN;

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
  v_batch_live_in_flight boolean;
  v_item_exec_status text;
BEGIN
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

  v_batch_live_in_flight := upper(coalesce(v_batch.status, '')) IN ('PROCESSING', 'RESERVING');

  IF v_batch.kind IS DISTINCT FROM 'WEEKLY_SCHEDULED'
     AND v_batch.kind IS DISTINCT FROM 'WEEKLY_MONDAY' THEN
    IF v_batch.kind IS DISTINCT FROM 'WEEKLY_SCHEDULED' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
    END IF;
  END IF;

  IF upper(coalesce(v_batch.status, '')) IN (
    'COMPLETED', 'CANCELLED', 'CANCELED', 'FAILED', 'FAILED_PERMANENT', 'FAILED_TERMINAL', 'REVERSED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
  END IF;

  IF v_batch.status NOT IN (
    'BLOCKED_EXECUTION_DISABLED',
    'FUNDS_RESERVED_EXECUTION_DISABLED',
    'ITEMS_CREATED',
    'VALIDATED',
    'RESERVED',
    'RESERVING',
    'PROCESSING'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
  END IF;

  IF upper(coalesce(v_item.status, '')) IN (
    'PAID', 'COMPLETED', 'SUBMITTED', 'SUBMITTING', 'SENT', 'CANCELLED', 'REVERSED', 'PROCESSING'
  ) OR lower(coalesce(v_item.status, '')) IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF upper(coalesce(v_item.status, '')) NOT IN (
    'VALIDATED', 'BLOCKED_EXECUTION_DISABLED', 'RESERVING', 'RESERVED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.driver_payout_payment_intents i
    WHERE i.payout_item_id = v_item.id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PROVIDER_INTENT_EXISTS');
  END IF;

  v_amount := COALESCE(v_item.amount_pence, v_item.net_driver_payout_pence, 0);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'AMOUNT_MISMATCH');
  END IF;

  v_currency := upper(COALESCE(NULLIF(trim(v_item.currency), ''), 'GBP'));
  IF v_currency <> 'GBP' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CURRENCY_MISMATCH');
  END IF;

  BEGIN
    PERFORM public.assert_payout_item_ledger_lineage(p_payout_item_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', CASE
        WHEN SQLERRM LIKE '%FINANCIAL_MODEL_VIOLATION%' THEN 'FINANCIAL_MODEL_VIOLATION'
        WHEN SQLERRM LIKE '%PAYOUT_LINEAGE_MISMATCH%' THEN 'PAYOUT_LINEAGE_MISMATCH'
        WHEN SQLERRM LIKE '%PAYOUT_LINEAGE_MISSING%' THEN 'PAYOUT_LINEAGE_MISSING'
        ELSE 'PAYOUT_LINEAGE_VALIDATION_FAILED'
      END,
      'message', SQLERRM
    );
  END;

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

  v_item_exec_status := CASE
    WHEN v_batch_live_in_flight THEN 'RESERVED'
    ELSE 'BLOCKED_EXECUTION_DISABLED'
  END;

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
          execution_status = v_item_exec_status,
          updated_at = v_now
      WHERE id = v_item.id
        AND status IS DISTINCT FROM 'RESERVED';

      IF NOT v_batch_live_in_flight THEN
        UPDATE public.payout_batches
        SET status = 'FUNDS_RESERVED_EXECUTION_DISABLED',
            failure_code = 'FUNDS_RESERVED_EXECUTION_DISABLED',
            failure_reason = 'Funds reserved; LIVE/TRANSPORT execution disabled',
            updated_at = v_now
        WHERE id = v_batch.id
          AND status IS DISTINCT FROM 'FUNDS_RESERVED_EXECUTION_DISABLED';
      END IF;

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
      NULL;
    ELSE
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'ACTIVE_RESERVATION_EXISTS',
        'reservation_id', v_existing.id
      );
    END IF;
  END IF;

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
      execution_status = v_item_exec_status,
      error_message = NULL,
      updated_at = v_now
  WHERE id = v_item.id;

  IF NOT v_batch_live_in_flight THEN
    UPDATE public.payout_batches
    SET status = 'FUNDS_RESERVED_EXECUTION_DISABLED',
        failure_code = 'FUNDS_RESERVED_EXECUTION_DISABLED',
        failure_reason = 'Funds reserved; LIVE/TRANSPORT execution disabled',
        updated_at = v_now
    WHERE id = v_batch.id;
  END IF;

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
  'Atomically reserve wallet funds for a payout item. Allows sibling reserve while batch is PROCESSING. Idempotent. No permanent debit.';

COMMIT;
