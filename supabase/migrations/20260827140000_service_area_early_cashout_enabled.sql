-- Per-service-area toggle for driver Instant Early Cash Out (Stripe instant payouts).
-- Default OFF until Stripe enables platform instant payouts and admin turns on per area.

ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS early_cashout_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.service_areas.early_cashout_enabled IS
  'When true, drivers assigned to this service area may use Instant Early Cash Out. Weekly payouts and wallet balance are unaffected.';
