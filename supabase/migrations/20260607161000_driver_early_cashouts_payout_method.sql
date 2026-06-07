-- Track Stripe Connect payout method per early cash-out (instant vs standard fallback).
ALTER TABLE public.driver_early_cashouts
  ADD COLUMN IF NOT EXISTS payout_method text
  CHECK (payout_method IS NULL OR payout_method IN ('instant', 'standard'));

COMMENT ON COLUMN public.driver_early_cashouts.payout_method IS
  'Stripe Connect payout method: instant (express, minutes) or standard (1-3 business days fallback).';
