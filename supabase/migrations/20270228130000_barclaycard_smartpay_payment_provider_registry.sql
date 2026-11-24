-- P0: Register Barclaycard Smartpay on Payment Providers (configuration readiness only).
-- No booking/payout adapters, credential schemas, or live enablement until official
-- merchant documentation + explicit production approval.
-- Revolut remains the live customer payment and driver payout provider.

INSERT INTO public.payment_provider_configs (
  provider,
  display_name,
  environment,
  status,
  is_enabled,
  is_primary,
  supports_customer_payments,
  supports_driver_payouts
)
VALUES (
  'barclaycard_smartpay',
  'Barclaycard Smartpay',
  'test',
  'not_configured',
  false,
  false,
  false,
  false
)
ON CONFLICT (provider) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  -- Idempotent: never invent credentials/adapters; keep supports flags closed.
  -- Do not force-disable an already-enabled row (enablement is gated in Edge + Admin UI).
  environment = COALESCE(public.payment_provider_configs.environment, EXCLUDED.environment),
  supports_customer_payments = false,
  supports_driver_payouts = false
WHERE public.payment_provider_configs.is_enabled IS DISTINCT FROM true
   OR public.payment_provider_configs.supports_customer_payments IS DISTINCT FROM false
   OR public.payment_provider_configs.supports_driver_payouts IS DISTINCT FROM false;

-- Keep stub closed while disabled (safe to re-run).
UPDATE public.payment_provider_configs
SET
  is_enabled = false,
  is_primary = false,
  environment = COALESCE(environment, 'test'),
  status = CASE
    WHEN status IN ('not_configured', 'test', 'connected', 'error', 'live') THEN status
    ELSE 'not_configured'
  END,
  supports_customer_payments = false,
  supports_driver_payouts = false
WHERE provider = 'barclaycard_smartpay'
  AND is_enabled IS DISTINCT FROM true;
