
-- Create preset offers configuration table per service area
CREATE TABLE public.preset_offer_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'multiplier' CHECK (mode IN ('fixed', 'multiplier')),
  currency TEXT NOT NULL DEFAULT 'GBP',
  show_badges BOOLEAN NOT NULL DEFAULT true,
  default_selected_offer_id TEXT DEFAULT 'recommended',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(service_area_id)
);

-- Create individual preset offer options
CREATE TABLE public.preset_offers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  config_id UUID NOT NULL REFERENCES public.preset_offer_configs(id) ON DELETE CASCADE,
  offer_key TEXT NOT NULL, -- e.g. 'cheapest', 'recommended', 'faster'
  label TEXT NOT NULL,     -- Display label e.g. 'Cheaper', 'Recommended', 'Faster'
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Multiplier mode fields
  multiplier NUMERIC(5,2) DEFAULT 1.00,
  rounding_step NUMERIC(5,2) DEFAULT 0.10,
  rounding_mode TEXT DEFAULT 'nearest' CHECK (rounding_mode IN ('nearest', 'up', 'down')),
  -- Fixed mode fields
  fixed_base NUMERIC(10,2) DEFAULT 0,
  fixed_per_km NUMERIC(10,2) DEFAULT 0,
  fixed_per_min NUMERIC(10,2) DEFAULT 0,
  fixed_min_fare NUMERIC(10,2) DEFAULT 0,
  fixed_booking_fee NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(config_id, offer_key)
);

-- Enable RLS
ALTER TABLE public.preset_offer_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preset_offers ENABLE ROW LEVEL SECURITY;

-- Admin read/write policies
CREATE POLICY "Admins can manage preset offer configs"
ON public.preset_offer_configs
FOR ALL
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage preset offers"
ON public.preset_offers
FOR ALL
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Public read for driver/customer apps (anon can read enabled configs)
CREATE POLICY "Anyone can read enabled preset offer configs"
ON public.preset_offer_configs
FOR SELECT
USING (true);

CREATE POLICY "Anyone can read preset offers"
ON public.preset_offers
FOR SELECT
USING (true);

-- Triggers for updated_at
CREATE TRIGGER update_preset_offer_configs_updated_at
BEFORE UPDATE ON public.preset_offer_configs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_preset_offers_updated_at
BEFORE UPDATE ON public.preset_offers
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
