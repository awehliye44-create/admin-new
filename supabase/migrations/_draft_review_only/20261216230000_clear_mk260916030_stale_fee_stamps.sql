-- ============================================================
-- APPLIED TO PRODUCTION 2026-10-13 (owner approved). Do not re-run: the
-- preconditions abort because the stamps are already cleared.
-- MK-260916-030: clear the stale late-cancel stamps on a completed ride.
--
-- Evidence (audited 2026-10-13):
--   19:08:08 customer cancelled; late-cancel disposition stamped
--     financial_outcome CANCELLED_WITH_FEE, late_cancel_fee_pence 500,
--     cancellation_fee_pence 500, and released the 300p buffer. The 500p fee
--     was never captured separately.
--   19:20:02 schedule-dispatch resurrected the trip (defect closed by P1).
--   MK0006 accepted 19:21:24, arrived 19:22:19, started 19:22:43, completed
--   19:25:54 (1.26 km in 3 min 11 s). One 500p capture at 19:26:07, fee 25p.
--   One TRIP_EARNING_NET 435p (500 − 13% commission), paid.
--
-- Effect: three trip stamps only, set to the values every other completed
-- PLATFORM_COLLECTED trip carries (NULL). No payment, ledger, payout,
-- payment-session or Revolut change. Status stays completed, so the terminal
-- state lock is not involved and no override is used.
--
-- Downstream (verified 2026-10-13):
--   - Financial Reconciliation: FARE_SETTLEMENT, expected 435p, stamp OK —
--     identical before and after.
--   - Terminal fee resumption: not a terminal-fee trip before or after; no credit.
--   - Payment session metadata keeps the original LATE_PASSENGER_CANCELLATION
--     disposition as payment history (not edited).
--
-- Rollback: re-apply the values recorded in the HISTORICAL_TRIP_STAMPS_CLEARED
-- audit row.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.trips
  WHERE id = '12de1e2a-c56c-4324-ba7c-fd58da64f27c'
    AND trip_code = 'MK-260916-030'
    AND status = 'completed'
    AND completed_at = '2026-09-16 19:25:53.694+00'
    AND driver_id = 'c40dd8a6-f422-40bc-9534-bae7be88b93e'
    AND financial_outcome = 'CANCELLED_WITH_FEE'
    AND late_cancel_fee_pence = 500
    AND cancellation_fee_pence = 500
    AND capture_amount_pence = 500
    AND driver_net_pence = 435
    AND payment_status = 'captured'
    AND financial_model = 'PLATFORM_COLLECTED';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'clear_aborted: MK-260916-030 is not in the audited state';
  END IF;

  IF (SELECT count(*) FROM public.driver_wallet_ledger
      WHERE related_trip_id = '12de1e2a-c56c-4324-ba7c-fd58da64f27c') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.driver_wallet_ledger
       WHERE related_trip_id = '12de1e2a-c56c-4324-ba7c-fd58da64f27c'
         AND driver_id = 'c40dd8a6-f422-40bc-9534-bae7be88b93e'
         AND type = 'TRIP_EARNING_NET'
         AND amount_pence = 435
     ) THEN
    RAISE EXCEPTION 'clear_aborted: ledger for MK-260916-030 is not the single 435p TRIP_EARNING_NET';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.payment_sessions
    WHERE id = '8eaffce4-280a-4b92-aa2c-c6e762d1032b'
      AND status::text = 'captured'
      AND captured_amount_pence = 500
      AND upper(provider_state) = 'COMPLETED'
  ) THEN
    RAISE EXCEPTION 'clear_aborted: payment session drifted from audited state';
  END IF;
END $$;

INSERT INTO public.audit_logs (event_type, trip_id, driver_id, details)
SELECT
  'HISTORICAL_TRIP_STAMPS_CLEARED',
  t.id,
  t.driver_id,
  jsonb_build_object(
    'trip_code', t.trip_code,
    'approval', 'Owner approved clearing stale late-cancel stamps on a completed ride (2026-10-13)',
    'reason', 'Late-cancel stamps from 19:08 survived the dispatch resurrection; the ride completed and was paid once (500p).',
    'previous', jsonb_build_object(
      'financial_outcome', t.financial_outcome,
      'late_cancel_fee_pence', t.late_cancel_fee_pence,
      'cancellation_fee_pence', t.cancellation_fee_pence
    ),
    'unchanged', jsonb_build_object(
      'status', t.status,
      'capture_amount_pence', t.capture_amount_pence,
      'driver_net_pence', t.driver_net_pence,
      'payment_session_id', t.payment_session_id
    )
  )
FROM public.trips t
WHERE t.id = '12de1e2a-c56c-4324-ba7c-fd58da64f27c';

DO $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.trips
  SET
    financial_outcome = NULL,
    late_cancel_fee_pence = NULL,
    cancellation_fee_pence = NULL
  WHERE id = '12de1e2a-c56c-4324-ba7c-fd58da64f27c'
    AND status = 'completed'
    AND financial_outcome = 'CANCELLED_WITH_FEE';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'clear_aborted: expected 1 trip row, updated %', v_n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.trips
    WHERE id = '12de1e2a-c56c-4324-ba7c-fd58da64f27c'
      AND status = 'completed'
      AND completed_at = '2026-09-16 19:25:53.694+00'
      AND financial_outcome IS NULL
      AND late_cancel_fee_pence IS NULL
      AND cancellation_fee_pence IS NULL
      AND capture_amount_pence = 500
      AND driver_net_pence = 435
      AND payment_status = 'captured'
  ) THEN
    RAISE EXCEPTION 'clear_aborted: trip postcondition failed';
  END IF;

  IF (SELECT count(*) FROM public.driver_wallet_ledger
      WHERE related_trip_id = '12de1e2a-c56c-4324-ba7c-fd58da64f27c') <> 1 THEN
    RAISE EXCEPTION 'clear_aborted: ledger rows changed';
  END IF;
END $$;

COMMIT;
