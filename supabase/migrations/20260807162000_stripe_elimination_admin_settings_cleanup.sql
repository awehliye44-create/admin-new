-- Stripe elimination follow-up: remove retired Stripe admin setting and
-- force payment_provider_configs.stripe to non-operable flags.
-- Does NOT drop payment_provider_configs row (preserves catalog history).

DELETE FROM public.admin_settings
WHERE setting_key = 'stripe_instant_payouts_enabled';

UPDATE public.payment_provider_configs
SET
  is_enabled = false,
  status = 'not_configured',
  supports_customer_payments = false,
  supports_driver_payouts = false,
  updated_at = now()
WHERE provider = 'stripe';
