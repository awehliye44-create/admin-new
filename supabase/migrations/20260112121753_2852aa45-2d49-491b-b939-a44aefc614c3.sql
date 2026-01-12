-- Create vehicle types table
CREATE TABLE public.vehicle_types (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT DEFAULT 'car',
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create service area vehicle type pricing table
CREATE TABLE public.service_area_vehicle_pricing (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  vehicle_type_id UUID NOT NULL REFERENCES public.vehicle_types(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  base_fare NUMERIC NOT NULL DEFAULT 3,
  minimum_fare NUMERIC NOT NULL DEFAULT 5,
  currency_code TEXT NOT NULL DEFAULT 'GBP',
  -- Tiered pricing stored as JSONB arrays
  distance_pricing JSONB NOT NULL DEFAULT '[{"from_km": 0, "rate": 1.5}]'::jsonb,
  time_pricing JSONB NOT NULL DEFAULT '[{"from_min": 0, "rate": 0.25}]'::jsonb,
  pickup_waiting_charges JSONB NOT NULL DEFAULT '[{"from_min": 0, "rate": 0.2}]'::jsonb,
  stops_waiting_charges JSONB NOT NULL DEFAULT '[{"from_min": 0, "rate": 0.3}]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(service_area_id, vehicle_type_id)
);

-- Create service area cancellation fees table
CREATE TABLE public.service_area_cancellation_fees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE UNIQUE,
  free_cancellation_window_minutes INTEGER NOT NULL DEFAULT 5,
  cancellation_fee NUMERIC NOT NULL DEFAULT 5,
  no_show_fee NUMERIC NOT NULL DEFAULT 10,
  currency_code TEXT NOT NULL DEFAULT 'GBP',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.vehicle_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_area_vehicle_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_area_cancellation_fees ENABLE ROW LEVEL SECURITY;

-- Vehicle types policies (read-only for all, write for admins)
CREATE POLICY "Anyone can read vehicle types"
ON public.vehicle_types FOR SELECT USING (true);

CREATE POLICY "Admins can insert vehicle types"
ON public.vehicle_types FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update vehicle types"
ON public.vehicle_types FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete vehicle types"
ON public.vehicle_types FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));

-- Service area vehicle pricing policies
CREATE POLICY "Anyone can read service area vehicle pricing"
ON public.service_area_vehicle_pricing FOR SELECT USING (true);

CREATE POLICY "Admins can insert service area vehicle pricing"
ON public.service_area_vehicle_pricing FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update service area vehicle pricing"
ON public.service_area_vehicle_pricing FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete service area vehicle pricing"
ON public.service_area_vehicle_pricing FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));

-- Service area cancellation fees policies
CREATE POLICY "Anyone can read service area cancellation fees"
ON public.service_area_cancellation_fees FOR SELECT USING (true);

CREATE POLICY "Admins can insert service area cancellation fees"
ON public.service_area_cancellation_fees FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update service area cancellation fees"
ON public.service_area_cancellation_fees FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete service area cancellation fees"
ON public.service_area_cancellation_fees FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));

-- Add triggers for updated_at
CREATE TRIGGER update_vehicle_types_updated_at
BEFORE UPDATE ON public.vehicle_types
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_service_area_vehicle_pricing_updated_at
BEFORE UPDATE ON public.service_area_vehicle_pricing
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_service_area_cancellation_fees_updated_at
BEFORE UPDATE ON public.service_area_cancellation_fees
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default vehicle types
INSERT INTO public.vehicle_types (name, slug, description, display_order) VALUES
  ('Economy', 'economy', 'Affordable everyday rides', 1),
  ('Comfort', 'comfort', 'Newer cars, extra legroom', 2),
  ('Premium', 'premium', 'Luxury vehicles, top rated', 3),
  ('SUV', 'suv', 'Spacious vehicles for groups', 4),
  ('Pet-Friendly', 'pet', 'Rides that welcome pets', 5);