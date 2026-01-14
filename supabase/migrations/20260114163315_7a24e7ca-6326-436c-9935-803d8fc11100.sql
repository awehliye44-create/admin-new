-- Add geo_boundary column to service_areas table for polygon boundaries
ALTER TABLE public.service_areas 
ADD COLUMN IF NOT EXISTS geo_boundary jsonb DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.service_areas.geo_boundary IS 'GeoJSON polygon boundary for the service area, must be within parent region boundary';