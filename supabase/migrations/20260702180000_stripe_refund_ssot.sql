-- Stripe refund SSOT — persist refund state on payments + trip_finance.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refunded_amount_pence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_status text,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_refund_id text;

ALTER TABLE public.trip_finance
  ADD COLUMN IF NOT EXISTS refund_amount_pence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_status text,
  ADD COLUMN IF NOT EXISTS net_card_revenue_after_refund_pence integer,
  ADD COLUMN IF NOT EXISTS driver_wallet_reversal_pence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_reversal_pence integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_payments_stripe_refund_id
  ON public.payments (stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;

COMMENT ON COLUMN public.payments.refunded_amount_pence IS 'Cumulative Stripe refund amount for this payment row (pence).';
COMMENT ON COLUMN public.payments.refund_status IS 'none | partially_refunded | refunded';
COMMENT ON COLUMN public.trip_finance.net_card_revenue_after_refund_pence IS 'Captured card revenue minus refunds (SSOT for FR).';
