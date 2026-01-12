-- Add new columns to vehicle_types table to match the design
ALTER TABLE public.vehicle_types
ADD COLUMN capacity integer NOT NULL DEFAULT 4,
ADD COLUMN categories text[] DEFAULT ARRAY['Standard']::text[],
ADD COLUMN features text[] DEFAULT ARRAY[]::text[];

-- Add comments for clarity
COMMENT ON COLUMN public.vehicle_types.capacity IS 'Maximum passenger capacity';
COMMENT ON COLUMN public.vehicle_types.categories IS 'Categories like Economy, Standard, XL, Luxury';
COMMENT ON COLUMN public.vehicle_types.features IS 'Features like Pet, Luxury, Wheelchair accessible';