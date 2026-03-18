-- Add cancellation fields to fare_pricing_settings
ALTER TABLE public.fare_pricing_settings
  ADD COLUMN IF NOT EXISTS cancellation_grace_period_minutes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS cancellation_fee_pence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancellation_apply_after_arrival_only boolean NOT NULL DEFAULT true;

-- Add no-show fields to fare_pricing_settings
ALTER TABLE public.fare_pricing_settings
  ADD COLUMN IF NOT EXISTS no_show_wait_time_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS no_show_fee_pence integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS no_show_apply_after_arrival_only boolean NOT NULL DEFAULT true;