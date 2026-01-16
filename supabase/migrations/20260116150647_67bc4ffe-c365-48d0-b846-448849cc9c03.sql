-- Add per_booking_fee fields to service_areas
ALTER TABLE public.service_areas 
ADD COLUMN IF NOT EXISTS per_booking_fee_enabled boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS per_booking_fee_pence integer NOT NULL DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN public.service_areas.per_booking_fee_enabled IS 'Whether a fixed per-booking fee is charged for trips in this service area';
COMMENT ON COLUMN public.service_areas.per_booking_fee_pence IS 'The per-booking fee amount in smallest currency unit (e.g. pence/cents)';