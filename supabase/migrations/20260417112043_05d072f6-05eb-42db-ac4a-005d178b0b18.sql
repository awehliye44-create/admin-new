
DO $$ BEGIN
  CREATE TYPE public.offer_type AS ENUM ('percent_discount','fixed_amount_discount');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.offer_status AS ENUM ('draft','active','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.offer_redemption_status AS ENUM ('reserved','applied','reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.offers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  code            TEXT NOT NULL UNIQUE,
  description     TEXT,
  offer_type      public.offer_type NOT NULL,
  discount_value  NUMERIC(12,2) NOT NULL CHECK (discount_value >= 0),
  currency        TEXT NOT NULL DEFAULT 'GBP',
  min_fare_pence  INTEGER NOT NULL DEFAULT 0 CHECK (min_fare_pence >= 0),
  max_discount_pence INTEGER CHECK (max_discount_pence IS NULL OR max_discount_pence >= 0),
  starts_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at         TIMESTAMPTZ,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  status          public.offer_status NOT NULL DEFAULT 'active',
  first_ride_only BOOLEAN NOT NULL DEFAULT false,
  new_customer_only BOOLEAN NOT NULL DEFAULT false,
  per_user_limit  INTEGER,
  total_usage_limit INTEGER,
  usage_count     INTEGER NOT NULL DEFAULT 0,
  priority        INTEGER NOT NULL DEFAULT 100,
  terms           TEXT,
  banner_title    TEXT NOT NULL,
  banner_subtitle TEXT,
  cta_text        TEXT NOT NULL DEFAULT 'View offer',
  badge_text      TEXT,
  style_variant   TEXT NOT NULL DEFAULT 'default',
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_offers_active ON public.offers(is_enabled, status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_offers_priority ON public.offers(priority DESC);

CREATE TABLE IF NOT EXISTS public.offer_service_areas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id        UUID NOT NULL REFERENCES public.offers(id) ON DELETE CASCADE,
  service_area_id UUID NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(offer_id, service_area_id)
);
CREATE INDEX IF NOT EXISTS idx_offer_sa_offer ON public.offer_service_areas(offer_id);
CREATE INDEX IF NOT EXISTS idx_offer_sa_area  ON public.offer_service_areas(service_area_id);

CREATE TABLE IF NOT EXISTS public.offer_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id        UUID NOT NULL REFERENCES public.offers(id) ON DELETE RESTRICT,
  customer_id     UUID,
  user_id         UUID,
  trip_id         UUID,
  service_area_id UUID,
  discount_pence  INTEGER NOT NULL CHECK (discount_pence >= 0),
  original_fare_pence INTEGER NOT NULL CHECK (original_fare_pence >= 0),
  final_fare_pence INTEGER NOT NULL CHECK (final_fare_pence >= 0),
  currency        TEXT NOT NULL,
  status          public.offer_redemption_status NOT NULL DEFAULT 'applied',
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_redemptions_offer ON public.offer_redemptions(offer_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_customer ON public.offer_redemptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON public.offer_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_trip ON public.offer_redemptions(trip_id);

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS applied_offer_id UUID REFERENCES public.offers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS applied_offer_code TEXT,
  ADD COLUMN IF NOT EXISTS offer_discount_pence INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offer_currency TEXT;

DROP TRIGGER IF EXISTS update_offers_updated_at ON public.offers;
CREATE TRIGGER update_offers_updated_at
  BEFORE UPDATE ON public.offers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offer_service_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offer_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "offers_public_active_read" ON public.offers;
CREATE POLICY "offers_public_active_read" ON public.offers
FOR SELECT TO authenticated
USING (
  is_enabled = true
  AND status = 'active'
  AND starts_at <= now()
  AND (ends_at IS NULL OR ends_at > now())
);

DROP POLICY IF EXISTS "offers_admin_full_read" ON public.offers;
CREATE POLICY "offers_admin_full_read" ON public.offers
FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "offers_admin_write" ON public.offers;
CREATE POLICY "offers_admin_write" ON public.offers
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "offer_sa_read" ON public.offer_service_areas;
CREATE POLICY "offer_sa_read" ON public.offer_service_areas
FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "offer_sa_admin_write" ON public.offer_service_areas;
CREATE POLICY "offer_sa_admin_write" ON public.offer_service_areas
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "redemptions_owner_read" ON public.offer_redemptions;
CREATE POLICY "redemptions_owner_read" ON public.offer_redemptions
FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR public.has_role(auth.uid(), 'admin')
);
