-- P1 Late passenger cancellation + airport/long-distance protection
-- driver_started_journey_to_pickup_at gates 50% fee; standard late cancel remains separate from arrival cancellation.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS driver_started_journey_to_pickup_at timestamptz;

COMMENT ON COLUMN public.trips.driver_started_journey_to_pickup_at IS
  'When set, airport/long-distance late-cancel protection is active for customer cancellations before arrival.';

ALTER TABLE public.fare_pricing_settings
  ADD COLUMN IF NOT EXISTS late_cancel_airport_protection_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS late_cancel_airport_fare_threshold_pence integer NOT NULL DEFAULT 5000,
  ADD COLUMN IF NOT EXISTS late_cancel_airport_fee_type text NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN IF NOT EXISTS late_cancel_airport_fee_percentage integer NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS late_cancel_airport_protection_trigger text NOT NULL DEFAULT 'AFTER_DRIVER_STARTED_JOURNEY';

COMMENT ON COLUMN public.fare_pricing_settings.late_cancel_airport_protection_enabled IS
  'When true, airport/long-distance trips use percentage fee after driver starts journey to pickup.';
COMMENT ON COLUMN public.fare_pricing_settings.late_cancel_airport_fare_threshold_pence IS
  'Trips with estimated fare at or above this threshold qualify for airport protection (default £50 = 5000 pence).';
COMMENT ON COLUMN public.fare_pricing_settings.late_cancel_airport_fee_type IS
  'Fee type when airport protection applies (PERCENTAGE).';
COMMENT ON COLUMN public.fare_pricing_settings.late_cancel_airport_fee_percentage IS
  'Percentage of estimated fare charged on protected late cancellation (default 50).';
COMMENT ON COLUMN public.fare_pricing_settings.late_cancel_airport_protection_trigger IS
  'Protection activates when this condition is met (AFTER_DRIVER_STARTED_JOURNEY).';

UPDATE public.fare_pricing_settings
SET late_cancel_enabled = true
WHERE late_cancel_enabled = false;
