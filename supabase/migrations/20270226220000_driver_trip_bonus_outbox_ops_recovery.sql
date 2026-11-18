-- Trip-bonus outbox: single-trip process helper + Admin dead-letter list/re-enqueue.
-- Retries remain idempotent via record_driver_trip_bonus_progress (trip_events + credited claim).
-- NOT applied by this task — ship with Admin release / explicit migration apply.

BEGIN;

-- Process one outbox trip immediately (Edge acceleration). Safe under retries.
CREATE OR REPLACE FUNCTION public.process_driver_trip_bonus_progress_outbox_trip(
  p_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  r public.driver_trip_bonus_progress_outbox%ROWTYPE;
  v_result jsonb;
  v_attempts integer;
  v_backoff interval;
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_trip_id');
  END IF;

  SELECT * INTO r
  FROM public.driver_trip_bonus_progress_outbox
  WHERE trip_id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'outbox_missing');
  END IF;

  IF r.status = 'done' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'done', 'result', r.result);
  END IF;

  v_attempts := r.attempt_count + 1;
  UPDATE public.driver_trip_bonus_progress_outbox
  SET status = 'processing',
      attempt_count = v_attempts,
      updated_at = now()
  WHERE id = r.id;

  BEGIN
    v_result := public.record_driver_trip_bonus_progress(
      r.driver_id,
      r.trip_id,
      r.service_area_id,
      r.region_id,
      r.completed_at
    );

    IF COALESCE((v_result->>'ok')::boolean, false) = false
       AND COALESCE(v_result->>'error', '') = 'trip_not_completed'
    THEN
      v_backoff := make_interval(secs => LEAST(300, 5 * v_attempts));
      UPDATE public.driver_trip_bonus_progress_outbox
      SET status = 'pending',
          next_attempt_at = now() + v_backoff,
          last_error = left(COALESCE(v_result->>'error', 'trip_not_completed'), 500),
          result = v_result,
          updated_at = now()
      WHERE id = r.id;
      RETURN jsonb_build_object('ok', false, 'status', 'pending', 'error', 'trip_not_completed', 'result', v_result);
    END IF;

    UPDATE public.driver_trip_bonus_progress_outbox
    SET status = 'done',
        processed_at = now(),
        last_error = NULL,
        result = v_result,
        updated_at = now()
    WHERE id = r.id;

    RETURN jsonb_build_object('ok', true, 'status', 'done', 'result', v_result);
  EXCEPTION WHEN OTHERS THEN
    v_backoff := make_interval(secs => LEAST(900, 10 * (2 ^ LEAST(v_attempts, 6))));
    UPDATE public.driver_trip_bonus_progress_outbox
    SET status = CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
        next_attempt_at = now() + v_backoff,
        last_error = left(SQLERRM, 500),
        updated_at = now()
    WHERE id = r.id;
    RETURN jsonb_build_object(
      'ok', false,
      'status', CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
      'error', SQLERRM
    );
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.process_driver_trip_bonus_progress_outbox_trip(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_driver_trip_bonus_progress_outbox_trip(uuid)
  TO service_role;

-- Staff: list dead outbox rows (visible ops alert).
CREATE OR REPLACE FUNCTION public.admin_list_dead_driver_trip_bonus_progress_outbox()
RETURNS TABLE (
  id uuid,
  trip_id uuid,
  driver_id uuid,
  service_area_id uuid,
  region_id uuid,
  completed_at timestamptz,
  attempt_count integer,
  last_error text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
       public.is_super_admin(v_uid)
       OR public.staff_has_page_access('driver-trip-bonuses')
     )
  THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    o.id,
    o.trip_id,
    o.driver_id,
    o.service_area_id,
    o.region_id,
    o.completed_at,
    o.attempt_count,
    o.last_error,
    o.created_at,
    o.updated_at
  FROM public.driver_trip_bonus_progress_outbox o
  WHERE o.status = 'dead'
  ORDER BY o.updated_at DESC
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_dead_driver_trip_bonus_progress_outbox()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_dead_driver_trip_bonus_progress_outbox()
  TO authenticated;

-- Staff: safe re-enqueue (reset dead → pending). Progress RPC stays idempotent.
CREATE OR REPLACE FUNCTION public.admin_reenqueue_dead_driver_trip_bonus_progress_outbox(
  p_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.is_super_admin(v_uid)
       OR public.staff_has_page_access('driver-trip-bonuses')
     )
  THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  UPDATE public.driver_trip_bonus_progress_outbox o
  SET status = 'pending',
      attempt_count = 0,
      next_attempt_at = now(),
      last_error = NULL,
      updated_at = now()
  WHERE o.status = 'dead'
    AND (p_ids IS NULL OR o.id = ANY (p_ids));

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Kick drain immediately for ops responsiveness (still non-blocking for trips).
  PERFORM public.drain_driver_trip_bonus_progress_outbox(50);

  RETURN jsonb_build_object('ok', true, 'requeued', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reenqueue_dead_driver_trip_bonus_progress_outbox(uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reenqueue_dead_driver_trip_bonus_progress_outbox(uuid[])
  TO authenticated;

COMMIT;
