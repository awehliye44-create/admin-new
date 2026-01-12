-- Create dispatch_settings table for configurable dispatch parameters
CREATE TABLE IF NOT EXISTS public.dispatch_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE CASCADE,
  max_driver_find_time_minutes integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(service_area_id)
);

-- Enable RLS
ALTER TABLE public.dispatch_settings ENABLE ROW LEVEL SECURITY;

-- Only admins can manage dispatch settings
CREATE POLICY "Admins can manage dispatch settings"
ON public.dispatch_settings
FOR ALL
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Allow public read for customer apps to get timeout
CREATE POLICY "Public can read dispatch settings"
ON public.dispatch_settings
FOR SELECT
USING (true);

-- Insert default global setting (null service_area_id = global)
INSERT INTO public.dispatch_settings (service_area_id, max_driver_find_time_minutes)
VALUES (null, 3)
ON CONFLICT DO NOTHING;

-- Create trigger for updated_at
CREATE TRIGGER update_dispatch_settings_updated_at
  BEFORE UPDATE ON public.dispatch_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();