
-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;

-- Create driver_live_locations table
CREATE TABLE IF NOT EXISTS public.driver_live_locations (
  driver_id uuid PRIMARY KEY REFERENCES public.drivers(id) ON DELETE CASCADE,
  loc extensions.geography(Point, 4326) NOT NULL,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  geohash6 text NOT NULL,
  speed real NULL,
  heading real NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dll_loc ON public.driver_live_locations USING GIST (loc);
CREATE INDEX IF NOT EXISTS idx_dll_geohash6 ON public.driver_live_locations (geohash6);
CREATE INDEX IF NOT EXISTS idx_dll_updated_at ON public.driver_live_locations (updated_at);

ALTER TABLE public.driver_live_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access to driver_live_locations"
  ON public.driver_live_locations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Add columns to drivers
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='drivers' AND column_name='last_offer_at') THEN
    ALTER TABLE public.drivers ADD COLUMN last_offer_at timestamptz NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='drivers' AND column_name='last_trip_end_at') THEN
    ALTER TABLE public.drivers ADD COLUMN last_trip_end_at timestamptz NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='drivers' AND column_name='online_since') THEN
    ALTER TABLE public.drivers ADD COLUMN online_since timestamptz NULL;
  END IF;
END $$;

-- Add dispatch_weight to driver_categories
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='driver_categories' AND column_name='dispatch_weight') THEN
    ALTER TABLE public.driver_categories ADD COLUMN dispatch_weight integer NOT NULL DEFAULT 10;
  END IF;
END $$;

-- Add new dispatch settings columns
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_settings' AND column_name='search_radius_start_km') THEN
    ALTER TABLE public.dispatch_settings ADD COLUMN search_radius_start_km real NOT NULL DEFAULT 3;
    ALTER TABLE public.dispatch_settings ADD COLUMN search_radius_expand_km real NOT NULL DEFAULT 5;
    ALTER TABLE public.dispatch_settings ADD COLUMN search_radius_max_km real NOT NULL DEFAULT 8;
    ALTER TABLE public.dispatch_settings ADD COLUMN shortlist_limit integer NOT NULL DEFAULT 100;
    ALTER TABLE public.dispatch_settings ADD COLUMN wave1_size integer NOT NULL DEFAULT 3;
    ALTER TABLE public.dispatch_settings ADD COLUMN wave2_size integer NOT NULL DEFAULT 5;
    ALTER TABLE public.dispatch_settings ADD COLUMN wave3_size integer NOT NULL DEFAULT 10;
    ALTER TABLE public.dispatch_settings ADD COLUMN distance_penalty_per_km real NOT NULL DEFAULT 2.0;
    ALTER TABLE public.dispatch_settings ADD COLUMN waiting_bonus_per_minute real NOT NULL DEFAULT 0.5;
    ALTER TABLE public.dispatch_settings ADD COLUMN max_waiting_bonus_minutes integer NOT NULL DEFAULT 20;
    ALTER TABLE public.dispatch_settings ADD COLUMN fairness_idle_minutes integer NOT NULL DEFAULT 20;
    ALTER TABLE public.dispatch_settings ADD COLUMN fairness_boost_score real NOT NULL DEFAULT 10;
  END IF;
END $$;

-- Dispatch candidates log
CREATE TABLE IF NOT EXISTS public.dispatch_candidates_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  category_name text NULL,
  dispatch_weight integer NULL,
  distance_km real NOT NULL,
  waiting_minutes real NULL,
  dispatch_score real NOT NULL,
  wave integer NULL,
  offer_result text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dcl_trip ON public.dispatch_candidates_log (trip_id);

ALTER TABLE public.dispatch_candidates_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin access dispatch_candidates_log"
  ON public.dispatch_candidates_log FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
