
-- Add fare engine source-of-truth columns to trips table
ALTER TABLE public.trips 
  ADD COLUMN IF NOT EXISTS fare_engine_config_id uuid REFERENCES public.fare_pricing_settings(id),
  ADD COLUMN IF NOT EXISTS fare_locked boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS fare_snapshot_json jsonb;

-- Add comment for clarity
COMMENT ON COLUMN public.trips.fare_engine_config_id IS 'FK to fare_pricing_settings row used for this trip';
COMMENT ON COLUMN public.trips.fare_locked IS 'True if fare was locked at booking (fixed mode)';
COMMENT ON COLUMN public.trips.fare_snapshot_json IS 'Snapshot of fare engine config at booking time';
