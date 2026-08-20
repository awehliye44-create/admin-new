-- ============================================================
-- EMERGENCY forward-only rollback for 20260930150000
-- Location: scripts/emergency/ (OUTSIDE supabase/migrations)
-- Status: PREPARED ONLY — do NOT apply unless separately approved
-- Does NOT edit schema_migrations. Never deletes money rows.
-- Refuses unsafe rollback when lineage rows exist.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.type = 'REFUND_DEBIT'
      AND dwl.provider_refund_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'EMERGENCY ROLLBACK REFUSED: non-NULL provider_refund_id REFUND_DEBIT rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.driver_wallet_ledger
    WHERE type = 'REFUND_DEBIT'
      AND related_trip_id IS NOT NULL
    GROUP BY related_trip_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'EMERGENCY ROLLBACK REFUSED: multiple REFUND_DEBIT rows per trip';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.apply_confirmed_provider_refund_atomic(
  uuid, text, text, integer, integer, text, text, text, text, boolean
);

DROP INDEX IF EXISTS public.driver_wallet_ledger_refund_debit_provider_refund_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_refund_debit_null_lineage_trip_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_cash_trip_earning_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_platform_commission_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_driver_tip_credit_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_tip_credit_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_ledger_reversal_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_commission_recovered_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_ops_driver_compensation_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_trip_adjustment_unique;
DROP INDEX IF EXISTS public.driver_wallet_ledger_debt_recovery_trip_unique;

ALTER TABLE public.driver_wallet_ledger
  DROP COLUMN IF EXISTS payment_provider,
  DROP COLUMN IF EXISTS provider_refund_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.driver_wallet_ledger
    WHERE related_trip_id IS NOT NULL
    GROUP BY related_trip_id, type
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS unique_trip_ledger_entry
      ON public.driver_wallet_ledger (related_trip_id, type);
  ELSE
    RAISE NOTICE 'EMERGENCY ROLLBACK: skipped unique_trip_ledger_entry restore — duplicate rows present';
  END IF;
END $$;
