-- Add location columns to drivers table
ALTER TABLE public.drivers
ADD COLUMN current_lat double precision DEFAULT NULL,
ADD COLUMN current_lng double precision DEFAULT NULL,
ADD COLUMN last_location_updated_at timestamp with time zone DEFAULT NULL,
ADD COLUMN heading double precision DEFAULT NULL,
ADD COLUMN speed double precision DEFAULT NULL;

-- Create index for location queries
CREATE INDEX idx_drivers_location ON public.drivers (current_lat, current_lng) WHERE current_lat IS NOT NULL AND current_lng IS NOT NULL;

-- Create index for online drivers with location
CREATE INDEX idx_drivers_online_location ON public.drivers (is_online, current_lat, current_lng) WHERE is_online = true;

-- Enable realtime for drivers table
ALTER TABLE public.drivers REPLICA IDENTITY FULL;

-- Add drivers table to realtime publication (if not already added)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'drivers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.drivers;
  END IF;
END $$;

-- Create a function to update driver location
CREATE OR REPLACE FUNCTION public.update_driver_location(
  p_driver_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_heading double precision DEFAULT NULL,
  p_speed double precision DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result json;
BEGIN
  UPDATE public.drivers
  SET 
    current_lat = p_lat,
    current_lng = p_lng,
    heading = p_heading,
    speed = p_speed,
    last_location_updated_at = now(),
    updated_at = now()
  WHERE id = p_driver_id
    AND user_id = auth.uid()
  RETURNING json_build_object(
    'id', id,
    'current_lat', current_lat,
    'current_lng', current_lng,
    'last_location_updated_at', last_location_updated_at
  ) INTO v_result;
  
  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Driver not found or unauthorized';
  END IF;
  
  RETURN v_result;
END;
$$;