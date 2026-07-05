-- P0: Register Noda as a selectable payment provider (credentials + service-area assignment only).
-- Live booking/payout adapters remain unimplemented until explicit approval.

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
  'noda',
  'Noda',
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
WHERE provider = 'noda';
