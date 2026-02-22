
-- Add unified waiting charges to service_areas table
ALTER TABLE public.service_areas 
  ADD COLUMN IF NOT EXISTS pickup_waiting_charges jsonb DEFAULT '[{"from_min": 0, "rate": 0.2}]'::jsonb,
  ADD COLUMN IF NOT EXISTS stops_waiting_charges jsonb DEFAULT '[{"from_min": 0, "rate": 0.3}]'::jsonb;
