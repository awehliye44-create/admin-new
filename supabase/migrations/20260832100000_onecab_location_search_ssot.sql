-- Global ONECAB location-search SSOT (Phase 1)
-- Landmarks directory + staged rollout flag. Does not alter payment workflows.

-- ---------------------------------------------------------------------------
-- 1. Landmark directory
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.onecab_location_landmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code text NOT NULL,
  region_id uuid REFERENCES public.regions(id) ON DELETE SET NULL,
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE SET NULL,
  canonical_name text NOT NULL,
  alternative_names text[] NOT NULL DEFAULT '{}',
  category text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  address_description text,
  entrance_instructions text,
  is_verified boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  search_priority integer NOT NULL DEFAULT 100,
  created_by_admin_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onecab_location_landmarks_country_code_chk
    CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT onecab_location_landmarks_lat_chk
    CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT onecab_location_landmarks_lng_chk
    CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS idx_onecab_landmarks_sa_enabled
  ON public.onecab_location_landmarks (service_area_id)
  WHERE enabled = true AND is_verified = true;

CREATE INDEX IF NOT EXISTS idx_onecab_landmarks_country_enabled
  ON public.onecab_location_landmarks (country_code)
  WHERE enabled = true AND is_verified = true;

CREATE INDEX IF NOT EXISTS idx_onecab_landmarks_name_trgm_ready
  ON public.onecab_location_landmarks (lower(canonical_name));

COMMENT ON TABLE public.onecab_location_landmarks IS
  'ONECAB verified local landmarks for global location-search SSOT (supplements Google Places).';

ALTER TABLE public.onecab_location_landmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read enabled verified landmarks" ON public.onecab_location_landmarks;
CREATE POLICY "Anyone can read enabled verified landmarks"
  ON public.onecab_location_landmarks
  FOR SELECT
  USING (enabled = true AND is_verified = true);

DROP POLICY IF EXISTS "Admins manage landmarks" ON public.onecab_location_landmarks;
CREATE POLICY "Admins manage landmarks"
  ON public.onecab_location_landmarks
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---------------------------------------------------------------------------
-- 2. Rollout / feature flag (staged; UK/EU protected until Phase 4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.location_search_rollout (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  global_enabled boolean NOT NULL DEFAULT false,
  google_places_enabled boolean NOT NULL DEFAULT true,
  enabled_service_area_ids uuid[] NOT NULL DEFAULT '{}',
  min_query_length integer NOT NULL DEFAULT 3,
  debounce_ms integer NOT NULL DEFAULT 400,
  max_results integer NOT NULL DEFAULT 8,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.location_search_rollout (
  id, global_enabled, google_places_enabled, enabled_service_area_ids
)
VALUES (true, false, true, ARRAY[]::uuid[])
ON CONFLICT (id) DO NOTHING;

-- Phase 2 seed: enable Banadir for African pilot when SA exists
UPDATE public.location_search_rollout
SET enabled_service_area_ids = ARRAY(
  SELECT DISTINCT x
  FROM unnest(
    COALESCE(enabled_service_area_ids, '{}'::uuid[])
    || ARRAY(
      SELECT sa.id FROM public.service_areas sa
      WHERE lower(sa.name) = 'banadir' AND sa.is_active = true
      LIMIT 1
    )
  ) AS t(x)
  WHERE x IS NOT NULL
),
updated_at = now()
WHERE id = true;

ALTER TABLE public.location_search_rollout ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read location search rollout" ON public.location_search_rollout;
CREATE POLICY "Anyone can read location search rollout"
  ON public.location_search_rollout
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Admins update location search rollout" ON public.location_search_rollout;
CREATE POLICY "Admins update location search rollout"
  ON public.location_search_rollout
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---------------------------------------------------------------------------
-- 3. Landmark search RPC (SECURITY DEFINER — public fields only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_onecab_location_landmarks(
  p_query text,
  p_service_area_id uuid DEFAULT NULL,
  p_country_code text DEFAULT NULL,
  p_region_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_q text := lower(trim(COALESCE(p_query, '')));
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 8), 20));
  v_country text := upper(trim(COALESCE(p_country_code, '')));
  v_out jsonb;
BEGIN
  IF length(v_q) < 2 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF v_country = 'UK' THEN v_country := 'GB'; END IF;
  IF v_country = '' THEN v_country := NULL; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.rank_score DESC, q.canonical_name), '[]'::jsonb)
  INTO v_out
  FROM (
    SELECT
      l.id,
      l.country_code,
      l.region_id,
      l.service_area_id,
      l.canonical_name,
      l.alternative_names,
      l.category,
      l.latitude,
      l.longitude,
      l.address_description,
      l.entrance_instructions,
      l.is_verified,
      l.search_priority,
      (
        CASE
          WHEN lower(l.canonical_name) = v_q THEN 1000
          WHEN lower(l.canonical_name) LIKE v_q || '%' THEN 800
          WHEN lower(l.canonical_name) LIKE '%' || v_q || '%' THEN 600
          WHEN EXISTS (
            SELECT 1 FROM unnest(l.alternative_names) a
            WHERE lower(a) = v_q
          ) THEN 900
          WHEN EXISTS (
            SELECT 1 FROM unnest(l.alternative_names) a
            WHERE lower(a) LIKE '%' || v_q || '%'
          ) THEN 500
          ELSE 0
        END
        + COALESCE(l.search_priority, 0)
        + CASE WHEN p_service_area_id IS NOT NULL AND l.service_area_id = p_service_area_id THEN 200 ELSE 0 END
      ) AS rank_score
    FROM public.onecab_location_landmarks l
    WHERE l.enabled = true
      AND l.is_verified = true
      AND (v_country IS NULL OR l.country_code = v_country)
      AND (p_region_id IS NULL OR l.region_id IS NULL OR l.region_id = p_region_id)
      AND (
        p_service_area_id IS NULL
        OR l.service_area_id IS NULL
        OR l.service_area_id = p_service_area_id
      )
      AND (
        lower(l.canonical_name) LIKE '%' || v_q || '%'
        OR EXISTS (
          SELECT 1 FROM unnest(l.alternative_names) a
          WHERE lower(a) LIKE '%' || v_q || '%'
        )
      )
    ORDER BY rank_score DESC, l.canonical_name ASC
    LIMIT v_limit
  ) q;

  RETURN COALESCE(v_out, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_onecab_location_landmarks(text, uuid, text, uuid, integer)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_location_search_ssot_enabled(p_service_area_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.location_search_rollout%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.location_search_rollout WHERE id = true;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_row.global_enabled THEN
    RETURN true;
  END IF;
  IF p_service_area_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN p_service_area_id = ANY (COALESCE(v_row.enabled_service_area_ids, '{}'::uuid[]));
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_location_search_ssot_enabled(uuid)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Seed Banadir verified landmarks (examples from brief)
-- ---------------------------------------------------------------------------
INSERT INTO public.onecab_location_landmarks (
  country_code, region_id, service_area_id, canonical_name, alternative_names,
  category, latitude, longitude, address_description, is_verified, enabled, search_priority
)
SELECT
  'SO',
  sa.region_id,
  sa.id,
  v.canonical_name,
  v.alternative_names,
  v.category,
  v.latitude,
  v.longitude,
  v.address_description,
  true,
  true,
  v.search_priority
FROM public.service_areas sa
CROSS JOIN (
  VALUES
    ('Aden Adde International Airport', ARRAY['MGQ','Mogadishu Airport','Aden Adde']::text[], 'airport', 2.0144::float8, 45.3047::float8, 'Aden Adde International Airport, Mogadishu', 200),
    ('KM4 Junction', ARRAY['KM4','KM 4','Kilo 4']::text[], 'junction', 2.0371::float8, 45.3419::float8, 'KM4 Junction, Banadir', 180),
    ('Bakara Market', ARRAY['Bakaara','Bakaaro Market']::text[], 'market', 2.0379::float8, 45.3265::float8, 'Bakara Market, Mogadishu', 170),
    ('Medina Hospital', ARRAY['Medina','Madina Hospital','Isbitaalka Medina']::text[], 'hospital', 2.0335::float8, 45.3180::float8, 'Medina Hospital, Banadir', 190),
    ('Taleex', ARRAY['Taleh','Taleex Junction']::text[], 'neighbourhood', 2.0460::float8, 45.3188::float8, 'Taleex, Banadir', 150)
) AS v(canonical_name, alternative_names, category, latitude, longitude, address_description, search_priority)
WHERE lower(sa.name) = 'banadir'
  AND sa.is_active = true
  AND NOT EXISTS (
    SELECT 1 FROM public.onecab_location_landmarks e
    WHERE e.service_area_id = sa.id
      AND lower(e.canonical_name) = lower(v.canonical_name)
  );
