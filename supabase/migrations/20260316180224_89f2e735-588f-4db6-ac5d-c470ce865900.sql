
-- Add vehicle_type_id to fare_pricing_settings (nullable = area-wide default)
ALTER TABLE public.fare_pricing_settings 
  ADD COLUMN vehicle_type_id uuid REFERENCES public.vehicle_types(id) ON DELETE CASCADE;

-- Drop the old unique constraint on service_area_id alone (if exists)
-- First find it
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT tc.constraint_name INTO constraint_name
  FROM information_schema.table_constraints tc
  WHERE tc.table_name = 'fare_pricing_settings'
    AND tc.constraint_type = 'UNIQUE'
    AND tc.table_schema = 'public'
  LIMIT 1;
  
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.fare_pricing_settings DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

-- Add composite unique constraint: one config per service area + vehicle type
CREATE UNIQUE INDEX uq_fare_pricing_sa_vt 
  ON public.fare_pricing_settings (service_area_id, COALESCE(vehicle_type_id, '00000000-0000-0000-0000-000000000000'::uuid));

COMMENT ON COLUMN public.fare_pricing_settings.vehicle_type_id IS 'NULL = area-wide default config; set = vehicle-type-specific config';
