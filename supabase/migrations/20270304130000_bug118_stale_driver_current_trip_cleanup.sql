-- #118 — Stale drivers.current_trip_id after terminal trip must not block dispatch.
--
-- Root cause (MK-261126-006/007 → MK0007/MK0006): stop-workflow cleared
-- current_trip_id only in complete_trip_p2 background work after tip/payment.
-- #113 ReferenceError aborted before that task was scheduled; trip was already
-- completed. Dispatch then hard-excluded drivers (stacked_active_count_invalid).
--
-- SSOT: CAS-clear on terminal trip write (trigger) + service_role reconcile RPC.
-- Never clear a newer assignment (WHERE current_trip_id = NEW.id).
-- Stacked completion with a queued child keeps the pointer for promote_stacked_trip.

CREATE OR REPLACE FUNCTION public.clear_driver_current_trip_if_matches(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_updated int := 0;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.drivers
  SET current_trip_id = NULL,
      updated_at = now()
  WHERE id = p_driver_id
    AND current_trip_id = p_trip_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.clear_driver_current_trip_if_matches(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_driver_current_trip_if_matches(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.clear_driver_current_trip_if_matches(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.clear_driver_current_trip_if_matches(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trips_clear_driver_current_trip_on_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_has_queued boolean := false;
  v_new_terminal boolean;
  v_old_terminal boolean;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  v_new_terminal := lower(COALESCE(NEW.status, '')) IN (
    'completed', 'cancelled', 'no_show', 'expired', 'customer_cancelled'
  );
  v_old_terminal := lower(COALESCE(OLD.status, '')) IN (
    'completed', 'cancelled', 'no_show', 'expired', 'customer_cancelled'
  );

  IF NOT v_new_terminal OR v_old_terminal THEN
    RETURN NEW;
  END IF;

  -- Stacked handoff: leave pointer for promote_stacked_trip when a queued child exists.
  IF lower(COALESCE(NEW.status, '')) = 'completed' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.trips q
      WHERE q.status = 'queued'
        AND (
          q.driver_id IN (NEW.driver_id, NEW.confirmed_driver_id)
          OR q.confirmed_driver_id IN (NEW.driver_id, NEW.confirmed_driver_id)
          OR q.id = NEW.stacked_trip_id
          OR q.stacked_trip_id = NEW.id
        )
    ) INTO v_has_queued;
    IF v_has_queued THEN
      RETURN NEW;
    END IF;
  END IF;

  BEGIN
    IF NEW.driver_id IS NOT NULL THEN
      PERFORM public.clear_driver_current_trip_if_matches(NEW.driver_id, NEW.id);
    END IF;
    IF NEW.confirmed_driver_id IS NOT NULL
       AND NEW.confirmed_driver_id IS DISTINCT FROM NEW.driver_id THEN
      PERFORM public.clear_driver_current_trip_if_matches(NEW.confirmed_driver_id, NEW.id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block terminal trip writes on cleanup.
    RAISE WARNING 'trips_clear_driver_current_trip_on_terminal failed for %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trips_clear_driver_current_trip_on_terminal ON public.trips;
CREATE TRIGGER trg_trips_clear_driver_current_trip_on_terminal
  AFTER UPDATE OF status, completed_at, cancelled_at
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_clear_driver_current_trip_on_terminal();

-- Bounded fleet heal: terminal/missing pointer, zero live active, zero queued.
CREATE OR REPLACE FUNCTION public.reconcile_stale_driver_current_trip(
  p_driver_id uuid DEFAULT NULL,
  p_limit int DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_limit int := GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
  v_cleared int := 0;
  v_row record;
  v_results jsonb := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT d.id AS driver_id,
           d.driver_code,
           d.current_trip_id AS trip_id,
           t.trip_number,
           t.status AS trip_status
    FROM public.drivers d
    LEFT JOIN public.trips t ON t.id = d.current_trip_id
    WHERE d.deleted_at IS NULL
      AND d.current_trip_id IS NOT NULL
      AND (p_driver_id IS NULL OR d.id = p_driver_id)
      AND (
        t.id IS NULL
        OR lower(COALESCE(t.status, '')) IN (
          'completed', 'cancelled', 'no_show', 'expired', 'customer_cancelled'
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.trips live
        WHERE live.driver_id = d.id
          AND lower(COALESCE(live.status, '')) NOT IN (
            'completed', 'cancelled', 'no_show', 'expired', 'customer_cancelled', 'queued'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.trips q
        WHERE q.status = 'queued'
          AND (q.driver_id = d.id OR q.confirmed_driver_id = d.id)
      )
    ORDER BY d.updated_at ASC NULLS LAST
    LIMIT v_limit
  LOOP
    IF public.clear_driver_current_trip_if_matches(v_row.driver_id, v_row.trip_id) THEN
      v_cleared := v_cleared + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'driver_id', v_row.driver_id,
        'driver_code', v_row.driver_code,
        'trip_id', v_row.trip_id,
        'trip_number', v_row.trip_number,
        'trip_status', v_row.trip_status,
        'event', 'STALE_CURRENT_TRIP_CLEARED'
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'cleared_count', v_cleared,
    'cleared', v_results
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_stale_driver_current_trip(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_stale_driver_current_trip(uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_stale_driver_current_trip(uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_driver_current_trip(uuid, int) TO service_role;

COMMENT ON FUNCTION public.reconcile_stale_driver_current_trip(uuid, int) IS
  '#118 CAS heal for drivers.current_trip_id pointing at terminal/missing trips with no live active/queued work.';

-- Heal before/alongside marketplace dispatch when a new search starts.
CREATE OR REPLACE FUNCTION public.trips_reconcile_stale_current_trip_on_search()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT'
     AND lower(COALESCE(NEW.status, '')) IN ('searching', 'pending', 'searching_new_driver')
  THEN
    BEGIN
      PERFORM public.reconcile_stale_driver_current_trip(NULL, 50);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'trips_reconcile_stale_current_trip_on_search failed: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trips_reconcile_stale_current_trip_on_search ON public.trips;
CREATE TRIGGER trg_trips_reconcile_stale_current_trip_on_search
  AFTER INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_reconcile_stale_current_trip_on_search();
