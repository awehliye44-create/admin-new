-- Create trip_offers table to track individual offers to drivers
CREATE TABLE public.trip_offers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined', 'expired', 'withdrawn')),
  distance_km NUMERIC(10, 2),
  priority_score NUMERIC(5, 2),
  offered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  responded_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(trip_id, driver_id)
);

-- Enable RLS
ALTER TABLE public.trip_offers ENABLE ROW LEVEL SECURITY;

-- Policies for trip_offers
CREATE POLICY "Admins can view all trip offers" 
ON public.trip_offers 
FOR SELECT 
USING (true);

CREATE POLICY "System can insert trip offers" 
ON public.trip_offers 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "System can update trip offers" 
ON public.trip_offers 
FOR UPDATE 
USING (true);

-- Enable realtime for trip_offers
ALTER TABLE public.trip_offers REPLICA IDENTITY FULL;

-- Add to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.trip_offers;

-- Create indexes for performance
CREATE INDEX idx_trip_offers_trip_id ON public.trip_offers(trip_id);
CREATE INDEX idx_trip_offers_driver_id ON public.trip_offers(driver_id);
CREATE INDEX idx_trip_offers_status ON public.trip_offers(status);
CREATE INDEX idx_trip_offers_driver_status ON public.trip_offers(driver_id, status);

-- Trigger to update updated_at
CREATE TRIGGER update_trip_offers_updated_at
BEFORE UPDATE ON public.trip_offers
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();