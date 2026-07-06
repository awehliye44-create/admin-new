-- P0: Register Revolut as a selectable payment provider (credentials + service-area assignment).

INSERT INTO public.payment_provider_configs (
  provider,
  display_name,
  environment,
  is_enabled,
  is_primary,
  supports_customer_payments,
  supports_driver_payouts
)
VALUES (
  'revolut',
  'Revolut',
  'test',
  false,
  false,
  true,
  true
)
ON CONFLICT (provider) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  supports_customer_payments = true,
  supports_driver_payouts = true;

UPDATE public.payment_provider_configs
SET
  supports_customer_payments = true,
  supports_driver_payouts = true
WHERE provider = 'revolut';
