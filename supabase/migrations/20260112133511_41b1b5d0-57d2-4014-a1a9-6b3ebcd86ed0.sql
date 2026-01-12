-- Create custom zones table
CREATE TABLE public.custom_zones (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  zone_type TEXT NOT NULL DEFAULT 'surge', -- surge, discount, pickup, dropoff, restricted
  region_id UUID REFERENCES public.regions(id) ON DELETE CASCADE,
  geo_boundary JSONB, -- GeoJSON polygon
  is_active BOOLEAN NOT NULL DEFAULT true,
  color TEXT DEFAULT '#3B82F6',
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create zone pricing rules table
CREATE TABLE public.zone_pricing_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  zone_id UUID REFERENCES public.custom_zones(id) ON DELETE CASCADE NOT NULL,
  vehicle_type_id UUID REFERENCES public.vehicle_types(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL DEFAULT 'multiplier', -- multiplier, flat_rate, fixed_fare, percentage_discount
  value NUMERIC NOT NULL DEFAULT 1.0,
  min_fare NUMERIC DEFAULT 0,
  max_fare NUMERIC,
  applies_to TEXT NOT NULL DEFAULT 'both', -- pickup, dropoff, both
  time_restrictions JSONB, -- {days: [0-6], start_time: "HH:MM", end_time: "HH:MM"}
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create corporate fare rules table
CREATE TABLE public.corporate_fare_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  corporate_account_id UUID, -- Can link to specific corporate accounts later
  rule_type TEXT NOT NULL DEFAULT 'discount', -- discount, fixed_rate, cap
  discount_percentage NUMERIC DEFAULT 0,
  fixed_rate NUMERIC,
  fare_cap NUMERIC,
  applies_to_vehicle_types TEXT[] DEFAULT ARRAY[]::TEXT[],
  applies_to_regions UUID[] DEFAULT ARRAY[]::UUID[],
  time_restrictions JSONB,
  booking_restrictions JSONB, -- min/max passengers, advance booking requirements
  priority INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  valid_from TIMESTAMP WITH TIME ZONE DEFAULT now(),
  valid_until TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.custom_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zone_pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.corporate_fare_rules ENABLE ROW LEVEL SECURITY;

-- RLS policies for custom_zones
CREATE POLICY "Admins can manage custom zones" ON public.custom_zones
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active custom zones" ON public.custom_zones
  FOR SELECT USING (is_active = true);

-- RLS policies for zone_pricing_rules
CREATE POLICY "Admins can manage zone pricing rules" ON public.zone_pricing_rules
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active zone pricing rules" ON public.zone_pricing_rules
  FOR SELECT USING (is_active = true);

-- RLS policies for corporate_fare_rules
CREATE POLICY "Admins can manage corporate fare rules" ON public.corporate_fare_rules
  FOR ALL USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can read active corporate fare rules" ON public.corporate_fare_rules
  FOR SELECT USING (is_active = true);