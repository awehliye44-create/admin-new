-- Service-area scoped driver tier configuration (commission, dispatch priority, promotion targets).
-- Replaces global driver_categories as SSOT for per-SA tier economics.

CREATE TABLE IF NOT EXISTS public.service_area_driver_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  tier_name text NOT NULL,
  category_priority integer NOT NULL DEFAULT 10,
  commission_percent numeric(5,2) NOT NULL,
  trip_target integer,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_area_driver_tiers_sa_tier_unique UNIQUE (service_area_id, tier_name),
  CONSTRAINT service_area_driver_tiers_commission_range CHECK (commission_percent >= 0 AND commission_percent <= 100),
  CONSTRAINT service_area_driver_tiers_category_priority_nonneg CHECK (category_priority >= 0)
);

COMMENT ON TABLE public.service_area_driver_tiers IS
  'Per service area driver tier config: commission %, dispatch category_priority, auto-promotion trip_target.';
COMMENT ON COLUMN public.service_area_driver_tiers.tier_name IS
  'Tier label matching driver_categories.name (Bronze, Silver, Gold, Platinum, Diamond).';
COMMENT ON COLUMN public.service_area_driver_tiers.commission_percent IS
  'Commission % applied to commissionable fare for trips in this service area.';
COMMENT ON COLUMN public.service_area_driver_tiers.category_priority IS
  'Dispatch scoring weight for drivers in this tier operating in this service area.';

CREATE INDEX IF NOT EXISTS idx_service_area_driver_tiers_service_area
  ON public.service_area_driver_tiers (service_area_id, display_order);

CREATE TRIGGER update_service_area_driver_tiers_updated_at
  BEFORE UPDATE ON public.service_area_driver_tiers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.service_area_driver_tiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage service area driver tiers"
  ON public.service_area_driver_tiers
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Anyone can read active service area driver tiers"
  ON public.service_area_driver_tiers
  FOR SELECT
  USING (is_active = true);

-- Backfill: copy global driver_categories into every service area.
INSERT INTO public.service_area_driver_tiers (
  service_area_id,
  tier_name,
  category_priority,
  commission_percent,
  trip_target,
  is_active,
  display_order
)
SELECT
  sa.id,
  dc.name,
  COALESCE(dc.category_priority, 10),
  COALESCE(dc.commission_pct, 0),
  dc.trip_target,
  dc.is_active,
  COALESCE(dc.display_order, dc.level_order, 0)
FROM public.service_areas sa
CROSS JOIN public.driver_categories dc
WHERE LOWER(dc.name) IN ('bronze', 'silver', 'gold', 'platinum', 'diamond')
ON CONFLICT (service_area_id, tier_name) DO NOTHING;

-- Resolve driver tier name from drivers.category_id → driver_categories.
CREATE OR REPLACE FUNCTION public.resolve_driver_tier_name(p_driver_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(dc.name, 'Bronze')
  FROM public.drivers d
  LEFT JOIN public.driver_categories dc
    ON dc.id = d.category_id
   AND dc.is_active = true
  WHERE d.id = p_driver_id
  LIMIT 1;
$$;

-- Service-area tier commission SSOT.
CREATE OR REPLACE FUNCTION public.resolve_driver_tier_commission_percent(
  p_driver_id uuid,
  p_service_area_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier_name text;
  v_pct numeric;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN 0;
  END IF;

  IF p_service_area_id IS NULL THEN
    RAISE WARNING 'resolve_driver_tier_commission_percent: service_area_id is NULL for driver %', p_driver_id;
    RETURN 0;
  END IF;

  v_tier_name := public.resolve_driver_tier_name(p_driver_id);

  SELECT sat.commission_percent
    INTO v_pct
  FROM public.service_area_driver_tiers sat
  WHERE sat.service_area_id = p_service_area_id
    AND LOWER(sat.tier_name) = LOWER(v_tier_name)
    AND sat.is_active = true
  LIMIT 1;

  IF v_pct IS NULL THEN
    SELECT sat.commission_percent
      INTO v_pct
    FROM public.service_area_driver_tiers sat
    WHERE sat.service_area_id = p_service_area_id
      AND LOWER(sat.tier_name) = 'bronze'
      AND sat.is_active = true
    LIMIT 1;

    RAISE WARNING
      'resolve_driver_tier_commission_percent: tier % missing for service_area % — Bronze fallback used',
      v_tier_name, p_service_area_id;
  END IF;

  RETURN COALESCE(v_pct, 0)::numeric;
END;
$$;

-- Dispatch scoring: category_priority from service-area tier row.
CREATE OR REPLACE FUNCTION public.resolve_driver_tier_category_priority(
  p_driver_id uuid,
  p_service_area_id uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier_name text;
  v_priority integer;
BEGIN
  IF p_driver_id IS NULL OR p_service_area_id IS NULL THEN
    RETURN 0;
  END IF;

  v_tier_name := public.resolve_driver_tier_name(p_driver_id);

  SELECT sat.category_priority
    INTO v_priority
  FROM public.service_area_driver_tiers sat
  WHERE sat.service_area_id = p_service_area_id
    AND LOWER(sat.tier_name) = LOWER(v_tier_name)
    AND sat.is_active = true
  LIMIT 1;

  IF v_priority IS NULL THEN
    SELECT sat.category_priority
      INTO v_priority
    FROM public.service_area_driver_tiers sat
    WHERE sat.service_area_id = p_service_area_id
      AND LOWER(sat.tier_name) = 'bronze'
      AND sat.is_active = true
    LIMIT 1;
  END IF;

  RETURN COALESCE(v_priority, 0);
END;
$$;

-- Drop legacy single-arg resolver (global driver_categories commission).
DROP FUNCTION IF EXISTS public.resolve_driver_tier_commission_percent(uuid);

GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_name(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_commission_percent(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) TO authenticated, service_role;

-- Snapshot commission using trip.service_area_id.
CREATE OR REPLACE FUNCTION public.snapshot_driver_tier_commission_on_trip(
  p_trip_id uuid,
  p_driver_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_pct numeric;
  v_pct_capped numeric;
  v_base_pence integer;
  v_gross_pence integer;
  v_airport_pence integer;
  v_pass_through_pence integer;
  v_commissionable_pence integer;
  v_commission_pence integer;
  v_driver_net_pence integer;
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_pct := public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id);
  v_pct_capped := LEAST(15, GREATEST(0, COALESCE(v_pct, 0)));

  v_base_pence := COALESCE(
    NULLIF(v_trip.final_fare_pence, 0),
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.fare, 0) * 100)::integer, 0),
    0
  );

  v_gross_pence := COALESCE(
    NULLIF(v_trip.gross_fare_pence, 0),
    NULLIF(v_base_pence, 0),
    0
  );

  v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
  v_pass_through_pence := COALESCE(v_trip.other_pass_through_charges_pence, 0);

  v_commissionable_pence := GREATEST(0, v_base_pence - v_airport_pence - v_pass_through_pence);
  v_commission_pence := ROUND(v_commissionable_pence * v_pct_capped / 100.0);
  v_driver_net_pence := GREATEST(0, v_gross_pence - v_commission_pence);

  UPDATE public.trips
  SET
    driver_tier_commission_percent = v_pct_capped,
    commission_pct = v_pct_capped,
    commissionable_fare_pence = v_commissionable_pence,
    commission_pence = v_commission_pence,
    driver_net_pence = v_driver_net_pence,
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'driver_tier_commission_percent', v_pct_capped,
        'commissionable_fare_pence', NULLIF(v_commissionable_pence, 0),
        'commission_pence', NULLIF(v_commission_pence, 0),
        'driver_net_pence', NULLIF(v_driver_net_pence, 0),
        'commission_recalculated_at', now()
      )),
    updated_at = now()
  WHERE id = p_trip_id;

  RETURN v_pct_capped;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snapshot_driver_tier_commission_on_trip(uuid, uuid) TO authenticated, service_role;

-- Auto-promote using service-area tier trip_target and display_order ladder.
CREATE OR REPLACE FUNCTION public.auto_promote_driver_tier()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id uuid;
  v_service_area_id uuid;
  v_completed_trips integer;
  v_tier_name text;
  v_current_tier public.service_area_driver_tiers%ROWTYPE;
  v_next_tier public.service_area_driver_tiers%ROWTYPE;
  v_next_category_id uuid;
BEGIN
  IF NEW.status = 'completed'
     AND (OLD.status IS DISTINCT FROM 'completed')
     AND NEW.driver_id IS NOT NULL
     AND NEW.service_area_id IS NOT NULL THEN
    v_driver_id := NEW.driver_id;
    v_service_area_id := NEW.service_area_id;

    SELECT COUNT(*) INTO v_completed_trips
    FROM public.trips
    WHERE driver_id = v_driver_id AND status = 'completed';

    v_tier_name := public.resolve_driver_tier_name(v_driver_id);

    SELECT * INTO v_current_tier
    FROM public.service_area_driver_tiers sat
    WHERE sat.service_area_id = v_service_area_id
      AND LOWER(sat.tier_name) = LOWER(v_tier_name)
      AND sat.is_active = true
    LIMIT 1;

    IF v_current_tier IS NULL OR v_current_tier.trip_target IS NULL THEN
      RETURN NEW;
    END IF;

    IF v_completed_trips >= v_current_tier.trip_target THEN
      SELECT * INTO v_next_tier
      FROM public.service_area_driver_tiers sat
      WHERE sat.service_area_id = v_service_area_id
        AND sat.display_order > v_current_tier.display_order
        AND sat.is_active = true
      ORDER BY sat.display_order ASC
      LIMIT 1;

      IF v_next_tier IS NOT NULL THEN
        SELECT id INTO v_next_category_id
        FROM public.driver_categories dc
        WHERE LOWER(dc.name) = LOWER(v_next_tier.tier_name)
          AND dc.is_active = true
        LIMIT 1;

        IF v_next_category_id IS NOT NULL THEN
          UPDATE public.drivers
          SET category_id = v_next_category_id, updated_at = now()
          WHERE id = v_driver_id;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Patch commit_negotiation_fare to resolve commission from trip service area.
DO $patch$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'commit_negotiation_fare'
  LIMIT 1;

  IF v_def IS NOT NULL THEN
    v_def := replace(
      v_def,
      'v_pct := public.resolve_driver_tier_commission_percent(p_driver_id);',
      'v_pct := public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id);'
    );
    EXECUTE v_def;
  END IF;
END;
$patch$;

-- Patch finalize_negotiated_fare if present.
DO $patch$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'finalize_negotiated_fare'
  LIMIT 1;

  IF v_def IS NOT NULL THEN
    v_def := replace(
      v_def,
      'v_pct := public.resolve_driver_tier_commission_percent(p_driver_id);',
      'v_pct := public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id);'
    );
    EXECUTE v_def;
  END IF;
END;
$patch$;

COMMENT ON COLUMN public.trips.driver_tier_commission_percent IS
  'Snapshot of service_area_driver_tiers.commission_percent at assignment/accept (0–100, capped at 15% in app).';

NOTIFY pgrst, 'reload schema';
