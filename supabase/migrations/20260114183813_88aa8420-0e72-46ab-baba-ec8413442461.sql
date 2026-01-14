-- Add service_area_id to custom_zones for proper zone-service area hierarchy
-- Zones should be associated with service areas, not directly with regions

-- Add the service_area_id column
ALTER TABLE public.custom_zones 
ADD COLUMN IF NOT EXISTS service_area_id uuid REFERENCES public.service_areas(id) ON DELETE SET NULL;

-- Create an index for better query performance
CREATE INDEX IF NOT EXISTS idx_custom_zones_service_area_id ON public.custom_zones(service_area_id);

-- Add a comment explaining the hierarchy
COMMENT ON COLUMN public.custom_zones.service_area_id IS 'The service area this zone belongs to. Zones should be within service area boundaries.';
COMMENT ON COLUMN public.custom_zones.region_id IS 'Legacy: The region this zone belongs to. Prefer service_area_id for new zones.';