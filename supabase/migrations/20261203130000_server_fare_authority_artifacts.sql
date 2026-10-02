-- ============================================================
-- Server-authoritative fare chain (P0)
--
--   calculate-route  → route_quote_artifacts   (server distance / duration / SA)
--   calculate-fare   → server_fare_quotes      (pricing-engine.ts result)
--   booking quote    → booking_payment_quotes.server_fare_quote_id
--
-- The Customer app transports opaque ids at most. It is never authoritative
-- for distance, fare, buffer, service area, voucher or discount state.
--
-- Service-role only. Forward-only. Do NOT apply unless explicitly approved.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.route_quote_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  route_key text NOT NULL,
  pickup_lat double precision NOT NULL,
  pickup_lng double precision NOT NULL,
  dropoff_lat double precision NOT NULL,
  dropoff_lng double precision NOT NULL,
  stops jsonb NOT NULL DEFAULT '[]'::jsonb,
  distance_meters integer NOT NULL,
  duration_seconds integer NOT NULL,
  distance_km numeric(10, 2) NOT NULL,
  duration_min integer NOT NULL,
  provider text NOT NULL,
  profile text NULL,
  departure_at timestamptz NULL,
  service_area_id uuid NULL REFERENCES public.service_areas(id),
  schema_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT route_quote_artifacts_provider_chk CHECK (provider = 'mapbox_directions'),
  CONSTRAINT route_quote_artifacts_distance_chk CHECK (distance_meters > 0 AND distance_km > 0),
  CONSTRAINT route_quote_artifacts_duration_chk CHECK (duration_seconds >= 0 AND duration_min >= 0),
  CONSTRAINT route_quote_artifacts_expiry_chk CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS route_quote_artifacts_user_route_idx
  ON public.route_quote_artifacts (user_id, route_key, created_at DESC);

CREATE INDEX IF NOT EXISTS route_quote_artifacts_expires_idx
  ON public.route_quote_artifacts (expires_at);

CREATE TABLE IF NOT EXISTS public.server_fare_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  route_quote_id uuid NOT NULL REFERENCES public.route_quote_artifacts(id) ON DELETE CASCADE,
  route_key text NOT NULL,
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id),
  vehicle_type_id uuid NOT NULL,
  currency text NOT NULL,
  distance_km numeric(10, 2) NOT NULL,
  duration_min integer NOT NULL,
  gross_fare_pence integer NOT NULL,
  airport_charge_pence integer NOT NULL DEFAULT 0,
  surge_multiplier numeric(8, 3) NOT NULL DEFAULT 1,
  surge_quote_id text NULL,
  fare_source text NULL,
  pricing_mode text NULL,
  minimum_applied boolean NOT NULL DEFAULT false,
  is_scheduled boolean NOT NULL DEFAULT false,
  engine text NOT NULL DEFAULT 'pricing-engine.ts',
  pricing_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  pricing_hash text NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT server_fare_quotes_gross_positive_chk CHECK (gross_fare_pence > 0),
  CONSTRAINT server_fare_quotes_airport_nonneg_chk CHECK (airport_charge_pence >= 0),
  CONSTRAINT server_fare_quotes_surge_chk CHECK (surge_multiplier >= 1),
  CONSTRAINT server_fare_quotes_expiry_chk CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS server_fare_quotes_user_route_vehicle_idx
  ON public.server_fare_quotes (user_id, route_key, vehicle_type_id, created_at DESC);

CREATE INDEX IF NOT EXISTS server_fare_quotes_expires_idx
  ON public.server_fare_quotes (expires_at);

-- Artifacts are evidence: no field may change after insert.
CREATE OR REPLACE FUNCTION public.server_fare_artifacts_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public
AS $trg$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$trg$;

DROP TRIGGER IF EXISTS route_quote_artifacts_immutable_trg ON public.route_quote_artifacts;
CREATE TRIGGER route_quote_artifacts_immutable_trg
  BEFORE UPDATE ON public.route_quote_artifacts
  FOR EACH ROW EXECUTE FUNCTION public.server_fare_artifacts_immutable();

DROP TRIGGER IF EXISTS server_fare_quotes_immutable_trg ON public.server_fare_quotes;
CREATE TRIGGER server_fare_quotes_immutable_trg
  BEFORE UPDATE ON public.server_fare_quotes
  FOR EACH ROW EXECUTE FUNCTION public.server_fare_artifacts_immutable();

ALTER TABLE public.route_quote_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_fare_quotes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.route_quote_artifacts FROM PUBLIC;
REVOKE ALL ON TABLE public.route_quote_artifacts FROM anon, authenticated;
GRANT ALL ON TABLE public.route_quote_artifacts TO service_role;

REVOKE ALL ON TABLE public.server_fare_quotes FROM PUBLIC;
REVOKE ALL ON TABLE public.server_fare_quotes FROM anon, authenticated;
GRANT ALL ON TABLE public.server_fare_quotes TO service_role;

-- ─── Payment quote binds the server fare artifact ─────────────

ALTER TABLE public.booking_payment_quotes
  ADD COLUMN IF NOT EXISTS server_fare_quote_id uuid NULL
    REFERENCES public.server_fare_quotes(id),
  ADD COLUMN IF NOT EXISTS pricing_fingerprint text NULL;

CREATE OR REPLACE FUNCTION public.booking_payment_quotes_immutable_financials()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public
AS $trg$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.client_action_id IS DISTINCT FROM OLD.client_action_id
       OR NEW.service_area_id IS DISTINCT FROM OLD.service_area_id
       OR NEW.ride_category IS DISTINCT FROM OLD.ride_category
       OR NEW.route_fingerprint IS DISTINCT FROM OLD.route_fingerprint
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.trip_fare_pence IS DISTINCT FROM OLD.trip_fare_pence
       OR NEW.buffer_pence IS DISTINCT FROM OLD.buffer_pence
       OR NEW.receivable_pence IS DISTINCT FROM OLD.receivable_pence
       OR NEW.total_authorisation_pence IS DISTINCT FROM OLD.total_authorisation_pence
       OR NEW.fold_eligible IS DISTINCT FROM OLD.fold_eligible
       OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.server_fare_quote_id IS DISTINCT FROM OLD.server_fare_quote_id
       OR NEW.pricing_fingerprint IS DISTINCT FROM OLD.pricing_fingerprint
    THEN
      RAISE EXCEPTION 'booking_payment_quotes financial fields are immutable after issuance'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$trg$;

COMMENT ON TABLE public.route_quote_artifacts IS
  'Server route measurement from calculate-route (Mapbox). Sole distance/duration authority for server_fare_quotes.';
COMMENT ON TABLE public.server_fare_quotes IS
  'pricing-engine.ts result bound to a route artifact. Sole fare authority for booking_payment_quotes.';
COMMENT ON COLUMN public.booking_payment_quotes.server_fare_quote_id IS
  'Immutable server fare artifact this payment quote prices. Reuse requires equality.';
COMMENT ON COLUMN public.booking_payment_quotes.pricing_fingerprint IS
  'Server fare id + gross + discount (source/offer/voucher) + buffer. Reuse requires equality.';

COMMIT;
