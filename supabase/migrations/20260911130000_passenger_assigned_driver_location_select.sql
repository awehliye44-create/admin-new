-- ============================================================================
-- P0 — Customer active-trip live location (trip-scoped projection)
-- DO NOT APPLY until explicitly approved after the pre-deploy report.
--
-- Replaces the earlier draft that opened SELECT on public.drivers for passengers.
-- Passengers must NEVER gain general access to drivers rows.
--
-- Design:
--   1. public.trip_driver_live_location — minimum location columns only
--   2. RLS: authenticated customer may SELECT only their owned live trip row
--   3. submit_driver_location_sample gains p_trip_id / p_location_sequence /
--      p_altitude; writes presence SSOT then mirrors accepted samples into the
--      trip-scoped projection when the driver is assigned to a live trip
--   4. Trip status / unassign / rematch clears the projection immediately
--   5. Realtime publication on trip_driver_live_location (not drivers)
--
-- Location SSOT remains driver_presence → drivers.current_*
-- (migration 20260910120000). This migration does not add a parallel writer
-- for presence — it only extends the existing submit_driver_location_sample.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Drop the unsafe draft policy if it was ever applied.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Passengers can view assigned driver location" ON public.drivers;

-- ---------------------------------------------------------------------------
-- 1. Presence columns for sequence + optional altitude (nullable).
-- ---------------------------------------------------------------------------
ALTER TABLE public.driver_presence
  ADD COLUMN IF NOT EXISTS location_sequence bigint,
  ADD COLUMN IF NOT EXISTS altitude_m double precision;

COMMENT ON COLUMN public.driver_presence.location_sequence IS
  'Monotonic client location sequence for the last ACCEPTED GPS sample. Used to reject stale/out-of-order writes.';
COMMENT ON COLUMN public.driver_presence.altitude_m IS
  'Optional altitude (metres). Nullable — missing altitude must not block a valid sample.';

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS location_sequence bigint;

COMMENT ON COLUMN public.drivers.location_sequence IS
  'Mirror of driver_presence.location_sequence for admin/fleet readers.';

-- ---------------------------------------------------------------------------
-- 2. Live-trackable status helper (must exist before RLS policies).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trip_status_is_live_trackable(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(COALESCE(p_status, '')) IN (
    -- DRIVER_ASSIGNED family
    'accepted',
    'confirmed',
    'driver_assigned',
    'en_route',
    'en_route_to_pickup',
    'enroute_to_pickup',
    'driver_en_route',
    'driver_arriving',
    -- ARRIVED_AT_PICKUP family
    'arrived',
    'arrived_pickup',
    'arrived_at_pickup',
    'at_pickup',
    'pickup_waiting',
    'waiting',
    'waiting_at_pickup',
    'driver_arrived',
    -- IN_PROGRESS family
    'in_progress',
    'on_trip',
    'started',
    'arrived_at_stop',
    'drive_to_next_stop',
    'completing'
  );
$$;

COMMENT ON FUNCTION public.trip_status_is_live_trackable(text) IS
  'True only for DRIVER_ASSIGNED / ARRIVED_AT_PICKUP / IN_PROGRESS (and DB aliases). False for completed, cancelled, no_show, rematch/search.';

CREATE OR REPLACE FUNCTION public.driver_is_assigned_to_live_trip(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.id = p_trip_id
      AND (
        t.driver_id = p_driver_id
        OR t.confirmed_driver_id = p_driver_id
      )
      AND public.trip_status_is_live_trackable(t.status)
  );
$$;

COMMENT ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) IS
  'True when p_driver_id is trips.driver_id or trips.confirmed_driver_id (ONECAB assigned-driver SSOT; there is no assigned_driver_id column) and status is live-trackable.';

-- ---------------------------------------------------------------------------
-- 3. Trip-scoped live location projection (Customer Realtime + restore hydrate).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trip_driver_live_location (
  trip_id uuid PRIMARY KEY REFERENCES public.trips(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  gps_recorded_at timestamptz NOT NULL,
  server_received_at timestamptz NOT NULL DEFAULT now(),
  accuracy_m double precision,
  speed double precision,
  heading double precision,
  altitude_m double precision,
  location_sequence bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.trip_driver_live_location IS
  'Minimum live-location projection for Customer active-trip tracking. No phone, email, documents, or fleet fields.';

CREATE INDEX IF NOT EXISTS idx_trip_driver_live_location_driver
  ON public.trip_driver_live_location (driver_id);

ALTER TABLE public.trip_driver_live_location ENABLE ROW LEVEL SECURITY;

-- Passengers: SELECT only their own trip while it is in a live trackable state
-- and the projected driver_id is still the assigned driver.
DROP POLICY IF EXISTS "Passengers select own live trip driver location"
  ON public.trip_driver_live_location;

CREATE POLICY "Passengers select own live trip driver location"
ON public.trip_driver_live_location
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.trips t
    JOIN public.customers c ON c.id = t.passenger_id
    WHERE t.id = trip_driver_live_location.trip_id
      AND c.user_id = auth.uid()
      AND (
        t.driver_id = trip_driver_live_location.driver_id
        OR t.confirmed_driver_id = trip_driver_live_location.driver_id
      )
      AND public.trip_status_is_live_trackable(t.status)
  )
);

-- Block direct client writes (SECURITY DEFINER RPC bypasses RLS).
DROP POLICY IF EXISTS "No authenticated insert trip driver live location"
  ON public.trip_driver_live_location;
DROP POLICY IF EXISTS "No authenticated update trip driver live location"
  ON public.trip_driver_live_location;
DROP POLICY IF EXISTS "No authenticated delete trip driver live location"
  ON public.trip_driver_live_location;

CREATE POLICY "No authenticated insert trip driver live location"
ON public.trip_driver_live_location FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "No authenticated update trip driver live location"
ON public.trip_driver_live_location FOR UPDATE TO authenticated USING (false);
CREATE POLICY "No authenticated delete trip driver live location"
ON public.trip_driver_live_location FOR DELETE TO authenticated USING (false);

GRANT SELECT ON public.trip_driver_live_location TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Clear projection when trip leaves live tracking / driver unassigned /
--    rematch / reassignment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_trip_driver_live_location_on_trip_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.trip_driver_live_location WHERE trip_id = OLD.id;
    RETURN OLD;
  END IF;

  IF NOT public.trip_status_is_live_trackable(NEW.status)
     OR (NEW.driver_id IS NULL AND NEW.confirmed_driver_id IS NULL)
  THEN
    DELETE FROM public.trip_driver_live_location WHERE trip_id = NEW.id;
    RETURN NEW;
  END IF;

  -- Driver changed (rematch → new assignment): drop old projected row so the
  -- previous driver's last point cannot remain visible.
  IF TG_OP = 'UPDATE'
     AND (
       NEW.driver_id IS DISTINCT FROM OLD.driver_id
       OR NEW.confirmed_driver_id IS DISTINCT FROM OLD.confirmed_driver_id
     )
  THEN
    DELETE FROM public.trip_driver_live_location WHERE trip_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_trip_driver_live_location ON public.trips;
CREATE TRIGGER trg_clear_trip_driver_live_location
  AFTER DELETE OR UPDATE OF status, driver_id, confirmed_driver_id
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_trip_driver_live_location_on_trip_change();

-- ---------------------------------------------------------------------------
-- 5. Extend submit_driver_location_sample (same writer — no parallel path).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_driver_location_sample(
  uuid, double precision, double precision, timestamptz,
  double precision, double precision, double precision, text, text, text
);

CREATE OR REPLACE FUNCTION public.submit_driver_location_sample(
  p_driver_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_gps_recorded_at timestamptz,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_heading double precision DEFAULT NULL::double precision,
  p_speed double precision DEFAULT NULL::double precision,
  p_app_state text DEFAULT NULL::text,
  p_platform text DEFAULT NULL::text,
  p_source text DEFAULT NULL::text,
  p_trip_id uuid DEFAULT NULL::uuid,
  p_location_sequence bigint DEFAULT NULL::bigint,
  p_altitude double precision DEFAULT NULL::double precision
)
RETURNS driver_presence
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prev public.driver_presence%ROWTYPE;
  v_result public.driver_presence;
  v_source text := NULLIF(trim(COALESCE(p_source, '')), '');
  v_is_active_trip boolean := false;
  v_is_background boolean := false;
  v_prev_is_foreground boolean := false;
BEGIN
  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_id required';
  END IF;
  IF p_gps_recorded_at IS NULL THEN
    RAISE EXCEPTION 'gps_recorded_at required';
  END IF;

  v_is_active_trip :=
    v_source IS NOT NULL
    AND lower(v_source) LIKE 'active_trip%';

  IF v_is_active_trip AND p_trip_id IS NULL THEN
    RAISE EXCEPTION 'TRIP_ID_REQUIRED_FOR_ACTIVE_TRIP'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_trip_id IS NOT NULL THEN
    IF NOT public.driver_is_assigned_to_live_trip(p_driver_id, p_trip_id) THEN
      RAISE EXCEPTION 'TRIP_ASSIGNMENT_REJECTED: driver is not assigned to a live trackable trip'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT * INTO v_prev FROM public.driver_presence WHERE driver_id = p_driver_id;

  -- Sequence: reject strictly lower sequences (idempotent on equal + same GPS ts).
  IF p_location_sequence IS NOT NULL
     AND v_prev.location_sequence IS NOT NULL
     AND p_location_sequence < v_prev.location_sequence
  THEN
    RETURN v_prev;
  END IF;

  IF p_location_sequence IS NOT NULL
     AND v_prev.location_sequence IS NOT NULL
     AND p_location_sequence = v_prev.location_sequence
     AND v_prev.last_gps_recorded_at IS NOT NULL
     AND v_prev.last_gps_recorded_at = p_gps_recorded_at
  THEN
    -- Idempotent replay of the same accepted sample.
    RETURN v_prev;
  END IF;

  -- Older GPS sample timestamp must not overwrite a newer accepted sample
  -- (tolerance handled inside upsert_driver_presence; hard reject here when
  -- clearly older with no tolerance for active_trip / sequenced writes).
  IF v_prev.last_gps_recorded_at IS NOT NULL
     AND p_gps_recorded_at < v_prev.last_gps_recorded_at
     AND (
       p_location_sequence IS NULL
       OR v_prev.location_sequence IS NULL
       OR p_location_sequence <= v_prev.location_sequence
     )
  THEN
    RETURN v_prev;
  END IF;

  v_is_background :=
    lower(COALESCE(p_app_state, '')) IN ('background', 'backgrounded')
    OR (v_source IS NOT NULL AND lower(v_source) LIKE '%background%');

  v_prev_is_foreground :=
    lower(COALESCE(v_prev.app_state, '')) IN ('foreground', 'active')
    OR lower(COALESCE(v_prev.location_source, '')) LIKE '%foreground%';

  -- Background samples must not overwrite newer foreground samples.
  IF v_is_background
     AND v_prev_is_foreground
     AND v_prev.last_gps_recorded_at IS NOT NULL
     AND p_gps_recorded_at <= v_prev.last_gps_recorded_at
  THEN
    RETURN v_prev;
  END IF;

  v_result := public.upsert_driver_presence(
    p_driver_id => p_driver_id,
    p_lat => p_lat,
    p_lng => p_lng,
    p_heading => p_heading,
    p_speed => p_speed,
    p_app_state => p_app_state,
    p_platform => p_platform,
    p_accuracy => p_accuracy,
    p_gps_recorded_at => p_gps_recorded_at,
    p_source => p_source
  );

  -- Persist sequence / altitude only when this sample was accepted into presence.
  IF v_result.last_gps_recorded_at IS NOT DISTINCT FROM p_gps_recorded_at THEN
    UPDATE public.driver_presence
    SET
      location_sequence = COALESCE(p_location_sequence, location_sequence),
      altitude_m = COALESCE(p_altitude, altitude_m),
      updated_at = now()
    WHERE driver_id = p_driver_id;

    UPDATE public.drivers
    SET location_sequence = COALESCE(p_location_sequence, location_sequence)
    WHERE id = p_driver_id;

    SELECT * INTO v_result FROM public.driver_presence WHERE driver_id = p_driver_id;

    IF p_trip_id IS NOT NULL THEN
      INSERT INTO public.trip_driver_live_location AS tdll (
        trip_id,
        driver_id,
        latitude,
        longitude,
        gps_recorded_at,
        server_received_at,
        accuracy_m,
        speed,
        heading,
        altitude_m,
        location_sequence,
        updated_at
      ) VALUES (
        p_trip_id,
        p_driver_id,
        p_lat,
        p_lng,
        p_gps_recorded_at,
        now(),
        p_accuracy,
        p_speed,
        p_heading,
        p_altitude,
        p_location_sequence,
        now()
      )
      ON CONFLICT (trip_id) DO UPDATE SET
        driver_id = EXCLUDED.driver_id,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        gps_recorded_at = EXCLUDED.gps_recorded_at,
        server_received_at = EXCLUDED.server_received_at,
        accuracy_m = COALESCE(EXCLUDED.accuracy_m, tdll.accuracy_m),
        speed = COALESCE(EXCLUDED.speed, tdll.speed),
        heading = COALESCE(EXCLUDED.heading, tdll.heading),
        altitude_m = COALESCE(EXCLUDED.altitude_m, tdll.altitude_m),
        location_sequence = COALESCE(EXCLUDED.location_sequence, tdll.location_sequence),
        updated_at = now()
      WHERE
        -- Never let an older projection overwrite a newer one.
        EXCLUDED.gps_recorded_at >= tdll.gps_recorded_at
        AND (
          EXCLUDED.location_sequence IS NULL
          OR tdll.location_sequence IS NULL
          OR EXCLUDED.location_sequence >= tdll.location_sequence
        );
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.submit_driver_location_sample(
  uuid, double precision, double precision, timestamptz,
  double precision, double precision, double precision, text, text, text,
  uuid, bigint, double precision
) IS
  'Genuine GPS sample submission. Optional p_trip_id mirrors into trip_driver_live_location for Customer tracking. p_trip_id required when p_source is active_trip*. Rejects stale sequence / older GPS / BG-over-FG. Heartbeat remains driver_heartbeat_ping (no coords).';

GRANT EXECUTE ON FUNCTION public.submit_driver_location_sample(
  uuid, double precision, double precision, timestamptz,
  double precision, double precision, double precision, text, text, text,
  uuid, bigint, double precision
) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Authoritative one-shot fetch for Customer (min columns).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_trip_driver_live_location(p_trip_id uuid)
RETURNS public.trip_driver_live_location
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
STABLE
AS $$
DECLARE
  v_row public.trip_driver_live_location;
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.trips t
    JOIN public.customers c ON c.id = t.passenger_id
    WHERE t.id = p_trip_id
      AND c.user_id = auth.uid()
      AND public.trip_status_is_live_trackable(t.status)
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT tdll.* INTO v_row
  FROM public.trip_driver_live_location tdll
  JOIN public.trips t ON t.id = tdll.trip_id
  WHERE tdll.trip_id = p_trip_id
    AND (
      t.driver_id = tdll.driver_id
      OR t.confirmed_driver_id = tdll.driver_id
    )
    AND public.trip_status_is_live_trackable(t.status);

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trip_driver_live_location(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Realtime publication — trip projection only (not drivers).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'trip_driver_live_location'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trip_driver_live_location;
  END IF;
END $$;
