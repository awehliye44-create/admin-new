-- Pricing Buffer (Stripe / margin) — per service area
-- Stored on the area-wide row of fare_pricing_settings (vehicle_type_id IS NULL)
-- Buffer is platform-only revenue; never affects commission or driver earnings.

ALTER TABLE public.fare_pricing_settings
  ADD COLUMN IF NOT EXISTS buffer_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS buffer_type TEXT NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS buffer_value NUMERIC(10,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS buffer_apply_scope TEXT NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS buffer_show_to_customer BOOLEAN NOT NULL DEFAULT FALSE;

-- Validation: buffer_type ∈ {fixed, percentage}, buffer_apply_scope ∈ {all, non_route}
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fare_pricing_settings_buffer_type_chk'
  ) THEN
    ALTER TABLE public.fare_pricing_settings
      ADD CONSTRAINT fare_pricing_settings_buffer_type_chk
      CHECK (buffer_type IN ('fixed', 'percentage'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fare_pricing_settings_buffer_scope_chk'
  ) THEN
    ALTER TABLE public.fare_pricing_settings
      ADD CONSTRAINT fare_pricing_settings_buffer_scope_chk
      CHECK (buffer_apply_scope IN ('all', 'non_route'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fare_pricing_settings_buffer_value_chk'
  ) THEN
    ALTER TABLE public.fare_pricing_settings
      ADD CONSTRAINT fare_pricing_settings_buffer_value_chk
      CHECK (buffer_value >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.fare_pricing_settings.buffer_enabled IS 'Pricing buffer / Stripe margin toggle. Applied AFTER fare calc, BEFORE discounts. Platform-only revenue.';
COMMENT ON COLUMN public.fare_pricing_settings.buffer_type IS 'fixed (currency units) | percentage (of base fare)';
COMMENT ON COLUMN public.fare_pricing_settings.buffer_value IS 'Fixed: currency units (e.g. 0.50). Percentage: percent (e.g. 2.5 = 2.5%)';
COMMENT ON COLUMN public.fare_pricing_settings.buffer_apply_scope IS 'all = every fare source. non_route = exclude zone_route fixed fares.';
COMMENT ON COLUMN public.fare_pricing_settings.buffer_show_to_customer IS 'If true, breakdown reveals buffer line. If false, rolled silently into total.';

-- Add a column on trips to record buffer applied (for audit / accounting)
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS buffer_amount_pence INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.trips.buffer_amount_pence IS 'Pricing buffer applied at quote time. Platform revenue, excluded from commissionable subtotal.';