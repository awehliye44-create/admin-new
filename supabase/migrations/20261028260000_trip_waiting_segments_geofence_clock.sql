-- Waiting-time geofence segment clock.
-- Money counts only while trusted driver GPS is inside pickup/stop radius.
-- Workflow buttons stay flexible (Arrived / Start / Drive Next / Complete).

BEGIN;

CREATE TABLE IF NOT EXISTS public.trip_waiting_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips (id) ON DELETE CASCADE,
  location_type text NOT NULL CHECK (location_type IN ('pickup', 'stop')),
  stop_id uuid NULL REFERENCES public.trip_stops (id) ON DELETE SET NULL,
  stop_index integer NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NULL,
  inside_radius boolean NOT NULL DEFAULT true,
  distance_meters double precision NULL,
  source_location text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_waiting_segments_open_inside_chk
    CHECK (inside_radius = true OR ended_at IS NOT NULL),
  CONSTRAINT trip_waiting_segments_time_order_chk
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_trip_waiting_segments_trip
  ON public.trip_waiting_segments (trip_id, location_type, started_at);

CREATE INDEX IF NOT EXISTS idx_trip_waiting_segments_open
  ON public.trip_waiting_segments (trip_id, location_type)
  WHERE ended_at IS NULL;

ALTER TABLE public.trip_waiting_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read waiting segments" ON public.trip_waiting_segments;
CREATE POLICY "Admins read waiting segments"
  ON public.trip_waiting_segments
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Service role / Edge writers only for mutations (no authenticated INSERT).
REVOKE ALL ON TABLE public.trip_waiting_segments FROM PUBLIC;
GRANT SELECT ON TABLE public.trip_waiting_segments TO authenticated;
GRANT ALL ON TABLE public.trip_waiting_segments TO service_role;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS pickup_waiting_counted_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_waiting_counted_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS waiting_geofence_status text NULL,
  ADD COLUMN IF NOT EXISTS waiting_geofence_checked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS waiting_geofence_distance_m double precision NULL;

COMMENT ON TABLE public.trip_waiting_segments IS
  'In-radius waiting segments. Chargeable waiting = sum of closed + open segment durations only.';
COMMENT ON COLUMN public.trips.pickup_waiting_counted_seconds IS
  'Trusted in-radius pickup waiting seconds (segment sum). Charge from this, not wall-time.';
COMMENT ON COLUMN public.trips.stop_waiting_counted_seconds IS
  'Trusted in-radius stop waiting seconds (segment sum) for the active/aggregated stop clock.';
COMMENT ON COLUMN public.trips.waiting_geofence_status IS
  'counting | paused | not_started — for Driver/Customer existing-card UI.';

COMMIT;
