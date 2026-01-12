-- Add commission_percentage column to service_area_vehicle_pricing
ALTER TABLE public.service_area_vehicle_pricing 
ADD COLUMN commission_percentage numeric NOT NULL DEFAULT 20;

-- Add a comment to explain the field
COMMENT ON COLUMN public.service_area_vehicle_pricing.commission_percentage IS 'Platform commission percentage taken from each fare';