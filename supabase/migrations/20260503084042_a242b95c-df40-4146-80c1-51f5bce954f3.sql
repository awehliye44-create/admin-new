ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS stripe_application_fee_id text,
  ADD COLUMN IF NOT EXISTS stripe_application_fee_amount_pence integer,
  ADD COLUMN IF NOT EXISTS stripe_destination_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_transfer_amount_pence integer,
  ADD COLUMN IF NOT EXISTS stripe_settlement_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_settlement_warning text;

CREATE INDEX IF NOT EXISTS idx_trips_stripe_settlement_verified
  ON public.trips(stripe_settlement_verified)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_stripe_application_fee_id
  ON public.trips(stripe_application_fee_id)
  WHERE stripe_application_fee_id IS NOT NULL;