-- P0: Single Service Area Payment Provider
-- Customer collection and driver payout always use the same provider.
-- Legacy columns remain as mirrors for compatibility; payment_provider is SSOT.

ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS payment_provider text
    REFERENCES public.payment_provider_configs(provider) ON DELETE RESTRICT;

COMMENT ON COLUMN public.service_areas.payment_provider IS
  'Single payment provider for this service area — controls both customer collection and driver payout. No split providers.';

COMMENT ON COLUMN public.service_areas.customer_payment_gateway IS
  'Mirror of payment_provider (customer collection). Always equal to payment_provider.';

COMMENT ON COLUMN public.service_areas.driver_payout_gateway IS
  'Mirror of payment_provider (driver payout). Always equal to payment_provider.';

-- Prefer existing customer gateway, then driver, then stripe.
UPDATE public.service_areas
SET payment_provider = COALESCE(
  payment_provider,
  customer_payment_gateway,
  driver_payout_gateway,
  'stripe'
)
WHERE payment_provider IS NULL
   OR customer_payment_gateway IS NULL
   OR driver_payout_gateway IS NULL
   OR payment_provider IS DISTINCT FROM customer_payment_gateway
   OR payment_provider IS DISTINCT FROM driver_payout_gateway
   OR customer_payment_gateway IS DISTINCT FROM driver_payout_gateway;

-- Force all three columns to the single provider (no mismatch allowed).
UPDATE public.service_areas
SET
  payment_provider = COALESCE(payment_provider, customer_payment_gateway, driver_payout_gateway, 'stripe'),
  customer_payment_gateway = COALESCE(payment_provider, customer_payment_gateway, driver_payout_gateway, 'stripe'),
  driver_payout_gateway = COALESCE(payment_provider, customer_payment_gateway, driver_payout_gateway, 'stripe');

-- One provider does both collection and payout.
UPDATE public.payment_provider_configs
SET
  supports_customer_payments = true,
  supports_driver_payouts = true
WHERE provider IN (
  'stripe',
  'sifalo_pay',
  'waafi_pay',
  'sahal_pay',
  'intasend',
  'paystack',
  'flutterwave',
  'pesapal',
  'hubtel',
  'dpo_pay'
);

INSERT INTO public.payment_provider_configs (
  provider, display_name, environment, is_enabled, is_primary,
  supports_customer_payments, supports_driver_payouts
)
VALUES
  ('stripe', 'Stripe', 'live', true, true, true, true),
  ('sifalo_pay', 'Sifalo Pay', 'test', false, false, true, true),
  ('waafi_pay', 'WaafiPay', 'test', false, false, true, true),
  ('sahal_pay', 'Sahal Pay', 'test', false, false, true, true),
  ('intasend', 'IntaSend', 'test', false, false, true, true),
  ('paystack', 'Paystack', 'test', false, false, true, true),
  ('flutterwave', 'Flutterwave', 'test', false, false, true, true),
  ('pesapal', 'Pesapal', 'test', false, false, true, true),
  ('hubtel', 'Hubtel', 'test', false, false, true, true),
  ('dpo_pay', 'DPO Pay', 'test', false, false, true, true)
ON CONFLICT (provider) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  supports_customer_payments = true,
  supports_driver_payouts = true;

CREATE INDEX IF NOT EXISTS idx_service_areas_payment_provider
  ON public.service_areas (payment_provider);

-- Keep payment_provider and legacy mirrors identical on every write.
CREATE OR REPLACE FUNCTION public.sync_service_area_payment_provider()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_provider text;
BEGIN
  v_provider := COALESCE(
    NEW.payment_provider,
    NEW.customer_payment_gateway,
    NEW.driver_payout_gateway
  );

  NEW.payment_provider := v_provider;
  NEW.customer_payment_gateway := v_provider;
  NEW.driver_payout_gateway := v_provider;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_service_areas_sync_payment_provider ON public.service_areas;
CREATE TRIGGER tr_service_areas_sync_payment_provider
  BEFORE INSERT OR UPDATE OF payment_provider, customer_payment_gateway, driver_payout_gateway
  ON public.service_areas
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_service_area_payment_provider();
