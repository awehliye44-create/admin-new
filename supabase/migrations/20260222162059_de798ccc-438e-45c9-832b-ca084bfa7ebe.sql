
-- Recreate preset offer configs table (per service area)
CREATE TABLE public.preset_offer_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  price_mode TEXT NOT NULL DEFAULT 'multiplier' CHECK (price_mode IN ('multiplier', 'fixed')),
  default_selected_offer_id TEXT DEFAULT 'recommended',
  countdown_enabled BOOLEAN NOT NULL DEFAULT false,
  countdown_seconds INTEGER NOT NULL DEFAULT 30,
  countdown_auto_select BOOLEAN NOT NULL DEFAULT false,
  countdown_auto_select_offer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(service_area_id)
);

-- Create individual preset offer options
CREATE TABLE public.preset_offers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  config_id UUID NOT NULL REFERENCES public.preset_offer_configs(id) ON DELETE CASCADE,
  offer_key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  multiplier NUMERIC(4,2) DEFAULT 1.0,
  fixed_amount_pence INTEGER DEFAULT 0,
  icon TEXT DEFAULT 'tag',
  color TEXT DEFAULT '#3B82F6',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(config_id, offer_key)
);

-- Enable RLS
ALTER TABLE public.preset_offer_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preset_offers ENABLE ROW LEVEL SECURITY;

-- Admin policies
CREATE POLICY "Admins can manage preset offer configs"
ON public.preset_offer_configs FOR ALL
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage preset offers"
ON public.preset_offers FOR ALL
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Public read policies (drivers/customers need to read)
CREATE POLICY "Anyone can read enabled preset offer configs"
ON public.preset_offer_configs FOR SELECT USING (true);

CREATE POLICY "Anyone can read preset offers"
ON public.preset_offers FOR SELECT USING (true);

-- Triggers
CREATE TRIGGER update_preset_offer_configs_updated_at
BEFORE UPDATE ON public.preset_offer_configs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_preset_offers_updated_at
BEFORE UPDATE ON public.preset_offers
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
