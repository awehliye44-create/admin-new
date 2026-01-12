-- Add driver_code column to drivers table
ALTER TABLE public.drivers 
ADD COLUMN IF NOT EXISTS driver_code text UNIQUE;

-- Create sequence tables for region-based ID generation
CREATE TABLE IF NOT EXISTS public.id_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id uuid NOT NULL,
  sequence_type text NOT NULL, -- 'trip' or 'driver'
  current_value integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(region_id, sequence_type)
);

-- Enable RLS on id_sequences
ALTER TABLE public.id_sequences ENABLE ROW LEVEL SECURITY;

-- Only allow system/triggers to manage sequences
CREATE POLICY "System can manage sequences" ON public.id_sequences FOR ALL USING (true);

-- Function to get region code (first 2 chars uppercase of region name)
CREATE OR REPLACE FUNCTION public.get_region_code(p_region_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_region_name text;
BEGIN
  SELECT UPPER(LEFT(name, 2)) INTO v_region_name
  FROM public.regions
  WHERE id = p_region_id;
  
  RETURN COALESCE(v_region_name, 'XX');
END;
$$;

-- Function to generate next trip code
CREATE OR REPLACE FUNCTION public.generate_trip_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_region_id uuid;
  v_region_code text;
  v_next_val integer;
BEGIN
  -- Get region from driver if assigned, otherwise use first active region
  IF NEW.driver_id IS NOT NULL THEN
    SELECT region_id INTO v_region_id FROM public.drivers WHERE id = NEW.driver_id;
  END IF;
  
  IF v_region_id IS NULL THEN
    SELECT id INTO v_region_id FROM public.regions WHERE status = 'active' LIMIT 1;
  END IF;
  
  v_region_code := get_region_code(v_region_id);
  
  -- Get and increment sequence
  INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
  VALUES (COALESCE(v_region_id, gen_random_uuid()), 'trip', 1)
  ON CONFLICT (region_id, sequence_type) 
  DO UPDATE SET current_value = id_sequences.current_value + 1, updated_at = now()
  RETURNING current_value INTO v_next_val;
  
  -- Format: UK-TRIP-0001
  NEW.trip_code := v_region_code || '-TRIP-' || LPAD(v_next_val::text, 4, '0');
  
  RETURN NEW;
END;
$$;

-- Function to generate next driver code
CREATE OR REPLACE FUNCTION public.generate_driver_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_region_code text;
  v_next_val integer;
BEGIN
  v_region_code := get_region_code(NEW.region_id);
  
  -- Get and increment sequence
  INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
  VALUES (NEW.region_id, 'driver', 1)
  ON CONFLICT (region_id, sequence_type) 
  DO UPDATE SET current_value = id_sequences.current_value + 1, updated_at = now()
  RETURNING current_value INTO v_next_val;
  
  -- Format: UK-0001
  NEW.driver_code := v_region_code || '-' || LPAD(v_next_val::text, 4, '0');
  
  RETURN NEW;
END;
$$;

-- Create triggers
DROP TRIGGER IF EXISTS generate_trip_code_trigger ON public.trips;
CREATE TRIGGER generate_trip_code_trigger
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  WHEN (NEW.trip_code IS NULL)
  EXECUTE FUNCTION public.generate_trip_code();

DROP TRIGGER IF EXISTS generate_driver_code_trigger ON public.drivers;
CREATE TRIGGER generate_driver_code_trigger
  BEFORE INSERT ON public.drivers
  FOR EACH ROW
  WHEN (NEW.driver_code IS NULL)
  EXECUTE FUNCTION public.generate_driver_code();

-- Backfill existing records with codes
DO $$
DECLARE
  r RECORD;
  v_region_code text;
  v_next_val integer;
BEGIN
  -- Backfill drivers without codes
  FOR r IN SELECT id, region_id FROM public.drivers WHERE driver_code IS NULL ORDER BY created_at LOOP
    v_region_code := public.get_region_code(r.region_id);
    
    INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
    VALUES (r.region_id, 'driver', 1)
    ON CONFLICT (region_id, sequence_type) 
    DO UPDATE SET current_value = id_sequences.current_value + 1, updated_at = now()
    RETURNING current_value INTO v_next_val;
    
    UPDATE public.drivers SET driver_code = v_region_code || '-' || LPAD(v_next_val::text, 4, '0') WHERE id = r.id;
  END LOOP;
  
  -- Backfill trips without codes
  FOR r IN SELECT t.id, COALESCE(d.region_id, (SELECT id FROM public.regions WHERE status = 'active' LIMIT 1)) as region_id 
           FROM public.trips t 
           LEFT JOIN public.drivers d ON t.driver_id = d.id 
           WHERE t.trip_code IS NULL 
           ORDER BY t.created_at LOOP
    v_region_code := public.get_region_code(r.region_id);
    
    INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
    VALUES (COALESCE(r.region_id, gen_random_uuid()), 'trip', 1)
    ON CONFLICT (region_id, sequence_type) 
    DO UPDATE SET current_value = id_sequences.current_value + 1, updated_at = now()
    RETURNING current_value INTO v_next_val;
    
    UPDATE public.trips SET trip_code = v_region_code || '-TRIP-' || LPAD(v_next_val::text, 4, '0') WHERE id = r.id;
  END LOOP;
END $$;