-- Stripe Connect payout mirror + failed local payout item cleanup.

CREATE TABLE IF NOT EXISTS public.stripe_connect_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id text NOT NULL UNIQUE,
  connected_account_id text NOT NULL,
  driver_id uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  amount_pence integer NOT NULL CHECK (amount_pence >= 0),
  currency text NOT NULL DEFAULT 'gbp',
  status text NOT NULL,
  initiated_at timestamptz,
  arrival_date timestamptz,
  bank_last4 text,
  failure_code text,
  failure_message text,
  balance_transaction_id text,
  payout_method text,
  statement_descriptor text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_payouts_driver
  ON public.stripe_connect_payouts (driver_id, initiated_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_payouts_acct
  ON public.stripe_connect_payouts (connected_account_id, initiated_at DESC);

COMMENT ON TABLE public.stripe_connect_payouts IS
  'Mirror of Stripe Connect payout objects — physical bank payouts only (not platform transfers).';

-- Repair stale failed payout_items: settlement must not stay PROCESSING/READY without Stripe evidence.
UPDATE public.payout_items
SET
  settlement_status = CASE
    WHEN COALESCE(cash_commission_recovered_pence, 0) > 0 THEN 'PARTIAL_SETTLEMENT'
    ELSE 'FAILED'
  END,
  gross_payable_pence = COALESCE(
    gross_payable_pence,
    net_driver_payout_pence,
    amount_pence,
    0
  ),
  net_driver_payout_pence = COALESCE(net_driver_payout_pence, amount_pence, 0),
  failed_payout_amount_pence = GREATEST(
    COALESCE(failed_payout_amount_pence, 0),
    COALESCE(net_driver_payout_pence, amount_pence, 0)
  ),
  driver_paid_out_pence = 0,
  updated_at = now()
WHERE status IN ('failed', 'ledger_sync_failed')
  AND stripe_transfer_id IS NULL
  AND stripe_payout_id IS NULL
  AND settlement_status NOT IN ('FAILED', 'PARTIAL_SETTLEMENT', 'COMPLETE');
