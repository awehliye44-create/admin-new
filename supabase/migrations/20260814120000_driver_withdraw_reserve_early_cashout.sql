-- Driver Withdraw (Revolut): allow EARLY_CASHOUT batches to use the same
-- reservation SSOT as weekly payouts. Preserve ACTIVE_RESERVATION_EXISTS race.
-- Also: completion idempotency + wallet SSOT in-flight/provider gates for Revolut Withdraw.
-- Isolated migration — do not bundle with unrelated finance WIP.

BEGIN;

CREATE OR REPLACE FUNCTION public.reserve_driver_payout_item(p_payout_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Weekly scheduled + Driver Withdraw (EARLY_CASHOUT) share the same reservation SSOT.
  -- WEEKLY_MONDAY remains non-reservable (legacy read-only).
  IF v_batch.kind IS DISTINCT FROM 'WEEKLY_SCHEDULED'
     AND v_batch.kind IS DISTINCT FROM 'EARLY_CASHOUT' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
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
$function$;

CREATE OR REPLACE FUNCTION public.finalize_driver_payout_completion(p_payout_item_id uuid, p_provider_payment_id text, p_provider_state text, p_provider_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_evidence_redacted jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_batch public.payout_batches%ROWTYPE;
  v_intent public.driver_payout_payment_intents%ROWTYPE;
  v_res public.driver_payout_reservations%ROWTYPE;
  v_intent_id UUID;
  v_res_id UUID;
  v_state TEXT := lower(btrim(COALESCE(p_provider_state, '')));
  v_pay_id TEXT := btrim(COALESCE(p_provider_payment_id, ''));
  v_now TIMESTAMPTZ := now();
  v_ledger_type TEXT;
  v_ledger_id UUID;
  v_existing_ledger UUID;
  v_debit INTEGER;
  v_live BIGINT;
  v_reserved BIGINT;
  v_avail BIGINT;
  v_idem TEXT;
  v_desc TEXT;
  v_completed_at TIMESTAMPTZ;
BEGIN
  -- HARD RULE: only canonical Revolut completed may finalise.
  IF v_state IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PROVIDER_NOT_COMPLETED',
      'message', format(
        'Provider state %L must never consume reservation or debit wallet',
        COALESCE(NULLIF(v_state, ''), 'unknown')
      ),
      'provider_state', NULLIF(v_state, ''),
      'wallet_debited', false,
      'reservation_consumed', false,
      'financially_applied', false
    );
  END IF;

  IF v_pay_id = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'MISSING_PROVIDER_PAYMENT_ID',
      'message', 'provider_payment_id required',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  -- Lock item first, then intent + reservation (serialises retries / concurrent webhooks).
  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'VALIDATION_FAILED',
      'message', 'payout item not found'
    );
  END IF;

  SELECT * INTO v_batch
  FROM public.payout_batches
  WHERE id = v_item.batch_id
  FOR UPDATE;

  SELECT id INTO v_intent_id
  FROM public.driver_payout_payment_intents
  WHERE payout_item_id = p_payout_item_id
  ORDER BY
    CASE WHEN execution_status IN ('SUBMITTED', 'UNKNOWN', 'COMPLETED') THEN 0 ELSE 1 END,
    created_at DESC
  LIMIT 1;

  IF v_intent_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_ITEM_NOT_SUBMITTED',
      'message', 'payment intent not found',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  SELECT * INTO v_intent
  FROM public.driver_payout_payment_intents
  WHERE id = v_intent_id
  FOR UPDATE;

  -- Prefer ACTIVE reservation; allow CONSUMED for idempotent reuse.
  SELECT id INTO v_res_id
  FROM public.driver_payout_reservations
  WHERE payout_item_id = p_payout_item_id
    AND status IN ('ACTIVE', 'CONSUMED')
  ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1;

  IF v_res_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'RESERVATION_NOT_ACTIVE',
      'message', 'no ACTIVE/CONSUMED reservation for item',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  SELECT * INTO v_res
  FROM public.driver_payout_reservations
  WHERE id = v_res_id
  FOR UPDATE;

  -- Idempotent reuse: already financially applied.
  IF v_intent.financially_applied_at IS NOT NULL
     AND v_res.status = 'CONSUMED'
     AND v_intent.financial_application_ledger_entry_id IS NOT NULL
  THEN
    IF v_intent.provider_payment_id IS DISTINCT FROM v_pay_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'PROVIDER_PAYMENT_ID_MISMATCH',
        'message', 'already applied under a different provider_payment_id'
      );
    END IF;

    v_live := public.driver_wallet_live_balance_pence(v_item.driver_id);
    v_reserved := public.driver_wallet_active_reservation_pence(v_item.driver_id);
    v_avail := public.driver_wallet_available_for_payout_pence(v_item.driver_id);

    RETURN jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'reused', true,
      'payout_item_id', p_payout_item_id,
      'intent_id', v_intent.id,
      'reservation_id', v_res.id,
      'reservation_status', 'CONSUMED',
      'execution_status', 'COMPLETED',
      'item_status', 'COMPLETED',
      'provider_payment_id', v_intent.provider_payment_id,
      'provider_state', 'completed',
      'ledger_entry_id', v_intent.financial_application_ledger_entry_id,
      'ledger_type', 'WEEKLY_PAYOUT',
      'amount_pence', v_item.amount_pence,
      'currency', upper(COALESCE(v_item.currency, 'GBP')),
      'wallet_debited', true,
      'reservation_consumed', true,
      'financially_applied', true,
      'financially_applied_at', v_intent.financially_applied_at,
      'provider_completed_at', v_intent.provider_completed_at,
      'live_balance_pence', v_live,
      'active_reservation_pence', v_reserved,
      'available_pence', v_avail
    );
  END IF;

  -- Partial-state recovery still requires matches below.
  IF v_intent.provider_payment_id IS NOT NULL
     AND v_intent.provider_payment_id IS DISTINCT FROM v_pay_id
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PROVIDER_PAYMENT_ID_MISMATCH',
      'message', 'provider_payment_id does not match intent',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  IF upper(COALESCE(v_item.status, '')) NOT IN ('SUBMITTED', 'UNKNOWN', 'COMPLETED') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_ITEM_NOT_SUBMITTED',
      'message', format('item status %L not eligible', v_item.status),
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  IF upper(COALESCE(v_intent.execution_status, '')) NOT IN ('SUBMITTED', 'UNKNOWN', 'COMPLETED') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_ITEM_NOT_SUBMITTED',
      'message', format('intent status %L not eligible', v_intent.execution_status),
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  IF v_res.status NOT IN ('ACTIVE', 'CONSUMED') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'RESERVATION_NOT_ACTIVE',
      'message', format('reservation status %L', v_res.status),
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  IF v_res.driver_id IS DISTINCT FROM v_item.driver_id
     OR v_intent.driver_id IS DISTINCT FROM v_item.driver_id
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'DRIVER_MISMATCH',
      'message', 'driver_id mismatch across item/intent/reservation'
    );
  END IF;

  IF v_res.amount_pence IS DISTINCT FROM v_item.amount_pence
     OR v_intent.amount_pence IS DISTINCT FROM v_item.amount_pence
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'AMOUNT_MISMATCH',
      'message', format(
        'amount mismatch item=%s reservation=%s intent=%s',
        v_item.amount_pence, v_res.amount_pence, v_intent.amount_pence
      )
    );
  END IF;

  IF upper(COALESCE(v_item.currency, 'GBP')) <> 'GBP'
     OR upper(COALESCE(v_res.currency, 'GBP')) <> 'GBP'
     OR upper(COALESCE(v_intent.currency, 'GBP')) <> 'GBP'
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'CURRENCY_MISMATCH',
      'message', 'currency must be GBP'
    );
  END IF;

  v_ledger_type := public.payout_batch_kind_to_ledger_type(COALESCE(v_batch.kind, 'WEEKLY_SCHEDULED'));
  -- Permanent debit must reduce live balance (never hold types).
  IF v_ledger_type IN ('PAYOUT_RESERVATION_HOLD', 'PAYOUT_RESERVATION_RELEASE') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'VALIDATION_FAILED',
      'message', 'hold ledger types cannot finalise completion'
    );
  END IF;

  v_debit := -ABS(v_item.amount_pence);
  v_idem := 'revolut-payout-completion:' || v_pay_id;
  v_desc := format(
    'Revolut payout completion debit item=%s payment=%s reservation=%s',
    p_payout_item_id, v_pay_id, v_res.id
  );
  v_completed_at := COALESCE(p_provider_completed_at, v_now);

  -- Idempotent debit by Revolut payment id (stored in provider_payout_id column).
  SELECT id INTO v_existing_ledger
  FROM public.driver_wallet_ledger
  WHERE provider_payout_id = v_pay_id
    AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    AND amount_pence < 0
  LIMIT 1;

  IF v_existing_ledger IS NOT NULL THEN
    v_ledger_id := v_existing_ledger;
  ELSE
    INSERT INTO public.driver_wallet_ledger (
      driver_id,
      type,
      amount_pence,
      currency,
      description,
      provider_payout_id,
      created_at
    ) VALUES (
      v_item.driver_id,
      v_ledger_type,
      v_debit,
      'GBP',
      v_desc,
      v_pay_id,
      v_completed_at
    )
    RETURNING id INTO v_ledger_id;
  END IF;

  -- Consume reservation (or verify already consumed with same debit).
  IF v_res.status = 'ACTIVE' THEN
    UPDATE public.driver_payout_reservations
    SET
      status = 'CONSUMED',
      consumed_at = COALESCE(consumed_at, v_now),
      debit_ledger_entry_id = v_ledger_id,
      provider_payment_id = v_pay_id,
      completion_idempotency_key = v_idem,
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'slice', 8,
        'consumed_via', 'finalize_driver_payout_completion',
        'provider_payment_id', v_pay_id,
        'ledger_entry_id', v_ledger_id
      ),
      updated_at = v_now
    WHERE id = v_res.id
    RETURNING * INTO v_res;
  ELSIF v_res.status = 'CONSUMED' THEN
    IF v_res.debit_ledger_entry_id IS NOT NULL
       AND v_res.debit_ledger_entry_id IS DISTINCT FROM v_ledger_id
    THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'INVARIANT_PARTIAL_STATE',
        'message', 'CONSUMED reservation linked to a different debit'
      );
    END IF;
    UPDATE public.driver_payout_reservations
    SET
      debit_ledger_entry_id = COALESCE(debit_ledger_entry_id, v_ledger_id),
      provider_payment_id = COALESCE(provider_payment_id, v_pay_id),
      completion_idempotency_key = COALESCE(completion_idempotency_key, v_idem),
      updated_at = v_now
    WHERE id = v_res.id
    RETURNING * INTO v_res;
  END IF;

  -- Mark intent completed + financially applied.
  UPDATE public.driver_payout_payment_intents
  SET
    execution_status = 'COMPLETED',
    provider_payment_id = v_pay_id,
    provider_state = 'completed',
    provider_completed_at = COALESCE(provider_completed_at, v_completed_at),
    last_provider_sync_at = v_now,
    financially_applied_at = COALESCE(financially_applied_at, v_now),
    financial_application_ledger_entry_id = v_ledger_id,
    completion_evidence_redacted = COALESCE(p_evidence_redacted, '{}'::jsonb),
    updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  UPDATE public.payout_items
  SET
    status = 'COMPLETED',
    execution_status = 'COMPLETED',
    ledger_entry_id = COALESCE(ledger_entry_id, v_ledger_id),
    completed_at = COALESCE(completed_at, v_now),
    wallet_recalculated_at = v_now,
    ledger_sync_error = NULL,
    updated_at = v_now
  WHERE id = p_payout_item_id
  RETURNING * INTO v_item;

  -- Recalculate liabilities from ledger (live + reserved cache).
  PERFORM public.refresh_driver_wallet_reservation_cache(v_item.driver_id);
  BEGIN
    PERFORM public.recalculate_driver_wallet(v_item.driver_id);
  EXCEPTION WHEN OTHERS THEN
    -- refresh_driver_wallet_reservation_cache already set ledger-derived available/pending.
    NULL;
  END;

  v_live := public.driver_wallet_live_balance_pence(v_item.driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(v_item.driver_id);
  v_avail := public.driver_wallet_available_for_payout_pence(v_item.driver_id);

  -- Batch status: keep non-automatic; reflect partial provider completion.
  UPDATE public.payout_batches
  SET
    status = CASE
      WHEN EXISTS (
        SELECT 1 FROM public.driver_payout_reservations r
        WHERE r.payout_batch_id = v_item.batch_id AND r.status = 'ACTIVE'
      ) THEN 'PROVIDER_SUBMISSION_PARTIAL'
      ELSE COALESCE(status, 'PROVIDER_SUBMISSION_PARTIAL')
    END,
    updated_at = v_now
  WHERE id = v_item.batch_id
    AND status IN (
      'PROVIDER_SUBMISSION_IN_PROGRESS',
      'PROVIDER_SUBMISSION_PARTIAL',
      'FUNDS_RESERVED_EXECUTION_DISABLED'
    );

  RETURN jsonb_build_object(
    'ok', true,
    'already_applied', false,
    'reused', v_existing_ledger IS NOT NULL AND v_res.status = 'CONSUMED',
    'payout_item_id', p_payout_item_id,
    'intent_id', v_intent.id,
    'reservation_id', v_res.id,
    'reservation_status', 'CONSUMED',
    'execution_status', 'COMPLETED',
    'item_status', 'COMPLETED',
    'provider_payment_id', v_pay_id,
    'provider_state', 'completed',
    'ledger_entry_id', v_ledger_id,
    'ledger_type', v_ledger_type,
    'amount_pence', v_item.amount_pence,
    'currency', 'GBP',
    'wallet_debited', true,
    'reservation_consumed', true,
    'financially_applied', true,
    'financially_applied_at', v_intent.financially_applied_at,
    'provider_completed_at', v_intent.provider_completed_at,
    'live_balance_pence', v_live,
    'active_reservation_pence', v_reserved,
    'available_pence', v_avail,
    'revolut_pay_called', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.driver_wallet_summary_ssot(p_driver_id uuid, p_service_area_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_currency text := 'GBP';
  v_timezone text := 'Europe/London';
  v_cycle_start timestamptz := '1970-01-01 00:00:00+00'::timestamptz;
  v_cycle_end timestamptz := now();
  v_cycle_earnings bigint := 0;
  v_today_earnings bigint := 0;
  v_live bigint := 0;
  v_reserved bigint := 0;
  v_other_holds bigint := 0;
  v_available bigint := 0;
  v_minimum bigint := 2000;
  v_amount_needed bigint := 0;
  v_eligibility text := 'NOT_CURRENTLY_ELIGIBLE';
  v_next_payout timestamptz := NULL;
  v_today_start timestamptz;
  v_today_end timestamptz;
  v_early_enabled boolean := false;
  v_early_fee bigint := 50;
  v_early_available bigint := 0;
  v_early_minimum bigint := 51;
  v_early_eligible boolean := false;
  v_early_block text := NULL;
  v_early_provider text := NULL;
  v_dest_verified boolean := false;
  v_cashout_processing boolean := false;
  v_payout_gateway text := NULL;
BEGIN
  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'driver_not_found',
      'driver_id', p_driver_id
    );
  END IF;

  SELECT COALESCE(sa.currency_code, r.currency_code, 'GBP')
  INTO v_currency
  FROM public.drivers d
  LEFT JOIN public.service_areas sa ON sa.id = COALESCE(p_service_area_id, d.service_area_id)
  LEFT JOIN public.regions r ON r.id = d.region_id
  WHERE d.id = p_driver_id;

  SELECT COALESCE(
    (SELECT timezone FROM public.service_areas WHERE id = COALESCE(p_service_area_id, v_driver.service_area_id)),
    (SELECT r.timezone FROM public.regions r WHERE r.id = v_driver.region_id),
    'Europe/London'
  ) INTO v_timezone;

  SELECT COALESCE(sa.early_cashout_enabled, false)
  INTO v_early_enabled
  FROM public.drivers d
  LEFT JOIN public.service_areas sa ON sa.id = COALESCE(p_service_area_id, d.service_area_id)
  WHERE d.id = p_driver_id;

  SELECT MAX(created_at) INTO v_cycle_start
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND type IN ('WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'MANUAL_PAYOUT', 'PAYOUT')
    AND amount_pence < 0;

  v_cycle_start := COALESCE(v_cycle_start, '1970-01-01 00:00:00+00'::timestamptz);

  WITH deduped AS (
    SELECT DISTINCT ON (related_trip_id, type)
      amount_pence,
      created_at
    FROM public.driver_wallet_ledger
    WHERE driver_id = p_driver_id
      AND type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT')
      AND related_trip_id IS NOT NULL
      AND created_at >= v_cycle_start
    ORDER BY related_trip_id, type, created_at DESC
  )
  SELECT COALESCE(SUM(amount_pence), 0)::bigint INTO v_cycle_earnings
  FROM deduped;

  v_today_start := (
    (timezone(v_timezone, now()))::date::text || ' 00:00:00'
  )::timestamp AT TIME ZONE v_timezone;
  v_today_end := v_today_start + interval '1 day';

  WITH deduped_today AS (
    SELECT DISTINCT ON (related_trip_id, type)
      amount_pence
    FROM public.driver_wallet_ledger
    WHERE driver_id = p_driver_id
      AND type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT')
      AND related_trip_id IS NOT NULL
      AND created_at >= v_today_start
      AND created_at < v_today_end
    ORDER BY related_trip_id, type, created_at DESC
  )
  SELECT COALESCE(SUM(amount_pence), 0)::bigint INTO v_today_earnings
  FROM deduped_today;

  v_live := public.driver_wallet_live_balance_pence(p_driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(p_driver_id);
  v_other_holds := public.driver_wallet_other_holds_pence(p_driver_id);
  v_available := GREATEST(0, v_live - v_reserved)::bigint;
  v_amount_needed := GREATEST(0, v_minimum - v_available)::bigint;

  IF v_reserved > 0 THEN
    v_eligibility := 'RESERVED_FOR_PAYOUT';
  ELSIF v_available >= v_minimum THEN
    v_eligibility := 'ELIGIBLE';
  ELSIF v_available > 0 THEN
    v_eligibility := 'BELOW_MINIMUM_THRESHOLD';
  ELSE
    v_eligibility := 'NOT_CURRENTLY_ELIGIBLE';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.driver_early_cashouts
    WHERE driver_id = p_driver_id
      AND status IN ('pending', 'processing')
  )
  OR EXISTS (
    SELECT 1
    FROM public.payout_items pi
    JOIN public.payout_batches pb ON pb.id = pi.batch_id
    WHERE pi.driver_id = p_driver_id
      AND pb.kind = 'EARLY_CASHOUT'
      AND upper(COALESCE(pi.status, '')) IN (
        'VALIDATED', 'RESERVING', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN'
      )
  )
  OR EXISTS (
    SELECT 1
    FROM public.driver_payout_reservations r
    WHERE r.driver_id = p_driver_id
      AND r.status = 'ACTIVE'
  ) INTO v_cashout_processing;

  SELECT EXISTS (
    SELECT 1
    FROM public.driver_payout_destinations dpd
    WHERE dpd.driver_id = p_driver_id
      AND dpd.is_active IS TRUE
      AND dpd.archived_at IS NULL
      AND upper(coalesce(dpd.provider_link_status, '')) = 'PROVIDER_VERIFIED'
  ) INTO v_dest_verified;

  SELECT NULLIF(trim(coalesce(payment_provider, '')), '')
  INTO v_early_provider
  FROM public.service_areas
  WHERE id = COALESCE(p_service_area_id, v_driver.service_area_id);

  v_early_available := GREATEST(0, v_live - v_reserved - v_other_holds)::bigint;

  IF NOT v_early_enabled THEN
    v_early_block := 'FEATURE_DISABLED';
  ELSIF upper(v_currency) <> 'GBP' THEN
    v_early_block := 'CURRENCY_MISMATCH';
  ELSIF COALESCE(v_driver.payouts_enabled, false) IS NOT TRUE THEN
    v_early_block := 'DRIVER_SUSPENDED';
  ELSIF v_cashout_processing THEN
    v_early_block := 'CASHOUT_ALREADY_PROCESSING';
  ELSIF NOT v_dest_verified THEN
    v_early_block := 'PAYOUT_ACCOUNT_NOT_VERIFIED';
  ELSIF v_early_provider IS NULL
       OR lower(v_early_provider) IS DISTINCT FROM 'revolut' THEN
    v_early_block := 'PROVIDER_UNAVAILABLE';
  ELSIF v_reserved > 0 AND v_early_available <= 0 THEN
    v_early_block := 'ACTIVE_PAYOUT_RESERVATION';
  ELSIF v_early_available <= 0 THEN
    v_early_block := 'NO_AVAILABLE_BALANCE';
  ELSIF v_early_available <= v_early_fee THEN
    v_early_block := 'BALANCE_NOT_GREATER_THAN_FEE';
  ELSE
    v_early_eligible := true;
    v_early_block := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'driver_id', p_driver_id,
    'service_area_id', COALESCE(p_service_area_id, v_driver.service_area_id),
    'currency', upper(COALESCE(v_currency, 'GBP')),
    'payout_cycle_start', v_cycle_start,
    'payout_cycle_end', v_cycle_end,
    'current_cycle_trip_earnings_pence', v_cycle_earnings,
    'live_wallet_balance_pence', v_live,
    'active_reserved_payout_pence', v_reserved,
    'available_for_payout_pence', v_available,
    'minimum_payout_pence', v_minimum,
    'amount_needed_for_minimum_pence', v_amount_needed,
    'payout_eligibility_status', v_eligibility,
    'next_payout_at', v_next_payout,
    'today_trip_earnings_pence', v_today_earnings,
    'early_cash_out_enabled', v_early_enabled,
    'early_cash_out_fee_pence', v_early_fee,
    'early_cash_out_available_pence', v_early_available,
    'early_cash_out_minimum_pence', v_early_minimum,
    'early_cash_out_eligible', v_early_eligible,
    'early_cash_out_block_reason', v_early_block,
    'early_cash_out_provider', v_early_provider,
    'active_weekly_reservation_pence', v_reserved,
    'early_cash_out_requested_pence', CASE WHEN v_early_eligible THEN v_early_available ELSE 0 END,
    'early_cash_out_driver_receives_pence', CASE
      WHEN v_early_eligible THEN GREATEST(0, v_early_available - v_early_fee)
      ELSE 0
    END,
    'updated_at', now(),
    'source_version', 'driver_wallet_summary_ssot_v2'
  );
END;
$function$;

COMMIT;
