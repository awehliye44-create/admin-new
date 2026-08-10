CREATE TABLE IF NOT EXISTS public.location_search_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text NOT NULL UNIQUE,
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE CASCADE,
  normalized_query text NOT NULL,
  language_code text NOT NULL DEFAULT 'en',
  centre_lat double precision,
  centre_lng double precision,
  radius_metres integer,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  hit_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days')
);

GRANT ALL ON public.location_search_cache TO service_role;

ALTER TABLE public.location_search_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "location_search_cache_service_role_only" ON public.location_search_cache;
CREATE POLICY "location_search_cache_service_role_only"
  ON public.location_search_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_location_search_cache_expires
  ON public.location_search_cache (expires_at);

UPDATE public.location_search_rollout
   SET global_enabled = true,
       updated_at = now()
 WHERE id = true;