-- First, clean up duplicate rows with null service_area_id (keep only one)
DELETE FROM public.dispatch_settings a
USING public.dispatch_settings b
WHERE a.id::text > b.id::text 
  AND COALESCE(a.service_area_id, '00000000-0000-0000-0000-000000000000') = COALESCE(b.service_area_id, '00000000-0000-0000-0000-000000000000');

-- Drop the existing constraint if it exists
ALTER TABLE public.dispatch_settings DROP CONSTRAINT IF EXISTS dispatch_settings_service_area_id_key;

-- Create a unique index that handles NULL values properly
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_settings_service_area_unique 
ON public.dispatch_settings (COALESCE(service_area_id, '00000000-0000-0000-0000-000000000000'));