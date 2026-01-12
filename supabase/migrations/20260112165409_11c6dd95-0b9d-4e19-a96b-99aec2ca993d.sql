-- Create service area payment methods table
CREATE TABLE public.service_area_payment_methods (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  cash_enabled BOOLEAN NOT NULL DEFAULT true,
  card_enabled BOOLEAN NOT NULL DEFAULT true,
  wallet_enabled BOOLEAN NOT NULL DEFAULT false,
  apple_pay_enabled BOOLEAN NOT NULL DEFAULT false,
  google_pay_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT service_area_payment_methods_unique UNIQUE (service_area_id)
);

-- Enable RLS
ALTER TABLE public.service_area_payment_methods ENABLE ROW LEVEL SECURITY;

-- Create policies for admin access
CREATE POLICY "Admins can view service area payment methods"
  ON public.service_area_payment_methods
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert service area payment methods"
  ON public.service_area_payment_methods
  FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update service area payment methods"
  ON public.service_area_payment_methods
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete service area payment methods"
  ON public.service_area_payment_methods
  FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- Create trigger for updated_at
CREATE TRIGGER update_service_area_payment_methods_updated_at
  BEFORE UPDATE ON public.service_area_payment_methods
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();