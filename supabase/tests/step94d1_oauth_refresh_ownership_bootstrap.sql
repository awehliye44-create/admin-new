-- Step 9.4D1 throwaway harness: minimal vault + roles for OAuth refresh ownership RPCs.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.payment_provider_vault (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  provider text NOT NULL,
  environment text NOT NULL,
  secret_name text NOT NULL,
  secret_value text NOT NULL,
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_provider_vault_unique UNIQUE (provider, environment, secret_name)
);

-- Expired Business token set for claim tests (values are fixtures, not live secrets).
INSERT INTO public.payment_provider_vault (provider, environment, secret_name, secret_value)
VALUES
  ('revolut', 'live', 'business_access_token', 'fixture_access_expired'),
  ('revolut', 'live', 'REVOLUT_BUSINESS_ACCESS_TOKEN', 'fixture_access_expired'),
  ('revolut', 'live', 'business_refresh_token', 'fixture_refresh'),
  ('revolut', 'live', 'REVOLUT_BUSINESS_REFRESH_TOKEN', 'fixture_refresh'),
  ('revolut', 'live', 'business_token_expires_at', '2026-08-20T00:00:00.000Z'),
  ('revolut', 'live', 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT', '2026-08-20T00:00:00.000Z')
ON CONFLICT (provider, environment, secret_name) DO UPDATE
SET secret_value = EXCLUDED.secret_value, updated_at = now();
