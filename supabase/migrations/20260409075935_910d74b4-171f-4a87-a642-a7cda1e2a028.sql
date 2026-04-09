-- Route/ETA cache table for backend-only use
CREATE TABLE public.trip_route_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  leg TEXT NOT NULL CHECK (leg IN ('driver_to_pickup', 'pickup_to_dropoff')),
  origin_lat DOUBLE PRECISION NOT NULL,
  origin_lng DOUBLE PRECISION NOT NULL,
  dest_lat DOUBLE PRECISION NOT NULL,
  dest_lng DOUBLE PRECISION NOT NULL,
  distance_km NUMERIC(10,2) NOT NULL,
  duration_min INTEGER NOT NULL,
  polyline TEXT,
  eta_at TIMESTAMPTZ,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reroute_reason TEXT DEFAULT 'trip_assigned',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(trip_id, leg)
);

-- Enable RLS - only service role access (edge functions)
ALTER TABLE public.trip_route_cache ENABLE ROW LEVEL SECURITY;

-- No public policies = only service_role can access (edge functions)

-- Index for fast lookup
CREATE INDEX idx_trip_route_cache_trip_id ON public.trip_route_cache(trip_id);
CREATE INDEX idx_trip_route_cache_expires ON public.trip_route_cache(expires_at);

-- Auto-update timestamps
CREATE TRIGGER update_trip_route_cache_updated_at
  BEFORE UPDATE ON public.trip_route_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();