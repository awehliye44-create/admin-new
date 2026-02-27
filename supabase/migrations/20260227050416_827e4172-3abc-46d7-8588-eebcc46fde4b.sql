
-- Service Area Document Rules table
CREATE TABLE public.service_area_document_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  doc_type_id UUID NOT NULL REFERENCES public.document_types(id) ON DELETE CASCADE,
  display_in_driver_app BOOLEAN NOT NULL DEFAULT true,
  mandatory BOOLEAN NOT NULL DEFAULT true,
  expiry_required BOOLEAN NOT NULL DEFAULT true,
  max_age_days INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(service_area_id, doc_type_id)
);

-- Enable RLS
ALTER TABLE public.service_area_document_rules ENABLE ROW LEVEL SECURITY;

-- Admin full access
CREATE POLICY "Admins can manage service area document rules"
  ON public.service_area_document_rules FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

-- Drivers can read rules for their service area
CREATE POLICY "Drivers can read document rules for their service area"
  ON public.service_area_document_rules FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.driver_service_areas dsa
      WHERE dsa.service_area_id = service_area_document_rules.service_area_id
        AND dsa.driver_id = public.current_driver_id()
    )
  );

-- Trigger for updated_at
CREATE TRIGGER update_service_area_document_rules_updated_at
  BEFORE UPDATE ON public.service_area_document_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
