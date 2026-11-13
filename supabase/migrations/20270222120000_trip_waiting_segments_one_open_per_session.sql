-- ============================================================================
-- trip_waiting_segments — database-enforced "at most ONE open segment per
-- authoritative waiting session".
--
-- Problem
--   syncWaitingGeofenceClock did SELECT-open-rows then INSERT with no lock, so
--   concurrent STEP 1y / location / waiting ticks each saw "no open row" and each
--   inserted one (4 parallel openers => 4 open rows). The single-open invariant
--   only held after the NEXT sync healed the extras (planOpenWaitingSegments).
--
-- Authoritative waiting session identity (matches the Edge open query):
--   pickup : (trip_id, 'pickup')                 — stop_id is never part of pickup
--   stop   : (trip_id, 'stop', stop_id)          — one clock per intermediate stop
--   Pickup and every intermediate stop therefore keep SEPARATE sessions.
--
-- This migration
--   1. Unique PARTIAL index: one open (ended_at IS NULL) row per session.
--   2. public.open_waiting_segment_or_reuse(...) — atomic insert-on-conflict that
--      REUSES the existing open row instead of failing; service_role only.
--
-- Safety
--   * No historical row is rewritten. A read-only scan of the linked project
--     found 0 duplicate open sessions, so the index builds without remediation.
--     If duplicates ever exist the migration ABORTS (it never auto-closes rows,
--     which would change counted seconds / fees / no-show qualification).
--   * Heal (planOpenWaitingSegments / closeAllOpenWaitingSegmentsForTrip) stays as
--     defensive recovery only.
--   * Not a Revolut / payment change.
-- ============================================================================

BEGIN;

DO $guard$
DECLARE
  v_dups bigint;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT 1
      FROM public.trip_waiting_segments
     WHERE ended_at IS NULL
     GROUP BY trip_id, location_type,
              CASE WHEN location_type = 'stop'
                   THEN COALESCE(stop_id, '00000000-0000-0000-0000-000000000000'::uuid)
                   ELSE '00000000-0000-0000-0000-000000000000'::uuid END
    HAVING count(*) > 1
  ) q;
  IF v_dups > 0 THEN
    RAISE EXCEPTION
      'trip_waiting_segments: % waiting session(s) already have more than one OPEN segment. '
      'Heal them via planOpenWaitingSegments (keep earliest, close extras) BEFORE applying this migration; '
      'this migration never rewrites segment history.', v_dups;
  END IF;
END
$guard$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_waiting_segments_one_open_per_session
  ON public.trip_waiting_segments (
    trip_id,
    location_type,
    (CASE WHEN location_type = 'stop'
          THEN COALESCE(stop_id, '00000000-0000-0000-0000-000000000000'::uuid)
          ELSE '00000000-0000-0000-0000-000000000000'::uuid END)
  )
  WHERE ended_at IS NULL;

COMMENT ON INDEX public.uq_trip_waiting_segments_one_open_per_session IS
  'At most one OPEN waiting segment per session: pickup = (trip), stop = (trip, stop_id). Concurrent opens reuse via open_waiting_segment_or_reuse().';

-- Atomic open-or-reuse. Returns the open segment id and whether this call created it.
CREATE OR REPLACE FUNCTION public.open_waiting_segment_or_reuse(
  p_trip_id uuid,
  p_location_type text,
  p_stop_id uuid DEFAULT NULL,
  p_stop_index integer DEFAULT NULL,
  p_started_at timestamptz DEFAULT now(),
  p_distance_meters double precision DEFAULT NULL,
  p_source_location text DEFAULT NULL
)
RETURNS TABLE (segment_id uuid, opened boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_stop_id uuid;
  v_id uuid;
  v_attempt integer := 0;
BEGIN
  IF p_location_type NOT IN ('pickup', 'stop') THEN
    RAISE EXCEPTION 'invalid location_type %', p_location_type USING ERRCODE = '22023';
  END IF;

  -- Pickup never carries a stop identity (session = trip); stop sessions are per stop.
  v_stop_id := CASE WHEN p_location_type = 'stop' THEN p_stop_id ELSE NULL END;

  LOOP
    v_attempt := v_attempt + 1;

    INSERT INTO public.trip_waiting_segments (
      trip_id, location_type, stop_id, stop_index, started_at, ended_at,
      inside_radius, distance_meters, source_location
    )
    VALUES (
      p_trip_id, p_location_type, v_stop_id, p_stop_index, p_started_at, NULL,
      true, p_distance_meters, p_source_location
    )
    ON CONFLICT (
      trip_id,
      location_type,
      (CASE WHEN location_type = 'stop'
            THEN COALESCE(stop_id, '00000000-0000-0000-0000-000000000000'::uuid)
            ELSE '00000000-0000-0000-0000-000000000000'::uuid END)
    ) WHERE ended_at IS NULL
    DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, true;
      RETURN;
    END IF;

    -- Conflict: the winner's row is committed by now (ON CONFLICT waited on it).
    SELECT s.id INTO v_id
      FROM public.trip_waiting_segments s
     WHERE s.trip_id = p_trip_id
       AND s.location_type = p_location_type
       AND s.ended_at IS NULL
       AND (p_location_type <> 'stop' OR s.stop_id IS NOT DISTINCT FROM v_stop_id)
     ORDER BY s.started_at ASC, s.id ASC
     LIMIT 1;

    IF v_id IS NOT NULL THEN
      RETURN QUERY SELECT v_id, false;
      RETURN;
    END IF;

    -- The conflicting row was closed between INSERT and SELECT: try again (bounded).
    IF v_attempt >= 3 THEN
      RAISE EXCEPTION 'open_waiting_segment_or_reuse: could not open or reuse segment for trip %', p_trip_id
        USING ERRCODE = '40001';
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.open_waiting_segment_or_reuse(uuid, text, uuid, integer, timestamptz, double precision, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.open_waiting_segment_or_reuse(uuid, text, uuid, integer, timestamptz, double precision, text) FROM anon;
REVOKE ALL ON FUNCTION public.open_waiting_segment_or_reuse(uuid, text, uuid, integer, timestamptz, double precision, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.open_waiting_segment_or_reuse(uuid, text, uuid, integer, timestamptz, double precision, text) TO service_role;

COMMENT ON FUNCTION public.open_waiting_segment_or_reuse(uuid, text, uuid, integer, timestamptz, double precision, text) IS
  'Atomic waiting-segment open: INSERT ... ON CONFLICT DO NOTHING on the one-open-per-session unique index, else reuse the existing open row. Never creates a second open segment.';

COMMIT;
