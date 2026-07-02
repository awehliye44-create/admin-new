
-- Digital Finance Migration: schema additions
-- 1. Allow MIGRATION_RESET ledger type
ALTER TABLE public.driver_wallet_ledger
  DROP CONSTRAINT IF EXISTS driver_wallet_ledger_type_check;

ALTER TABLE public.driver_wallet_ledger
  ADD CONSTRAINT driver_wallet_ledger_type_check CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET','CASH_TRIP_EARNING','CASH_COMMISSION_DEBT','DRIVER_TIP_CREDIT','TIP_CREDIT',
    'PLATFORM_COMMISSION','COMPANY_COMMISSION','WEEKLY_PAYOUT','EARLY_CASHOUT','CASHOUT_FEE',
    'ADJUSTMENT','REFUND_DEBIT','PAYOUT','MANUAL_PAYOUT','PAYOUT_CREATED','BONUS','DEBT_RECOVERY',
    'PAYOUT_FAILED_RETURN','LEDGER_REVERSAL','COMMISSION_RECOVERED','MIGRATION_RESET'
  ]));

-- 2. Era views (audit-friendly)
CREATE OR REPLACE VIEW public.v_finance_era_marker
WITH (security_invoker = on) AS
SELECT
  (SELECT setting_value::text FROM public.admin_settings WHERE setting_key = 'finance_era') AS era,
  (SELECT (setting_value #>> '{}')::timestamptz FROM public.admin_settings WHERE setting_key = 'finance_era_started_at') AS started_at;

CREATE OR REPLACE VIEW public.v_finance_era_legacy_cash
WITH (security_invoker = on) AS
SELECT l.*
FROM public.driver_wallet_ledger l
LEFT JOIN public.v_finance_era_marker m ON true
WHERE m.started_at IS NULL OR l.created_at < m.started_at;

CREATE OR REPLACE VIEW public.v_finance_era_digital
WITH (security_invoker = on) AS
SELECT l.*
FROM public.driver_wallet_ledger l
JOIN public.v_finance_era_marker m ON true
WHERE m.started_at IS NOT NULL AND l.created_at >= m.started_at;

GRANT SELECT ON public.v_finance_era_marker TO authenticated;
GRANT SELECT ON public.v_finance_era_legacy_cash TO authenticated;
GRANT SELECT ON public.v_finance_era_digital TO authenticated;

-- 3. Idempotent migration RPC (super_admin only)
CREATE OR REPLACE FUNCTION public.run_digital_finance_migration()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_existing text;
  v_started_at timestamptz := now();
  v_drivers_reset int := 0;
  v_ledger_rows int := 0;
  v_payout_items_voided int := 0;
  v_payout_batches_archived int := 0;
  v_auths_cancelled int := 0;
  v_early_cashouts_cancelled int := 0;
  v_settlements_marked int := 0;
  v_currency text;
BEGIN
  -- Auth: super_admin only
  SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = v_uid AND role = 'super_admin')
    INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'forbidden: super_admin required';
  END IF;

  -- Idempotency guard
  SELECT setting_value #>> '{}' INTO v_existing
  FROM public.admin_settings WHERE setting_key = 'finance_era';
  IF v_existing = 'digital' THEN
    RAISE EXCEPTION 'digital_finance_migration_already_applied';
  END IF;

  -- Per-driver zeroing ledger insert (offsets non-excluded ledger sum)
  WITH per_driver AS (
    SELECT driver_id,
           COALESCE(SUM(amount_pence), 0) AS balance
    FROM public.driver_wallet_ledger
    WHERE type NOT IN ('PLATFORM_COMMISSION','CASH_TRIP_EARNING')
    GROUP BY driver_id
  ),
  inserted AS (
    INSERT INTO public.driver_wallet_ledger
      (driver_id, type, amount_pence, currency, description, created_at)
    SELECT
      pd.driver_id,
      'MIGRATION_RESET',
      -pd.balance,
      COALESCE(
        (SELECT l.currency FROM public.driver_wallet_ledger l
          WHERE l.driver_id = pd.driver_id AND l.currency IS NOT NULL
          ORDER BY l.created_at DESC LIMIT 1),
        'GBP'
      ),
      'Digital Finance Migration – Operational reset for transition to 100% digital payments.',
      v_started_at
    FROM per_driver pd
    WHERE pd.balance <> 0
    RETURNING driver_id
  )
  SELECT COUNT(*) INTO v_ledger_rows FROM inserted;
  v_drivers_reset := v_ledger_rows;

  -- Void orphaned payout items (no Stripe transfer)
  UPDATE public.payout_items
     SET status = 'INVALID_ORPHANED',
         updated_at = now(),
         error_message = COALESCE(error_message,'') || ' [digital_finance_migration]'
   WHERE status IN ('pending','processing','CREATED','READY','BLOCKED')
     AND (stripe_transfer_id IS NULL OR stripe_transfer_id = '');
  GET DIAGNOSTICS v_payout_items_voided = ROW_COUNT;

  -- Archive open batches with no successful children
  UPDATE public.payout_batches
     SET status = 'INVALID_ORPHANED',
         updated_at = now(),
         notes = COALESCE(notes,'') || ' [digital_finance_migration]'
   WHERE status IN ('pending','processing','CREATED','READY','BLOCKED')
     AND NOT EXISTS (
       SELECT 1 FROM public.payout_items pi
       WHERE pi.batch_id = payout_batches.id
         AND pi.stripe_transfer_id IS NOT NULL AND pi.stripe_transfer_id <> ''
     );
  GET DIAGNOSTICS v_payout_batches_archived = ROW_COUNT;

  -- Cancel pending authorizations
  UPDATE public.payout_authorization
     SET status = 'cancelled',
         invalidated_at = now(),
         invalidation_reason = 'digital_finance_migration',
         updated_at = now()
   WHERE status IN ('pending','executing','failed_retryable');
  GET DIAGNOSTICS v_auths_cancelled = ROW_COUNT;

  -- Fail-close pending early cashouts
  UPDATE public.driver_early_cashouts
     SET status = 'failed',
         failure_reason = 'digital_finance_migration',
         failed_at = now(),
         updated_at = now()
   WHERE status IN ('pending','processing');
  GET DIAGNOSTICS v_early_cashouts_cancelled = ROW_COUNT;

  -- Mark unallocated settlements ineligible (respects existing check constraint)
  UPDATE public.driver_earning_settlement
     SET eligible_for_payout = false,
         ineligible_reason = 'digital_finance_migration',
         updated_at = now()
   WHERE COALESCE(allocated_to_payout,false) = false
     AND settlement_status <> 'settled'
     AND (eligible_for_payout IS DISTINCT FROM false OR ineligible_reason IS DISTINCT FROM 'digital_finance_migration');
  GET DIAGNOSTICS v_settlements_marked = ROW_COUNT;

  -- Persist era marker
  INSERT INTO public.admin_settings (setting_key, setting_value, description)
  VALUES ('finance_era', to_jsonb('digital'::text), 'Active finance era')
  ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = EXCLUDED.setting_value, updated_at = now();

  INSERT INTO public.admin_settings (setting_key, setting_value, description)
  VALUES ('finance_era_started_at', to_jsonb(v_started_at), 'Digital finance era start timestamp')
  ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = EXCLUDED.setting_value, updated_at = now();

  RETURN jsonb_build_object(
    'ok', true,
    'started_at', v_started_at,
    'drivers_reset', v_drivers_reset,
    'ledger_rows_inserted', v_ledger_rows,
    'payout_items_voided', v_payout_items_voided,
    'payout_batches_archived', v_payout_batches_archived,
    'payout_authorizations_cancelled', v_auths_cancelled,
    'early_cashouts_cancelled', v_early_cashouts_cancelled,
    'settlements_marked_ineligible', v_settlements_marked
  );
END;
$$;

REVOKE ALL ON FUNCTION public.run_digital_finance_migration() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_digital_finance_migration() TO service_role;
