
ALTER TABLE public.dispatch_settings
  ADD COLUMN IF NOT EXISTS wave1_offer_expiry_seconds integer NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS wave2_offer_expiry_seconds integer NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS wave3_offer_expiry_seconds integer NOT NULL DEFAULT 50;

COMMENT ON COLUMN public.dispatch_settings.wave1_offer_expiry_seconds IS 'Per-wave offer expiry for Wave 1 (seconds)';
COMMENT ON COLUMN public.dispatch_settings.wave2_offer_expiry_seconds IS 'Per-wave offer expiry for Wave 2 (seconds)';
COMMENT ON COLUMN public.dispatch_settings.wave3_offer_expiry_seconds IS 'Per-wave offer expiry for Wave 3 (seconds)';
