-- P0: Global Payment Providers + per Service Area customer/payout gateways
-- Production-safe: backfills existing service areas to Stripe (MK unchanged).

ALTER TABLE public.payment_provider_configs
  ADD COLUMN IF NOT EXISTS supports_customer_payments boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS supports_driver_payouts boolean NOT NULL DEFAULT false;

UPDATE public.payment_provider_configs
SET supports_driver_payouts = true
WHERE provider = 'stripe';

ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS customer_payment_gateway text
    REFERENCES public.payment_provider_configs(provider) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS driver_payout_gateway text
    REFERENCES public.payment_provider_configs(provider) ON DELETE RESTRICT;

COMMENT ON COLUMN public.service_areas.customer_payment_gateway IS
  'Customer payment gateway for this service area — required; no global fallback.';
COMMENT ON COLUMN public.service_areas.driver_payout_gateway IS
  'Driver payout gateway for this service area — required; no global fallback.';

UPDATE public.service_areas
SET
  customer_payment_gateway = COALESCE(customer_payment_gateway, 'stripe'),
  driver_payout_gateway = COALESCE(driver_payout_gateway, 'stripe')
WHERE customer_payment_gateway IS NULL
   OR driver_payout_gateway IS NULL;

INSERT INTO public.payment_provider_configs (
  provider, display_name, environment, is_enabled, is_primary,
  supports_customer_payments, supports_driver_payouts
)
VALUES
  ('sifalo_pay', 'Sifalo Pay', 'test', false, false, true, false),
  ('waafi_pay', 'WaafiPay', 'test', false, false, true, false),
  ('sahal_pay', 'Sahal Pay', 'test', false, false, true, false),
  ('intasend', 'IntaSend', 'test', false, false, true, true),
  ('paystack', 'Paystack', 'test', false, false, true, false),
  ('flutterwave', 'Flutterwave', 'test', false, false, true, false),
  ('pesapal', 'Pesapal', 'test', false, false, true, false),
  ('hubtel', 'Hubtel', 'test', false, false, true, false),
  ('dpo_pay', 'DPO Pay', 'test', false, false, true, false)
ON CONFLICT (provider) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  supports_customer_payments = EXCLUDED.supports_customer_payments,
  supports_driver_payouts = COALESCE(
    public.payment_provider_configs.supports_driver_payouts,
    EXCLUDED.supports_driver_payouts
  );

CREATE INDEX IF NOT EXISTS idx_service_areas_customer_payment_gateway
  ON public.service_areas (customer_payment_gateway);
CREATE INDEX IF NOT EXISTS idx_service_areas_driver_payout_gateway
  ON public.service_areas (driver_payout_gateway);
