ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS driver_fare_display text NOT NULL DEFAULT 'smart_display';

ALTER TABLE public.global_dispatch_settings
  DROP CONSTRAINT IF EXISTS global_dispatch_driver_fare_display_check;

ALTER TABLE public.global_dispatch_settings
  ADD CONSTRAINT global_dispatch_driver_fare_display_check
  CHECK (driver_fare_display = ANY (ARRAY['net_earnings'::text, 'gross_fare'::text, 'smart_display'::text, 'full_breakdown'::text]));