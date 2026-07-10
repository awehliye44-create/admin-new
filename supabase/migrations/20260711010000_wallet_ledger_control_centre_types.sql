-- Control centre: expand wallet ledger types to match SSOT taxonomy + append-only guard.

ALTER TABLE public.driver_wallet_ledger DROP CONSTRAINT IF EXISTS driver_wallet_ledger_type_check;
ALTER TABLE public.driver_wallet_ledger ADD CONSTRAINT driver_wallet_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET', 'TRIP_CREDIT', 'CASH_TRIP_EARNING', 'CASH_COMMISSION_DEBT',
    'DRIVER_TIP_CREDIT', 'TIP_CREDIT', 'PLATFORM_COMMISSION', 'COMPANY_COMMISSION',
    'WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'CASHOUT_FEE',
    'ADJUSTMENT', 'MANUAL_ADJUSTMENT', 'MANUAL_CREDIT', 'MANUAL_DEBIT',
    'REFUND_DEBIT', 'CHARGEBACK_DEBIT', 'PAYOUT', 'MANUAL_PAYOUT', 'PAYOUT_CREATED',
    'BONUS', 'PROMOTION', 'DEBT_RECOVERY', 'PAYOUT_FAILED_RETURN', 'PAYOUT_REVERSAL',
    'LEDGER_REVERSAL', 'CORRECTION', 'COMMISSION_RECOVERED'
  ]));

-- Append-only: block DELETE on driver_wallet_ledger (corrections must insert new rows).
CREATE OR REPLACE FUNCTION public.prevent_driver_wallet_ledger_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'driver_wallet_ledger is append-only; corrections must insert new entries';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_driver_wallet_ledger_delete ON public.driver_wallet_ledger;
CREATE TRIGGER trg_prevent_driver_wallet_ledger_delete
  BEFORE DELETE ON public.driver_wallet_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_driver_wallet_ledger_delete();
