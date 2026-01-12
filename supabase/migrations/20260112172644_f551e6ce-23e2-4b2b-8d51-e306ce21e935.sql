-- Add is_pet_friendly column to drivers table
ALTER TABLE public.drivers 
ADD COLUMN IF NOT EXISTS is_pet_friendly boolean NOT NULL DEFAULT false;

-- Add rejection_reason and capacity columns to vehicles table
ALTER TABLE public.vehicles 
ADD COLUMN IF NOT EXISTS rejection_reason text,
ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 4,
ADD COLUMN IF NOT EXISTS vehicle_type_id uuid REFERENCES public.vehicle_types(id);

-- Create index for vehicle_type_id
CREATE INDEX IF NOT EXISTS idx_vehicles_vehicle_type_id ON public.vehicles(vehicle_type_id);

-- Update the driver_vehicle_categories table to use is_active instead of is_enabled for consistency
-- (Already exists with is_enabled, which is fine)