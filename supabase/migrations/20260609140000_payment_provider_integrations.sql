-- Payment Provider Integrations: config, secret metadata, secure vault, provider-neutral columns

CREATE TABLE IF NOT EXISTS public.payment_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  display_name text NOT NULL,
  environment text NOT NULL DEFAULT 'live' CHECK (environment IN ('test', 'live')),
  status text NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured', 'connected', 'error', 'live', 'test')),
  is_enabled boolean NOT NULL DEFAULT false,
  is_primary boolean NOT NULL DEFAULT false,
  connect_enabled boolean,
  apple_pay_enabled boolean,
  google_pay_enabled boolean,
  webhook_endpoint_url text,
  last_connection_test_at timestamptz,
  last_connection_test_status text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_provider_configs_provider_unique UNIQUE (provider)
);

CREATE TABLE IF NOT EXISTS public.payment_provider_secret_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  secret_name text NOT NULL,
  masked_value text,
  is_configured boolean NOT NULL DEFAULT false,
  last_updated timestamptz,
  updated_by uuid,
  CONSTRAINT payment_provider_secret_metadata_unique UNIQUE (provider, environment, secret_name)
);

-- Vault: service-role only — no RLS policies for authenticated users
CREATE TABLE IF NOT EXISTS public.payment_provider_vault (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  secret_name text NOT NULL,
  secret_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payment_provider_vault_unique UNIQUE (provider, environment, secret_name)
);

ALTER TABLE public.payment_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_provider_secret_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_provider_vault ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read payment provider configs"
  ON public.payment_provider_configs FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update payment provider configs"
  ON public.payment_provider_configs FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can read payment provider secret metadata"
  ON public.payment_provider_secret_metadata FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- Vault: no SELECT/INSERT policies — edge functions use service role only

CREATE OR REPLACE FUNCTION public.set_payment_provider_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_payment_provider_configs_updated ON public.payment_provider_configs;
CREATE TRIGGER tr_payment_provider_configs_updated
  BEFORE UPDATE ON public.payment_provider_configs
  FOR EACH ROW EXECUTE FUNCTION public.set_payment_provider_updated_at();

-- Seed provider rows
INSERT INTO public.payment_provider_configs (provider, display_name, environment, is_enabled, is_primary, webhook_endpoint_url)
VALUES
  ('stripe', 'Stripe', 'live', true, true,
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/stripe-webhook'),
  ('checkout_com', 'Checkout.com', 'test', false, false, NULL),
  ('adyen', 'Adyen', 'test', false, false, NULL),
  ('worldpay', 'Worldpay', 'test', false, false, NULL),
  ('braintree', 'Braintree', 'test', false, false, NULL)
ON CONFLICT (provider) DO NOTHING;

-- Provider-neutral columns on payments
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_provider text,
  ADD COLUMN IF NOT EXISTS provider_payment_id text,
  ADD COLUMN IF NOT EXISTS provider_charge_id text,
  ADD COLUMN IF NOT EXISTS provider_transfer_id text,
  ADD COLUMN IF NOT EXISTS provider_payout_id text,
  ADD COLUMN IF NOT EXISTS provider_fee_pence integer,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_webhook_event_id text,
  ADD COLUMN IF NOT EXISTS provider_available_on timestamptz;

UPDATE public.payments
SET
  payment_provider = COALESCE(payment_provider, 'stripe'),
  provider_payment_id = COALESCE(provider_payment_id, stripe_payment_intent_id),
  provider_fee_pence = COALESCE(provider_fee_pence, stripe_fee_pence)
WHERE stripe_payment_intent_id IS NOT NULL;

-- Provider-neutral columns on trips
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS payment_provider text,
  ADD COLUMN IF NOT EXISTS provider_payment_id text,
  ADD COLUMN IF NOT EXISTS provider_charge_id text,
  ADD COLUMN IF NOT EXISTS provider_transfer_id text,
  ADD COLUMN IF NOT EXISTS provider_payout_id text,
  ADD COLUMN IF NOT EXISTS provider_fee_pence integer,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_webhook_event_id text,
  ADD COLUMN IF NOT EXISTS provider_available_on timestamptz;

UPDATE public.trips
SET
  payment_provider = COALESCE(payment_provider, 'stripe'),
  provider_payment_id = COALESCE(provider_payment_id, stripe_payment_intent_id),
  provider_charge_id = COALESCE(provider_charge_id, stripe_charge_id),
  provider_transfer_id = COALESCE(provider_transfer_id, stripe_transfer_id),
  provider_fee_pence = COALESCE(provider_fee_pence, stripe_processing_fee_pence)
WHERE stripe_payment_intent_id IS NOT NULL OR stripe_charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_payment_provider ON public.payments (payment_provider);
CREATE INDEX IF NOT EXISTS idx_trips_payment_provider ON public.trips (payment_provider);
