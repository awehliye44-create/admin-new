-- 1. Remove the misplaced "Pricing Buffer" from the fare layer (permanent cleanup).
ALTER TABLE public.fare_pricing_settings
  DROP COLUMN IF EXISTS buffer_enabled,
  DROP COLUMN IF EXISTS buffer_type,
  DROP COLUMN IF EXISTS buffer_value,
  DROP COLUMN IF EXISTS buffer_apply_scope,
  DROP COLUMN IF EXISTS buffer_show_to_customer;

ALTER TABLE public.trips
  DROP COLUMN IF EXISTS buffer_amount_pence;

-- 2. New table: per-service-area pre-authorization buffer settings.
CREATE TABLE IF NOT EXISTS public.service_area_preauth_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id UUID NOT NULL UNIQUE REFERENCES public.service_areas(id) ON DELETE CASCADE,
  enable_preauth_buffer BOOLEAN NOT NULL DEFAULT false,
  buffer_type TEXT NOT NULL DEFAULT 'percentage' CHECK (buffer_type IN ('fixed', 'percentage')),
  buffer_value NUMERIC NOT NULL DEFAULT 0 CHECK (buffer_value >= 0),
  min_hold_pence INTEGER CHECK (min_hold_pence IS NULL OR min_hold_pence >= 0),
  max_hold_pence INTEGER CHECK (max_hold_pence IS NULL OR max_hold_pence >= 0),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.service_area_preauth_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view preauth buffer settings"
ON public.service_area_preauth_settings
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can insert preauth buffer settings"
ON public.service_area_preauth_settings
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update preauth buffer settings"
ON public.service_area_preauth_settings
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete preauth buffer settings"
ON public.service_area_preauth_settings
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_service_area_preauth_settings_updated_at
BEFORE UPDATE ON public.service_area_preauth_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Informational column on trips (never summed into fare/commission/ledger).
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS preauth_buffer_pence INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.trips.preauth_buffer_pence IS
  'Informational only. Amount added to the Stripe pre-auth hold above the estimated fare. Never affects fare, commission, or driver earnings. Released back to the customer at capture time.';

COMMENT ON TABLE public.service_area_preauth_settings IS
  'Per-service-area pre-authorization buffer used only by create-payment-intent to inflate the Stripe auth hold. Pure payment-layer concern; does not affect fare pricing or driver earnings.';