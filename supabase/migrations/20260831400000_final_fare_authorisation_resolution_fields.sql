-- P0 — Final fare vs authorisation resolution fields on payment_sessions.
-- Persist canonical money truth + resolution type/status for capture/release/fee/recovery.

ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS original_authorised_pence integer,
  ADD COLUMN IF NOT EXISTS additional_authorised_pence integer,
  ADD COLUMN IF NOT EXISTS final_charge_pence integer,
  ADD COLUMN IF NOT EXISTS shortfall_pence integer,
  ADD COLUMN IF NOT EXISTS no_show_fee_pence integer,
  ADD COLUMN IF NOT EXISTS cancellation_fee_pence integer,
  ADD COLUMN IF NOT EXISTS recovery_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_resolution_type text,
  ADD COLUMN IF NOT EXISTS payment_resolution_status text;

COMMENT ON COLUMN public.payment_sessions.original_authorised_pence IS
  'Original hold authorised amount (pence) — preserved through additional auth.';
COMMENT ON COLUMN public.payment_sessions.additional_authorised_pence IS
  'Shortfall authorisation amount (pence); 0 when not required.';
COMMENT ON COLUMN public.payment_sessions.final_charge_pence IS
  'Canonical final payable amount (fare or fee) in pence.';
COMMENT ON COLUMN public.payment_sessions.payment_resolution_type IS
  'FULL_CAPTURE | PARTIAL_CAPTURE_RELEASE_REMAINDER | ADDITIONAL_AUTHORISATION | PAYMENT_RECOVERY | NO_SHOW_FEE_CAPTURE | CANCELLATION_FEE_CAPTURE | FULL_RELEASE_ZERO_CHARGE';
COMMENT ON COLUMN public.payment_sessions.payment_resolution_status IS
  'Lifecycle status for final-fare authorisation SSOT.';

-- Backfill originals from existing authorised columns where missing.
UPDATE public.payment_sessions
SET original_authorised_pence = COALESCE(
  original_authorised_pence,
  authorised_amount_pence,
  total_authorised_amount_pence
)
WHERE original_authorised_pence IS NULL
  AND COALESCE(authorised_amount_pence, total_authorised_amount_pence) IS NOT NULL;
