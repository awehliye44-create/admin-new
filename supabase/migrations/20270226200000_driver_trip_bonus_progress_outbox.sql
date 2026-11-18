-- Durable, retryable trip-bonus progress after trip completion.
-- Enqueue is transactional with status→completed (trigger) and/or Edge enqueue RPC.
-- Drain does not block completion; record_driver_trip_bonus_progress stays idempotent.
-- NOT applied by this task — ship with Admin release / explicit migration apply.

BEGIN;

CREATE TABLE IF NOT EXISTS public.driver_trip_bonus_progress_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  service_area_id uuid NULL,
  region_id uuid NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text NULL,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz NULL,
  CONSTRAINT driver_trip_bonus_progress_outbox_trip_uidx UNIQUE (trip_id)
);

CREATE INDEX IF NOT EXISTS driver_trip_bonus_progress_outbox_drain_idx
  ON public.driver_trip_bonus_progress_outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.driver_trip_bonus_progress_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.driver_trip_bonus_progress_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.driver_trip_bonus_progress_outbox TO service_role;

-- Enqueue one completed trip for progress (idempotent on trip_id).
CREATE OR REPLACE FUNCTION public.enqueue_driver_trip_bonus_progress(
  p_driver_id uuid,
  p_trip_id uuid,
  p_service_area_id uuid DEFAULT NULL,
  p_region_id uuid DEFAULT NULL,
  p_completed_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RAISE EXCEPTION 'missing_ids';
  END IF;

  INSERT INTO public.driver_trip_bonus_progress_outbox (
    trip_id, driver_id, service_area_id, region_id, completed_at, status, next_attempt_at
  )
  VALUES (
    p_trip_id,
    p_driver_id,
    p_service_area_id,
    p_region_id,
    COALESCE(p_completed_at, now()),
    'pending',
    now()
  )
  ON CONFLICT (trip_id) DO UPDATE
    SET
      -- Refresh geo only while not successfully processed.
      service_area_id = COALESCE(
        EXCLUDED.service_area_id,
        public.driver_trip_bonus_progress_outbox.service_area_id
      ),
      region_id = COALESCE(
        EXCLUDED.region_id,
        public.driver_trip_bonus_progress_outbox.region_id
      ),
      completed_at = COALESCE(
        EXCLUDED.completed_at,
        public.driver_trip_bonus_progress_outbox.completed_at
      ),
      updated_at = now(),
      -- Re-arm dead/failed rows that never reached done (manual/ops recovery).
      status = CASE
        WHEN public.driver_trip_bonus_progress_outbox.status = 'done' THEN 'done'
        WHEN public.driver_trip_bonus_progress_outbox.status = 'processing'
          AND public.driver_trip_bonus_progress_outbox.next_attempt_at > now()
          THEN 'processing'
        ELSE 'pending'
      END,
      next_attempt_at = CASE
        WHEN public.driver_trip_bonus_progress_outbox.status = 'done' THEN
          public.driver_trip_bonus_progress_outbox.next_attempt_at
        ELSE LEAST(public.driver_trip_bonus_progress_outbox.next_attempt_at, now())
      END
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_driver_trip_bonus_progress(uuid, uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_driver_trip_bonus_progress(uuid, uuid, uuid, uuid, timestamptz)
  TO service_role;

-- Drain pending outbox rows: claim → record_driver_trip_bonus_progress → done/backoff.
CREATE OR REPLACE FUNCTION public.drain_driver_trip_bonus_progress_outbox(
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  r record;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 25), 100));
  v_processed integer := 0;
  v_succeeded integer := 0;
  v_failed integer := 0;
  v_result jsonb;
  v_backoff interval;
  v_attempts integer;
BEGIN
  FOR r IN
    SELECT o.*
    FROM public.driver_trip_bonus_progress_outbox o
    WHERE o.status IN ('pending', 'processing')
      AND o.next_attempt_at <= now()
    ORDER BY o.next_attempt_at ASC, o.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT v_limit
  LOOP
    v_processed := v_processed + 1;
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
        -- Trip may still be racing to completed; retry shortly.
        v_backoff := make_interval(secs => LEAST(300, 5 * v_attempts));
        UPDATE public.driver_trip_bonus_progress_outbox
        SET status = 'pending',
            next_attempt_at = now() + v_backoff,
            last_error = left(COALESCE(v_result->>'error', 'trip_not_completed'), 500),
            result = v_result,
            updated_at = now()
        WHERE id = r.id;
        v_failed := v_failed + 1;
      ELSE
        -- Idempotent progress RPC success (including no matching campaigns).
        UPDATE public.driver_trip_bonus_progress_outbox
        SET status = 'done',
            processed_at = now(),
            last_error = NULL,
            result = v_result,
            updated_at = now()
        WHERE id = r.id;
        v_succeeded := v_succeeded + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_backoff := make_interval(secs => LEAST(900, 10 * (2 ^ LEAST(v_attempts, 6))));
      UPDATE public.driver_trip_bonus_progress_outbox
      SET status = CASE WHEN v_attempts >= 12 THEN 'dead' ELSE 'pending' END,
          next_attempt_at = now() + v_backoff,
          last_error = left(SQLERRM, 500),
          updated_at = now()
      WHERE id = r.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'succeeded', v_succeeded,
    'failed', v_failed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.drain_driver_trip_bonus_progress_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drain_driver_trip_bonus_progress_outbox(integer)
  TO service_role;

-- Same-transaction enqueue when a trip becomes completed (Edge cannot drop this).
CREATE OR REPLACE FUNCTION public.trg_enqueue_driver_trip_bonus_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_region uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF NEW.driver_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_region := NEW.region_id;
  IF v_region IS NULL AND NEW.service_area_id IS NOT NULL THEN
    SELECT sa.region_id INTO v_region
    FROM public.service_areas sa
    WHERE sa.id = NEW.service_area_id;
  END IF;

  PERFORM public.enqueue_driver_trip_bonus_progress(
    NEW.driver_id,
    NEW.id,
    NEW.service_area_id,
    v_region,
    COALESCE(NEW.completed_at, now())
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trips_enqueue_trip_bonus_progress ON public.trips;
CREATE TRIGGER trg_trips_enqueue_trip_bonus_progress
  AFTER INSERT OR UPDATE OF status ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_enqueue_driver_trip_bonus_progress();

-- Best-effort drain every minute (does not block trip completion).
CREATE OR REPLACE FUNCTION public.sweep_driver_trip_bonus_progress_outbox()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  PERFORM public.drain_driver_trip_bonus_progress_outbox(50);
END;
$$;

REVOKE ALL ON FUNCTION public.sweep_driver_trip_bonus_progress_outbox() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_driver_trip_bonus_progress_outbox() TO service_role;

DO $schedule$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed - trip-bonus progress outbox sweep skipped';
    RETURN;
  END IF;

  BEGIN
    PERFORM cron.unschedule('driver-trip-bonus-progress-outbox');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM cron.schedule(
    'driver-trip-bonus-progress-outbox',
    '* * * * *',
    'SELECT public.sweep_driver_trip_bonus_progress_outbox();'
  );
END
$schedule$;

COMMIT;
