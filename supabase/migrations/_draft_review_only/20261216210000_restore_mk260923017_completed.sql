-- ============================================================
-- DRAFT / REVIEW ONLY — DO NOT APPLY WITHOUT WRITTEN APPROVAL
-- Restore MK-260923-017 to Completed (owner confirmed it was a real ride).
--
-- Evidence (audited 2026-10-13):
--   assigned 18:41:52, arrived 18:43:39, started 18:46:55, completed 18:47:22 (MK0006)
--   Revolut captured 500p (session a8399ac3…, PARTIAL_CAPTURE_ONLY, provider COMPLETED)
--   TRIP_EARNING_NET 430p for MK0006 (ledger 92121551…) written at completion
--   18:55:32 Admin cancel moved the completed trip to cancelled, nulled
--   driver_id / confirmed_driver_id and overwrote special_instructions.
--
-- Effect: trip fields only. No payment, ledger, payout or Revolut change.
-- The 430p earning and the 500p capture stay exactly as they are.
--
-- Prerequisites:
--   1. Migration 20261216200000_terminal_trip_state_lock applied (the override
--      below is how an approved historical correction passes the lock).
--   2. Run as postgres or service_role (the override is ignored for other roles).
--
-- Trigger side effects reviewed (production, 2026-10-13):
--   - enforce_digital_payment_gate passes (provider COMPLETED, 500p authorised).
--   - set_customer_active_trip_on_driver_assign points the customer at this trip
--     when driver_id is restored; step 3 undoes that.
--   - trg_trip_invoice_on_completion stores an invoice (generate_only, no email).
--   - auto_promote_driver_tier: MK0006 Platinum 43 -> 44 completed, target 50, no change.
--   - Payment disposition, Commission Wallet and cancel notifications do not fire
--     for a transition into completed.
--   - The accepted ride offer (588e5770…) stays revoked: setting it back to
--     accepted would start a driver commitment session.
--   - special_instructions before the cancel is not recoverable; it is set to ''
--     like other completed MK trips, and the overwritten text is kept in audit.
--
-- Rollback: none needed for money. To undo the trip fields, re-apply the values
-- recorded in the HISTORICAL_TRIP_RESTORED audit row under the same override.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) Preconditions — abort on any drift from the audited state
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.trips'::regclass
      AND tgname = 'zz_enforce_trip_terminal_state_lock'
  ) THEN
    RAISE EXCEPTION 'restore_aborted: terminal state lock migration 20261216200000 not applied';
  END IF;

  SELECT count(*) INTO v_n
  FROM public.trips
  WHERE id = '174df647-2417-4da3-9e55-7261a4e7d3e7'
    AND trip_code = 'MK-260923-017'
    AND status = 'cancelled'
    AND cancelled_by = 'admin'
    AND completed_at = '2026-09-23 18:47:21.979+00'
    AND started_at = '2026-09-23 18:46:55.685+00'
    AND driver_id IS NULL
    AND confirmed_driver_id IS NULL
    AND payment_status = 'captured'
    AND capture_amount_pence = 500
    AND driver_net_pence = 430
    AND financial_model = 'PLATFORM_COLLECTED';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'restore_aborted: MK-260923-017 is not in the audited cancelled state';
  END IF;

  SELECT count(*) INTO v_n
  FROM public.drivers
  WHERE id = 'c40dd8a6-f422-40bc-9534-bae7be88b93e' AND driver_code = 'MK0006';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'restore_aborted: MK0006 driver row mismatch';
  END IF;

  SELECT count(*) INTO v_n
  FROM public.driver_wallet_ledger
  WHERE related_trip_id = '174df647-2417-4da3-9e55-7261a4e7d3e7';
  IF v_n <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.driver_wallet_ledger
    WHERE id = '92121551-2fa1-44bc-9556-7f3f55ff5479'
      AND driver_id = 'c40dd8a6-f422-40bc-9534-bae7be88b93e'
      AND type = 'TRIP_EARNING_NET'
      AND amount_pence = 430
  ) THEN
    RAISE EXCEPTION 'restore_aborted: ledger for MK-260923-017 is not the single 430p TRIP_EARNING_NET';
  END IF;

  SELECT count(*) INTO v_n
  FROM public.payment_sessions
  WHERE id = 'a8399ac3-7659-4f50-9045-2d68185e6406'
    AND upper(provider_state) = 'COMPLETED'
    AND status::text = 'PARTIAL_CAPTURE_ONLY'
    AND authorised_amount_pence = 500;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'restore_aborted: payment session drifted from audited state';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Evidence row with every value this script overwrites
-- ---------------------------------------------------------------------------
INSERT INTO public.audit_logs (event_type, trip_id, driver_id, details)
SELECT
  'HISTORICAL_TRIP_RESTORED',
  t.id,
  'c40dd8a6-f422-40bc-9534-bae7be88b93e',
  jsonb_build_object(
    'trip_code', t.trip_code,
    'restored_to', 'completed',
    'approval', 'Owner approved restore to Completed keeping the 430p earning (2026-10-13)',
    'previous', jsonb_build_object(
      'status', t.status,
      'dispatch_status', t.dispatch_status,
      'negotiation_status', t.negotiation_status,
      'driver_id', t.driver_id,
      'confirmed_driver_id', t.confirmed_driver_id,
      'cancelled_at', t.cancelled_at,
      'cancelled_by', t.cancelled_by,
      'cancel_reason', t.cancel_reason,
      'cancellation_reason', t.cancellation_reason,
      'special_instructions', t.special_instructions
    ),
    'evidence', jsonb_build_object(
      'completed_at', t.completed_at,
      'capture_amount_pence', t.capture_amount_pence,
      'payment_session_id', t.payment_session_id,
      'trip_earning_net_ledger_id', '92121551-2fa1-44bc-9556-7f3f55ff5479',
      'admin_cancel_at', '2026-09-23T18:55:32.746414Z'
    )
  )
FROM public.trips t
WHERE t.id = '174df647-2417-4da3-9e55-7261a4e7d3e7';

-- ---------------------------------------------------------------------------
-- 2) Restore the trip under the audited terminal-state override
-- ---------------------------------------------------------------------------
SELECT set_config(
  'onecab.terminal_state_override',
  'MK-260923-017 restore to completed: admin cancel on 2026-09-23 reversed a captured completed ride (owner approved 2026-10-13)',
  true
);

DO $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.trips
  SET
    status = 'completed',
    dispatch_status = 'completed',
    negotiation_status = 'confirmed',
    driver_id = 'c40dd8a6-f422-40bc-9534-bae7be88b93e',
    confirmed_driver_id = 'c40dd8a6-f422-40bc-9534-bae7be88b93e',
    cancelled_at = NULL,
    cancelled_by = NULL,
    cancel_reason = NULL,
    cancellation_reason = NULL,
    special_instructions = ''
  WHERE id = '174df647-2417-4da3-9e55-7261a4e7d3e7'
    AND status = 'cancelled'
    AND completed_at IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'restore_aborted: expected 1 trip row, updated %', v_n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Undo the customer active-trip pointer the driver-assign trigger just set
-- ---------------------------------------------------------------------------
UPDATE public.customers
SET active_trip_id = NULL, updated_at = now()
WHERE id = '6818f4c3-2645-4bef-897a-30d0abe199bd'
  AND active_trip_id = '174df647-2417-4da3-9e55-7261a4e7d3e7';

-- ---------------------------------------------------------------------------
-- 4) Postconditions — money untouched, lock override audited
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.trips
    WHERE id = '174df647-2417-4da3-9e55-7261a4e7d3e7'
      AND status = 'completed'
      AND completed_at = '2026-09-23 18:47:21.979+00'
      AND confirmed_driver_id = 'c40dd8a6-f422-40bc-9534-bae7be88b93e'
      AND capture_amount_pence = 500
      AND driver_net_pence = 430
      AND payment_status = 'captured'
  ) THEN
    RAISE EXCEPTION 'restore_aborted: trip postcondition failed';
  END IF;

  IF (SELECT count(*) FROM public.driver_wallet_ledger
      WHERE related_trip_id = '174df647-2417-4da3-9e55-7261a4e7d3e7') <> 1 THEN
    RAISE EXCEPTION 'restore_aborted: ledger rows changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE trip_id = '174df647-2417-4da3-9e55-7261a4e7d3e7'
      AND event_type = 'TERMINAL_STATE_OVERRIDE'
      AND details->>'violation' = 'TERMINAL_TRIP_REOPENED'
      AND created_at >= now()
  ) THEN
    RAISE EXCEPTION 'restore_aborted: terminal state override was not audited';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.customers
    WHERE active_trip_id = '174df647-2417-4da3-9e55-7261a4e7d3e7'
  ) OR EXISTS (
    SELECT 1 FROM public.drivers
    WHERE current_trip_id = '174df647-2417-4da3-9e55-7261a4e7d3e7'
  ) THEN
    RAISE EXCEPTION 'restore_aborted: trip left as an active trip pointer';
  END IF;
END $$;

COMMIT;
