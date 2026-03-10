-- Add missing financial columns to trips table
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS stripe_transfer_id text;
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS debt_recovery_pence integer DEFAULT 0;
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS final_payout_pence integer;
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS wallet_balance_before integer;
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS wallet_balance_after integer;

-- Add index for faster settlement queries
CREATE INDEX IF NOT EXISTS idx_trips_payment_status ON public.trips (payment_status);
CREATE INDEX IF NOT EXISTS idx_trips_stripe_payment_intent ON public.trips (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_driver_ledger_driver_type ON public.driver_ledger (driver_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_driver_ledger_trip ON public.driver_ledger (trip_id) WHERE trip_id IS NOT NULL;