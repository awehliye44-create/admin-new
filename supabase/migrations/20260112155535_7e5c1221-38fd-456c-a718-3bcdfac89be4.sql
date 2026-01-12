-- Create region_payment_methods table for configurable payment methods per region
CREATE TABLE IF NOT EXISTS public.region_payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_id uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
  cash_enabled boolean NOT NULL DEFAULT true,
  card_enabled boolean NOT NULL DEFAULT true,
  wallet_enabled boolean NOT NULL DEFAULT false,
  apple_pay_enabled boolean NOT NULL DEFAULT false,
  google_pay_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(region_id)
);

-- Enable RLS
ALTER TABLE public.region_payment_methods ENABLE ROW LEVEL SECURITY;

-- Admins can manage payment methods
CREATE POLICY "Admins can manage region payment methods"
ON public.region_payment_methods
FOR ALL
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Anyone can read payment methods (needed for customer apps)
CREATE POLICY "Anyone can read region payment methods"
ON public.region_payment_methods
FOR SELECT
USING (true);

-- Create trigger for updated_at
CREATE TRIGGER update_region_payment_methods_updated_at
  BEFORE UPDATE ON public.region_payment_methods
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default payment methods for existing regions
INSERT INTO public.region_payment_methods (region_id, cash_enabled, card_enabled, wallet_enabled, apple_pay_enabled, google_pay_enabled)
SELECT id, true, true, false, false, false
FROM public.regions
ON CONFLICT (region_id) DO NOTHING;