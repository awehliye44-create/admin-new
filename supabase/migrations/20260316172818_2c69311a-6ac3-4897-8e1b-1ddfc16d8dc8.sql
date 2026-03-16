
-- Service Area Vehicle Types assignment table
CREATE TABLE public.service_area_vehicle_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  vehicle_type_id UUID NOT NULL REFERENCES public.vehicle_types(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(service_area_id, vehicle_type_id)
);

ALTER TABLE public.service_area_vehicle_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage service area vehicle types"
  ON public.service_area_vehicle_types
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Authenticated users can read service area vehicle types"
  ON public.service_area_vehicle_types
  FOR SELECT
  TO authenticated
  USING (true);

CREATE TRIGGER update_service_area_vehicle_types_updated_at
  BEFORE UPDATE ON public.service_area_vehicle_types
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
