
-- Zone Route Pricing: fixed fares between two custom zones
CREATE TABLE public.zone_route_pricing (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  from_zone_id uuid NOT NULL REFERENCES public.custom_zones(id) ON DELETE CASCADE,
  to_zone_id uuid NOT NULL REFERENCES public.custom_zones(id) ON DELETE CASCADE,
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE SET NULL,
  vehicle_type_id uuid REFERENCES public.vehicle_types(id) ON DELETE SET NULL,
  fixed_fare numeric(10,2) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT zone_route_different_zones CHECK (from_zone_id != to_zone_id)
);

-- Enable RLS
ALTER TABLE public.zone_route_pricing ENABLE ROW LEVEL SECURITY;

-- Admin-only policies
CREATE POLICY "Admins can manage zone route pricing"
  ON public.zone_route_pricing
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Read access for authenticated users (needed for fare calculation)
CREATE POLICY "Authenticated users can read active zone route pricing"
  ON public.zone_route_pricing
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Updated_at trigger
CREATE TRIGGER update_zone_route_pricing_updated_at
  BEFORE UPDATE ON public.zone_route_pricing
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Index for fare lookup
CREATE INDEX idx_zone_route_pricing_lookup
  ON public.zone_route_pricing (from_zone_id, to_zone_id, is_active);
