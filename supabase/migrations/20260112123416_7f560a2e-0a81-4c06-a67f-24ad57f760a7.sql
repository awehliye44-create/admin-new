-- Add new columns to regions table for full region management
ALTER TABLE public.regions 
ADD COLUMN IF NOT EXISTS distance_unit text NOT NULL DEFAULT 'mile',
ADD COLUMN IF NOT EXISTS currency_code text NOT NULL DEFAULT 'GBP',
ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Europe/London',
ADD COLUMN IF NOT EXISTS geo_boundary jsonb DEFAULT NULL;

-- Add constraint for distance_unit
ALTER TABLE public.regions 
ADD CONSTRAINT regions_distance_unit_check 
CHECK (distance_unit IN ('mile', 'km'));

-- Add index for geo_boundary for future spatial queries
CREATE INDEX IF NOT EXISTS idx_regions_geo_boundary ON public.regions USING gin(geo_boundary);

-- Add comment for clarity
COMMENT ON COLUMN public.regions.geo_boundary IS 'GeoJSON polygon coordinates for region boundary';
COMMENT ON COLUMN public.regions.distance_unit IS 'Unit for distance calculations: mile or km';
COMMENT ON COLUMN public.regions.currency_code IS 'Currency code for pricing (e.g., GBP, USD)';
COMMENT ON COLUMN public.regions.timezone IS 'IANA timezone identifier';