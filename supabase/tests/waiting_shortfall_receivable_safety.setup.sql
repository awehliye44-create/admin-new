-- Throwaway-cluster stubs for the real receivable + shortfall-safety migrations.
-- Never run against a shared or production database.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.customers (id uuid PRIMARY KEY, user_id uuid NULL);
CREATE TABLE public.trips (id uuid PRIMARY KEY, trip_code text NULL);
CREATE TABLE public.payment_sessions (
  id uuid PRIMARY KEY,
  trip_id uuid NULL REFERENCES public.trips(id),
  provider_order_id text NULL,
  captured_amount_pence integer NULL,
  trip_fare_component_pence integer NULL,
  tip_component_pence integer NULL,
  receivable_component_pence integer NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  user_id uuid NULL,
  driver_id uuid NULL,
  trip_id uuid NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.assert_finance_payout_ledger_access() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('test.finance_access', true), '') <> '1' THEN
    RAISE EXCEPTION 'finance_access_denied' USING ERRCODE = '42501';
  END IF;
END $$;
