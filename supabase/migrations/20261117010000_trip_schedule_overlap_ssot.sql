-- MK-260917-OVERLAP: Canonical Driver+Customer scheduled trip overlap SSOT.
-- OVERLAP BUFFER is independent of scheduled_broadcast_at / scheduled_convert_at.
-- Default buffer: 30 minutes, configurable per service_area.

-- ─── 1. Service-area configuration ───────────────────────────────────────────

ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS scheduled_overlap_buffer_minutes integer;

UPDATE public.service_areas
SET scheduled_overlap_buffer_minutes = 30
WHERE scheduled_overlap_buffer_minutes IS NULL;

ALTER TABLE public.service_areas
  ALTER COLUMN scheduled_overlap_buffer_minutes SET DEFAULT 30;

ALTER TABLE public.service_areas
  ALTER COLUMN scheduled_overlap_buffer_minutes SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'service_areas_scheduled_overlap_buffer_minutes_chk'
  ) THEN
    ALTER TABLE public.service_areas
      ADD CONSTRAINT service_areas_scheduled_overlap_buffer_minutes_chk
      CHECK (scheduled_overlap_buffer_minutes >= 0 AND scheduled_overlap_buffer_minutes <= 240);
  END IF;
END $$;

COMMENT ON COLUMN public.service_areas.scheduled_overlap_buffer_minutes IS
  'Minutes added before scheduled_start and after estimated_end for Driver/Customer overlap protection. Independent of scheduled_broadcast_at / scheduled_convert_at. Default 30.';

-- ─── 2. Resolve buffer (safe fallback) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_scheduled_overlap_buffer_minutes(
  p_service_area_id uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_raw integer;
BEGIN
  IF p_service_area_id IS NULL THEN
    RETURN 30;
  END IF;

  SELECT sa.scheduled_overlap_buffer_minutes
  INTO v_raw
  FROM public.service_areas sa
  WHERE sa.id = p_service_area_id;

  IF NOT FOUND OR v_raw IS NULL OR v_raw < 0 OR v_raw > 240 THEN
    RETURN 30;
  END IF;

  RETURN v_raw;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_scheduled_overlap_buffer_minutes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_scheduled_overlap_buffer_minutes(uuid) TO authenticated, service_role;

-- ─── 3. Canonical conflict evaluator ─────────────────────────────────────────
-- subject_kind: 'driver' | 'customer'
-- candidate_mode: 'scheduled' | 'immediate'
-- Interval math: candidate_start < existing_protected_end
--            AND candidate_end   > existing_protected_start
-- Exact boundary (end == start) is ALLOWED.

CREATE OR REPLACE FUNCTION public.evaluate_trip_schedule_conflict(
  p_subject_kind text,
  p_subject_id uuid,
  p_candidate_start timestamptz,
  p_candidate_estimated_end timestamptz,
  p_service_area_id uuid DEFAULT NULL,
  p_exclude_trip_id uuid DEFAULT NULL,
  p_candidate_mode text DEFAULT 'scheduled'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_kind text := lower(coalesce(p_subject_kind, ''));
  v_mode text := lower(coalesce(p_candidate_mode, 'scheduled'));
  v_buffer integer;
  v_cand_start timestamptz;
  v_cand_end timestamptz;
  v_conflict RECORD;
  v_existing_start timestamptz;
  v_existing_end timestamptz;
BEGIN
  IF v_kind NOT IN ('driver', 'customer') THEN
    RETURN jsonb_build_object(
      'conflict', false,
      'reason', 'INVALID_SUBJECT',
      'conflicting_trip_id', null,
      'protected_start', null,
      'protected_end', null,
      'buffer_minutes', 30,
      'candidate_start', null,
      'candidate_end', null
    );
  END IF;

  IF p_subject_id IS NULL OR p_candidate_start IS NULL OR p_candidate_estimated_end IS NULL THEN
    RETURN jsonb_build_object(
      'conflict', false,
      'reason', 'INVALID_CANDIDATE',
      'conflicting_trip_id', null,
      'protected_start', null,
      'protected_end', null,
      'buffer_minutes', public.resolve_scheduled_overlap_buffer_minutes(p_service_area_id),
      'candidate_start', null,
      'candidate_end', null
    );
  END IF;

  IF p_candidate_estimated_end < p_candidate_start THEN
    RETURN jsonb_build_object(
      'conflict', false,
      'reason', 'INVALID_CANDIDATE_RANGE',
      'conflicting_trip_id', null,
      'protected_start', null,
      'protected_end', null,
      'buffer_minutes', public.resolve_scheduled_overlap_buffer_minutes(p_service_area_id),
      'candidate_start', p_candidate_start,
      'candidate_end', p_candidate_estimated_end
    );
  END IF;

  v_buffer := public.resolve_scheduled_overlap_buffer_minutes(p_service_area_id);

  IF v_mode = 'immediate' THEN
    -- NOW/instant candidate: raw required interval (no extra buffer on candidate).
    v_cand_start := p_candidate_start;
    v_cand_end := p_candidate_estimated_end;
  ELSE
    -- Scheduled candidate: protect both sides with SA buffer.
    v_cand_start := p_candidate_start - make_interval(mins => v_buffer);
    v_cand_end := p_candidate_estimated_end + make_interval(mins => v_buffer);
  END IF;

  FOR v_conflict IN
    SELECT
      t.id,
      t.scheduled_at,
      t.estimated_duration_minutes,
      t.status,
      t.started_at,
      t.arrived_at,
      t.created_at,
      CASE
        WHEN t.scheduled_at IS NOT NULL THEN t.scheduled_at
        ELSE COALESCE(t.started_at, t.arrived_at, t.created_at)
      END AS anchor_at
    FROM public.trips t
    WHERE t.status NOT IN (
      'completed',
      'cancelled',
      'canceled',
      'expired',
      'expired_no_driver',
      'no_show',
      'failed',
      'discarded'
    )
      AND (p_exclude_trip_id IS NULL OR t.id <> p_exclude_trip_id)
      AND (
        (v_kind = 'driver' AND (
          t.confirmed_driver_id = p_subject_id OR t.driver_id = p_subject_id
        ))
        OR
        (v_kind = 'customer' AND t.passenger_id = p_subject_id)
      )
      AND (
        -- Scheduled candidate: any owned non-terminal trip with a time anchor.
        -- Immediate candidate: only upcoming scheduled commitments (protected window).
        v_mode <> 'immediate'
        OR t.scheduled_at IS NOT NULL
      )
    ORDER BY COALESCE(t.scheduled_at, t.started_at, t.created_at) ASC NULLS LAST
  LOOP
    IF v_conflict.anchor_at IS NULL THEN
      CONTINUE;
    END IF;

    IF v_conflict.scheduled_at IS NOT NULL THEN
      v_existing_start := v_conflict.scheduled_at - make_interval(mins => v_buffer);
      v_existing_end :=
        v_conflict.scheduled_at
        + make_interval(mins => GREATEST(1, COALESCE(v_conflict.estimated_duration_minutes, 30)))
        + make_interval(mins => v_buffer);
    ELSE
      -- Live NOW trip: raw required interval (no extra buffer on existing NOW).
      v_existing_start := v_conflict.anchor_at;
      v_existing_end :=
        v_conflict.anchor_at
        + make_interval(mins => GREATEST(1, COALESCE(v_conflict.estimated_duration_minutes, 30)));
    END IF;

    IF v_cand_start < v_existing_end AND v_cand_end > v_existing_start THEN
      RETURN jsonb_build_object(
        'conflict', true,
        'has_conflict', true,
        'reason', 'SCHEDULED_TRIP_OVERLAP',
        'conflicting_trip_id', v_conflict.id,
        'protected_start', v_existing_start,
        'protected_end', v_existing_end,
        'buffer_minutes', v_buffer,
        'candidate_start', v_cand_start,
        'candidate_end', v_cand_end
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'conflict', false,
    'has_conflict', false,
    'reason', null,
    'conflicting_trip_id', null,
    'protected_start', null,
    'protected_end', null,
    'buffer_minutes', v_buffer,
    'candidate_start', v_cand_start,
    'candidate_end', v_cand_end
  );
END;
$$;

COMMENT ON FUNCTION public.evaluate_trip_schedule_conflict(text, uuid, timestamptz, timestamptz, uuid, uuid, text) IS
  'Canonical Driver/Customer trip schedule overlap evaluator. Buffer from service_areas.scheduled_overlap_buffer_minutes (default 30). Exact boundary allowed.';

REVOKE ALL ON FUNCTION public.evaluate_trip_schedule_conflict(text, uuid, timestamptz, timestamptz, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_trip_schedule_conflict(text, uuid, timestamptz, timestamptz, uuid, uuid, text) TO authenticated, service_role;

-- Convenience: compute estimated end from start + duration minutes.
CREATE OR REPLACE FUNCTION public.trip_schedule_estimated_end(
  p_start timestamptz,
  p_estimated_duration_minutes integer
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_start + make_interval(mins => GREATEST(1, COALESCE(p_estimated_duration_minutes, 30)));
$$;

GRANT EXECUTE ON FUNCTION public.trip_schedule_estimated_end(timestamptz, integer) TO authenticated, service_role;

-- ─── 4. Legacy check_schedule_overlap → delegate to canonical evaluator ──────

CREATE OR REPLACE FUNCTION public.check_schedule_overlap(p_driver_id uuid, p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_trip RECORD;
  v_end timestamptz;
  v_eval jsonb;
BEGIN
  SELECT
    t.id,
    t.scheduled_at,
    COALESCE(t.estimated_duration_minutes, 30) AS estimated_duration_minutes,
    t.service_area_id
  INTO v_trip
  FROM public.trips t
  WHERE t.id = p_trip_id;

  IF NOT FOUND OR v_trip.scheduled_at IS NULL THEN
    RETURN jsonb_build_object('has_conflict', false, 'conflict', false);
  END IF;

  v_end := public.trip_schedule_estimated_end(
    v_trip.scheduled_at,
    v_trip.estimated_duration_minutes
  );

  v_eval := public.evaluate_trip_schedule_conflict(
    'driver',
    p_driver_id,
    v_trip.scheduled_at,
    v_end,
    v_trip.service_area_id,
    p_trip_id,
    'scheduled'
  );

  IF COALESCE((v_eval->>'conflict')::boolean, false) THEN
    RETURN jsonb_build_object(
      'has_conflict', true,
      'conflict', true,
      'conflicting_trip_id', v_eval->>'conflicting_trip_id',
      'conflicting_time', v_eval->>'protected_start',
      'reason', v_eval->>'reason',
      'buffer_minutes', (v_eval->>'buffer_minutes')::integer
    );
  END IF;

  RETURN jsonb_build_object('has_conflict', false, 'conflict', false);
END;
$$;

-- Keep EXECUTE locked to postgres for the legacy name (apps use evaluate_*).
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM service_role;

-- ─── 5. accept_scheduled_ride — atomic overlap gate + driver lock ────────────

CREATE OR REPLACE FUNCTION public.accept_scheduled_ride(p_trip_id uuid, p_driver_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_auth_driver uuid := public.current_driver_id();
  v_driver_id uuid;
  v_trip RECORD;
  v_locked boolean;
  v_sa uuid;
  v_end timestamptz;
  v_eval jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED', 'message', 'Sign in required');
  END IF;

  IF v_auth_driver IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_NOT_FOUND', 'message', 'Driver profile not linked');
  END IF;

  v_driver_id := v_auth_driver;
  IF p_driver_id IS NOT NULL AND p_driver_id <> v_auth_driver THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Cannot accept for another driver');
  END IF;

  -- Driver-scoped lock serialises concurrent accepts for the same driver
  -- (prevents racing two overlapping scheduled jobs through acceptance).
  PERFORM pg_advisory_xact_lock(hashtext('driver_sched_accept:' || v_driver_id::text));

  v_locked := pg_try_advisory_xact_lock(hashtext(p_trip_id::text));
  IF NOT v_locked THEN
    RETURN jsonb_build_object('success', false, 'error', 'LOCK_CONTENTION', 'message', 'Another driver is accepting this ride');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_ALREADY_TAKEN', 'message', 'This ride has already been taken by another driver');
  END IF;

  IF v_trip.confirmed_driver_id IS NOT NULL AND v_trip.confirmed_driver_id <> v_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_ALREADY_TAKEN', 'message', 'Another driver has already reserved this ride');
  END IF;

  IF public.driver_is_excluded_from_trip(p_trip_id, v_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DRIVER_EXCLUDED',
      'message', 'Driver is excluded from this trip'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.scheduled_offer_attempts
    WHERE trip_id = p_trip_id
      AND driver_id = v_driver_id
      AND status IN ('declined', 'timeout', 'cancelled')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_EXCLUDED', 'message', 'You previously declined or timed out on this ride');
  END IF;

  IF NOT public.scheduled_marketplace_is_open(
    v_trip.dispatch_mode,
    v_trip.scheduled_status,
    v_trip.status,
    v_trip.scheduled_at,
    v_trip.scheduled_broadcast_at,
    v_trip.created_at,
    v_trip.driver_id,
    v_trip.confirmed_driver_id,
    now()
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'This job is no longer available');
  END IF;

  SELECT d.service_area_id INTO v_sa FROM public.drivers d WHERE d.id = v_driver_id;
  IF v_trip.service_area_id IS NOT NULL
     AND v_trip.service_area_id IS DISTINCT FROM v_sa
     AND NOT EXISTS (
       SELECT 1 FROM public.driver_service_areas dsa
       WHERE dsa.driver_id = v_driver_id AND dsa.service_area_id = v_trip.service_area_id
     )
  THEN
    RETURN jsonb_build_object('success', false, 'error', 'SERVICE_AREA', 'message', 'This job is outside your service area');
  END IF;

  -- Canonical overlap gate (scheduled ↔ scheduled / live).
  IF v_trip.scheduled_at IS NOT NULL THEN
    v_end := public.trip_schedule_estimated_end(
      v_trip.scheduled_at,
      COALESCE(v_trip.estimated_duration_minutes, 30)
    );
    v_eval := public.evaluate_trip_schedule_conflict(
      'driver',
      v_driver_id,
      v_trip.scheduled_at,
      v_end,
      COALESCE(v_trip.service_area_id, v_sa),
      p_trip_id,
      'scheduled'
    );
    IF COALESCE((v_eval->>'conflict')::boolean, false) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'SCHEDULED_TRIP_OVERLAP',
        'message', 'You already have a booking that conflicts with this time.',
        'conflicting_trip_id', v_eval->>'conflicting_trip_id',
        'buffer_minutes', (v_eval->>'buffer_minutes')::integer
      );
    END IF;
  END IF;

  UPDATE public.trips
  SET
    confirmed_driver_id = v_driver_id,
    status = 'accepted',
    scheduled_status = 'driver_assigned',
    scheduled_accepted_at = now(),
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    updated_at = now()
  WHERE id = p_trip_id;

  INSERT INTO public.scheduled_offer_attempts
    (trip_id, driver_id, status, responded_at, response_time_seconds)
  VALUES
    (p_trip_id, v_driver_id, 'accepted', now(), 0)
  ON CONFLICT (trip_id, driver_id, broadcast_round)
  DO UPDATE SET status = 'accepted', responded_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'message', 'Scheduled ride reserved successfully'
  );
END;
$$;

-- ─── 6. Helpful index for subject lookups ────────────────────────────────────

CREATE INDEX IF NOT EXISTS trips_driver_schedule_overlap_idx
  ON public.trips (confirmed_driver_id, scheduled_at)
  WHERE scheduled_at IS NOT NULL
    AND status NOT IN (
      'completed',
      'cancelled',
      'canceled',
      'expired',
      'expired_no_driver',
      'no_show'
    );

CREATE INDEX IF NOT EXISTS trips_passenger_schedule_overlap_idx
  ON public.trips (passenger_id, scheduled_at)
  WHERE scheduled_at IS NOT NULL
    AND status NOT IN (
      'completed',
      'cancelled',
      'canceled',
      'expired',
      'expired_no_driver',
      'no_show'
    );

-- ─── 7. INSERT race guard (customer scheduled) ───────────────────────────────
-- Edge create-trip-after-payment re-checks via RPC; this trigger closes the
-- concurrent double-book race inside the insert transaction.

CREATE OR REPLACE FUNCTION public.trips_enforce_customer_schedule_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_end timestamptz;
  v_eval jsonb;
BEGIN
  IF NEW.scheduled_at IS NULL OR NEW.passenger_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN (
    'completed', 'cancelled', 'canceled', 'expired',
    'expired_no_driver', 'no_show', 'failed', 'discarded'
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cust_sched_book:' || NEW.passenger_id::text));

  v_end := public.trip_schedule_estimated_end(
    NEW.scheduled_at,
    COALESCE(NEW.estimated_duration_minutes, 30)
  );

  v_eval := public.evaluate_trip_schedule_conflict(
    'customer',
    NEW.passenger_id,
    NEW.scheduled_at,
    v_end,
    NEW.service_area_id,
    NEW.id,
    'scheduled'
  );

  IF COALESCE((v_eval->>'conflict')::boolean, false) THEN
    RAISE EXCEPTION 'SCHEDULED_TRIP_OVERLAP'
      USING ERRCODE = 'P0001',
            DETAIL = coalesce(v_eval->>'conflicting_trip_id', ''),
            HINT = 'You already have a booking that conflicts with this time. Please choose another time.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trips_enforce_customer_schedule_overlap_trg ON public.trips;
CREATE TRIGGER trips_enforce_customer_schedule_overlap_trg
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_enforce_customer_schedule_overlap();

