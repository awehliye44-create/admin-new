-- P1: Driver residential address fields for signup and admin visibility.

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS residential_address TEXT,
  ADD COLUMN IF NOT EXISTS postcode TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT;

COMMENT ON COLUMN public.drivers.residential_address IS 'Driver residential street address collected at signup.';
COMMENT ON COLUMN public.drivers.postcode IS 'Driver residential postcode.';
COMMENT ON COLUMN public.drivers.city IS 'Driver residential city.';
COMMENT ON COLUMN public.drivers.country IS 'Driver residential country.';
