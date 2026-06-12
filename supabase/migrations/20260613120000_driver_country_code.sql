-- P1: Structured driver residential country (ISO alpha-2 + display name).

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS country_code TEXT;

COMMENT ON COLUMN public.drivers.country_code IS 'Driver residential country ISO 3166-1 alpha-2 (e.g. GB).';

-- Backfill GB for existing UK country text where possible.
UPDATE public.drivers
SET country_code = 'GB'
WHERE country_code IS NULL
  AND country IS NOT NULL
  AND lower(trim(country)) IN ('united kingdom', 'uk', 'gb', 'great britain');
