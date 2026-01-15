-- Add global expansion columns to service_areas
ALTER TABLE public.service_areas
ADD COLUMN IF NOT EXISTS code TEXT,
ADD COLUMN IF NOT EXISTS country TEXT,
ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC',
ADD COLUMN IF NOT EXISTS currency_code TEXT DEFAULT 'GBP',
ADD COLUMN IF NOT EXISTS distance_unit TEXT DEFAULT 'km';

-- Add unique constraint on code
ALTER TABLE public.service_areas
ADD CONSTRAINT service_areas_code_unique UNIQUE (code);

-- Add trip_number columns to trips
ALTER TABLE public.trips
ADD COLUMN IF NOT EXISTS service_area_code TEXT,
ADD COLUMN IF NOT EXISTS sequence_no INTEGER;

-- Make trip_code unique (this is our trip_number)
CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_trip_code_unique ON public.trips(trip_code) WHERE trip_code IS NOT NULL;

-- Create service_area_sequences table for per-area counters
CREATE TABLE IF NOT EXISTS public.service_area_sequences (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  service_area_code TEXT NOT NULL,
  sequence_type TEXT NOT NULL DEFAULT 'trip',
  current_value INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(service_area_id, sequence_type)
);

-- Enable RLS
ALTER TABLE public.service_area_sequences ENABLE ROW LEVEL SECURITY;

-- RLS policies for service_area_sequences
CREATE POLICY "Authenticated users can view sequences"
  ON public.service_area_sequences FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage sequences"
  ON public.service_area_sequences FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Function to generate next trip number atomically
CREATE OR REPLACE FUNCTION public.generate_trip_number(p_service_area_id UUID)
RETURNS TABLE(trip_number TEXT, sequence_no INTEGER, service_area_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
  v_seq INTEGER;
BEGIN
  -- Get the service area code
  SELECT sa.code INTO v_code
  FROM service_areas sa
  WHERE sa.id = p_service_area_id;
  
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'Service area not found or has no code';
  END IF;
  
  -- Insert or update sequence with row-level locking
  INSERT INTO service_area_sequences (service_area_id, service_area_code, sequence_type, current_value)
  VALUES (p_service_area_id, v_code, 'trip', 1)
  ON CONFLICT (service_area_id, sequence_type)
  DO UPDATE SET 
    current_value = service_area_sequences.current_value + 1,
    updated_at = now()
  RETURNING service_area_sequences.current_value INTO v_seq;
  
  -- Return the generated values
  RETURN QUERY SELECT 
    v_code || LPAD(v_seq::TEXT, 4, '0') AS trip_number,
    v_seq AS sequence_no,
    v_code AS service_area_code;
END;
$$;

-- Create index for timezone-aware queries
CREATE INDEX IF NOT EXISTS idx_trips_completed_at ON public.trips(completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trips_service_area_completed ON public.trips(service_area_id, completed_at) WHERE completed_at IS NOT NULL;

-- Update existing service areas with sample codes (if they exist)
UPDATE public.service_areas SET code = UPPER(LEFT(REPLACE(name, ' ', ''), 3)) WHERE code IS NULL;

-- Add comment for documentation
COMMENT ON TABLE public.service_area_sequences IS 'Per-service-area atomic counters for trip numbers and other sequences';
COMMENT ON FUNCTION public.generate_trip_number IS 'Atomically generates next trip number for a service area (e.g., MK0001, NYC0002)';