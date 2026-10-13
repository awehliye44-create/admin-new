-- ============================================================
-- DRAFT / REVIEW ONLY — DO NOT APPLY WITHOUT WRITTEN APPROVAL
-- Payout recovery: historical early cash-out fee corrections and
-- retirement of never-submitted weekly payout items.
--
-- Prerequisites (in order):
--   0. Draft 20261216110000_early_cashout_fee_setting_50p applied (owner chose 50p).
--   1. Migration 20261216120000_payout_recovery_cashout_fee_partial_batch_stale_items
--      applied (retire_unsubmitted_payout_item + CASHOUT_FEE unique index exist).
--   2. admin-execute-weekly-payout-occurrence + admin-weekly-payout-scheduler deployed
--      with the Available-balance cap. Retiring MK0002's item releases 5,989p of
--      allocations whose credits were already paid by legacy unallocated payouts;
--      only the cap (and reserve's live-balance check) stops them being paid again.
--   3. Read-only Revolut GET of the four early cash-out transactions confirms the
--      transferred amount equals net_driver_payout_pence (fee was retained).
--
-- This script never calls Revolut, never creates a payout and never deletes or
-- edits an existing ledger row. Every write is a new, idempotent row or an
-- evidence-gated status change.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) Preconditions — abort on any drift from the audited state
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_n integer;
BEGIN
  IF to_regprocedure('public.retire_unsubmitted_payout_item(uuid,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'recovery_aborted: forward migration 20261216120000 not applied';
  END IF;
  IF to_regclass('public.driver_wallet_ledger_cashout_fee_provider_payout_uidx') IS NULL THEN
    RAISE EXCEPTION 'recovery_aborted: CASHOUT_FEE unique index missing';
  END IF;
  IF to_regprocedure('public.driver_early_cashout_fee_pence()') IS NULL
     OR public.driver_early_cashout_fee_pence() <> 50 THEN
    RAISE EXCEPTION 'recovery_aborted: early cash-out fee SSOT is not 50p (run 20261216110000 first)';
  END IF;

  -- Three MK0006 + one MK0007 early cash-outs: completed, gross = net + 50, no fee row yet.
  SELECT count(*) INTO v_n
  FROM public.payout_items pi
  JOIN public.driver_payout_payment_intents i ON i.payout_item_id = pi.id
  WHERE pi.id IN (
      '5f00ba74-9592-4438-9e42-a9ae9a368c6a',
      '0e237504-4d22-4ce4-a93d-ee2c2bdce004',
      '4effe485-44c1-4379-9cdf-cf78e96f148e',
      'a1f02284-5ea5-4754-87c3-87aaa2c65391'
    )
    AND pi.status = 'COMPLETED'
    AND pi.amount_pence - pi.net_driver_payout_pence = 50
    AND (pi.eligibility_snapshot->>'withdrawal_fee_pence')::integer = 50
    AND i.provider_payment_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_wallet_ledger f
      WHERE f.type = 'CASHOUT_FEE'
        AND f.driver_id = pi.driver_id
        AND f.provider_payout_id = i.provider_payment_id
    );
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'recovery_aborted: fee precondition count=% (expected 4)', v_n;
  END IF;

  -- Each fee row is tied to the exact Revolut payment reconciled in Revolut Business:
  -- same payment id, net amount transferred, Revolut recipient and paying driver.
  SELECT count(*) INTO v_n
  FROM (VALUES
      ('5f00ba74-9592-4438-9e42-a9ae9a368c6a'::uuid, '05609426-d06a-e322-0040-620084084902', 3269, 'dfab69f8-cba6-e2aa-0040-62cfb6dea546', 'MK0006'),
      ('0e237504-4d22-4ce4-a93d-ee2c2bdce004'::uuid, '05610bd9-4e62-e3aa-0040-62ad77e04cd4', 1129, 'dfab69f8-cba6-e2aa-0040-62cfb6dea546', 'MK0006'),
      ('4effe485-44c1-4379-9cdf-cf78e96f148e'::uuid, '0563f39f-f83f-e33b-0040-625e206959f1', 4505, 'dfab69f8-cba6-e2aa-0040-62cfb6dea546', 'MK0006'),
      ('a1f02284-5ea5-4754-87c3-87aaa2c65391'::uuid, '0563f3a8-94d8-e392-0040-620b3835c8fa', 3015, 'dc5bbfa7-ff52-48c3-be07-7ea8b19d4b68', 'MK0007')
    ) AS e(item_id, payment_id, net_pence, counterparty_id, driver_code)
  JOIN public.payout_items pi ON pi.id = e.item_id
  JOIN public.driver_payout_payment_intents i ON i.payout_item_id = pi.id
  JOIN public.drivers d ON d.id = pi.driver_id
  WHERE i.provider_payment_id = e.payment_id
    AND pi.net_driver_payout_pence = e.net_pence
    AND i.provider_counterparty_id = e.counterparty_id
    AND i.provider_state = 'completed'
    AND d.driver_code = e.driver_code;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'recovery_aborted: Revolut reconciliation match count=% (expected 4)', v_n;
  END IF;

  -- Stale items: still pre-reservation, no intent, no reservation.
  SELECT count(*) INTO v_n
  FROM public.payout_items pi
  WHERE pi.id IN (
      '254180e2-87d5-4053-9cdf-68a96ef2a36d',
      '36e922d6-07dd-4529-b32d-9a0661997369',
      'eca35734-0d0b-4cae-83ac-427c844c6957',
      'abf3765c-8e26-4dac-8a00-d91ecfb7206d',
      '8b8daf79-50e9-434c-8396-c3507e65a462'
    )
    AND upper(pi.status) IN ('VALIDATED', 'BLOCKED_EXECUTION_DISABLED')
    AND NOT EXISTS (SELECT 1 FROM public.driver_payout_payment_intents i WHERE i.payout_item_id = pi.id)
    AND NOT EXISTS (SELECT 1 FROM public.driver_payout_reservations r WHERE r.payout_item_id = pi.id);
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'recovery_aborted: stale item precondition count=% (expected 5)', v_n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Missing early cash-out fees: MK0006 x3 + MK0007 x1 (4 x 50p = 200p ONECAB revenue).
--    MK0007 included on explicit owner approval (2026-10-12).
--    New CASHOUT_FEE rows only. Dated now (no backdating); the original
--    completion time is kept in metadata. Idempotent twice over:
--    provider_transfer_id 'dw_fin_repair:%' unique + (driver, provider payment) unique.
-- ---------------------------------------------------------------------------
INSERT INTO public.driver_wallet_ledger (
  driver_id, type, amount_pence, currency, description,
  provider_payout_id, provider_transfer_id, created_at, metadata
)
SELECT
  pi.driver_id,
  'CASHOUT_FEE',
  -50,
  'GBP',
  format(
    'Correction: early cash-out fee not recorded at completion item=%s payment=%s',
    pi.id, i.provider_payment_id
  ),
  i.provider_payment_id,
  'dw_fin_repair:cashout_fee:' || pi.id::text,
  now(),
  jsonb_build_object(
    'correction', true,
    'correction_kind', 'EARLY_CASHOUT_FEE_NOT_RECORDED',
    'revenue_class', 'ONECAB_EARLY_CASHOUT_FEE',
    'payout_item_id', pi.id,
    'original_completed_at', pi.completed_at,
    'gross_wallet_consumed_pence', pi.amount_pence,
    'net_transfer_pence', pi.net_driver_payout_pence,
    'fee_pence', 50,
    'root_cause', 'finalize_driver_payout_completion debited net only (fee row dropped by 20260901130000)'
  )
FROM public.payout_items pi
JOIN public.driver_payout_payment_intents i ON i.payout_item_id = pi.id
WHERE pi.id IN (
    '5f00ba74-9592-4438-9e42-a9ae9a368c6a',
    '0e237504-4d22-4ce4-a93d-ee2c2bdce004',
    '4effe485-44c1-4379-9cdf-cf78e96f148e',
    'a1f02284-5ea5-4754-87c3-87aaa2c65391'
  )
  AND i.provider_payment_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) Retire never-submitted weekly items (no money moves; allocations release)
-- ---------------------------------------------------------------------------
-- MK0006 6 Oct 1,227p: reserve rejected BATCH_NOT_ELIGIBLE after MK0007 completed.
-- Released credits (MK-260927-009 376, MK-261002-014 426, MK-261004-014 425) are
-- re-planned by the next weekly occurrence together with MK-261007-002 (484).
SELECT public.retire_unsubmitted_payout_item(
  '254180e2-87d5-4053-9cdf-68a96ef2a36d',
  'partial_batch_reserve_rejected_never_submitted:2026-10-06',
  'payout_recovery_20261216', false);

-- MK0002 29 Sep 5,989p: never submitted; Live 0 — credits were already paid by
-- legacy unallocated WEEKLY_PAYOUT debits (11 Aug / 25 Aug / 1 Sep). Not owed.
SELECT public.retire_unsubmitted_payout_item(
  '36e922d6-07dd-4529-b32d-9a0661997369',
  'duplicate_plan_credits_paid_by_legacy_unallocated_payouts:2026-09-29',
  'payout_recovery_20261216', false);

-- MK0001 18 Jul 3,149p: same amount paid by sibling item ae1494b9 (payment 054d4732).
SELECT public.retire_unsubmitted_payout_item(
  '8b8daf79-50e9-434c-8396-c3507e65a462',
  'superseded_paid_by_item_ae1494b9_payment_054d4732:2026-07-18',
  'payout_recovery_20261216', false);

-- MK0001 7,153p / MK0002 3,514p 18 Jul: execution-disabled orphans, no allocations,
-- Live 0 for both drivers.
SELECT public.retire_unsubmitted_payout_item(
  'eca35734-0d0b-4cae-83ac-427c844c6957',
  'orphan_execution_disabled_never_submitted:2026-07-18',
  'payout_recovery_20261216', false);
SELECT public.retire_unsubmitted_payout_item(
  'abf3765c-8e26-4dac-8a00-d91ecfb7206d',
  'orphan_execution_disabled_never_submitted:2026-07-18',
  'payout_recovery_20261216', false);

-- ---------------------------------------------------------------------------
-- 3) MK-260923-017 — DECISION REQUIRED. Intentionally no statement here.
--    Evidence: started 18:46:55, completed 18:47:21, admin cancel 18:55:32;
--    500p captured (6p waiting increment declined); TRIP_EARNING_NET 430 posted.
--    Do not stamp a cancellation financial_outcome; see the recovery report.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 4) Postconditions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.driver_wallet_ledger
  WHERE provider_transfer_id IN (
    'dw_fin_repair:cashout_fee:5f00ba74-9592-4438-9e42-a9ae9a368c6a',
    'dw_fin_repair:cashout_fee:0e237504-4d22-4ce4-a93d-ee2c2bdce004',
    'dw_fin_repair:cashout_fee:4effe485-44c1-4379-9cdf-cf78e96f148e',
    'dw_fin_repair:cashout_fee:a1f02284-5ea5-4754-87c3-87aaa2c65391'
  ) AND type = 'CASHOUT_FEE' AND amount_pence = -50;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'recovery_postcondition_failed: fee rows=%', v_n;
  END IF;

  SELECT count(*) INTO v_n
  FROM public.payout_items
  WHERE id IN (
      '254180e2-87d5-4053-9cdf-68a96ef2a36d',
      '36e922d6-07dd-4529-b32d-9a0661997369',
      'eca35734-0d0b-4cae-83ac-427c844c6957',
      'abf3765c-8e26-4dac-8a00-d91ecfb7206d',
      '8b8daf79-50e9-434c-8396-c3507e65a462'
    )
    AND status = 'CANCELLED' AND failure_code = 'STALE_NEVER_SUBMITTED';
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'recovery_postcondition_failed: retired items=%', v_n;
  END IF;

  -- No payout debit, intent or reservation may have been created by this script.
  IF EXISTS (
    SELECT 1 FROM public.driver_payout_payment_intents i
    WHERE i.payout_item_id IN (
      '254180e2-87d5-4053-9cdf-68a96ef2a36d',
      '36e922d6-07dd-4529-b32d-9a0661997369',
      'eca35734-0d0b-4cae-83ac-427c844c6957',
      'abf3765c-8e26-4dac-8a00-d91ecfb7206d',
      '8b8daf79-50e9-434c-8396-c3507e65a462'
    )
  ) THEN
    RAISE EXCEPTION 'recovery_postcondition_failed: provider intent exists';
  END IF;
END $$;

-- Expected after COMMIT (driver_wallet_eligibility_balances):
--   MK0006 live 2141, available 1711, pending 0 (430 for MK-260923-017 stays excluded)
--   MK0002 live 0, available 0
--   MK0001 live 0, available 0
--   MK0007 live 0, available 0
COMMIT;
