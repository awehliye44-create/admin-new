ALTER TABLE public.fare_pricing_settings
  ADD COLUMN late_cancel_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN late_cancel_threshold_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN late_cancel_fee_pence integer NOT NULL DEFAULT 500;