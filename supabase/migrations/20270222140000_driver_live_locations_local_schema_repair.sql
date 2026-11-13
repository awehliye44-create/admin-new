-- ============================================================================
-- driver_live_locations — LOCAL / TEST schema repair (idempotent no-op on prod)
--
-- Why: finalize_pickup_waiting_and_start_trip and finalize_stop_waiting_drive_next
-- read public.driver_live_locations (trusted-GPS fallback). A local database
-- restored from a schema snapshot did not contain the table, so the real Start
-- Trip RPC failed with `relation "public.driver_live_locations" does not exist`.
--
-- The definition below is copied from the original migrations
--   20260306043244 (table, indexes, RLS, admin policy)
--   20260624205719 (driver SELECT-own policy)
-- plus the one extra production index
--   idx_driver_live_locations_driver_id_updated_at
-- (verified read-only against the linked project). Every statement is guarded
-- (IF NOT EXISTS / pg_policy check) so applying this where the table already
-- exists changes nothing. No data is written.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis SCHEMA extensions;

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
CREATE INDEX IF NOT EXISTS idx_driver_live_locations_driver_id_updated_at
  ON public.driver_live_locations (driver_id, updated_at DESC);

ALTER TABLE public.driver_live_locations ENABLE ROW LEVEL SECURITY;

DO $policies$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.driver_live_locations'::regclass
       AND polname = 'Admin full access to driver_live_locations'
  ) THEN
    CREATE POLICY "Admin full access to driver_live_locations"
      ON public.driver_live_locations FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), 'admin'))
      WITH CHECK (public.has_role(auth.uid(), 'admin'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'public.driver_live_locations'::regclass
       AND polname = 'Drivers can view their own live location'
  ) THEN
    CREATE POLICY "Drivers can view their own live location"
      ON public.driver_live_locations
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.drivers d
          WHERE d.id = driver_live_locations.driver_id
            AND d.user_id = auth.uid()
        )
      );
  END IF;
END
$policies$;

COMMIT;
