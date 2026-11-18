-- Rollback durable trip-bonus progress outbox.

BEGIN;

DO $schedule$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    PERFORM cron.unschedule('driver-trip-bonus-progress-outbox');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END
$schedule$;

DROP TRIGGER IF EXISTS trg_trips_enqueue_trip_bonus_progress ON public.trips;
DROP FUNCTION IF EXISTS public.trg_enqueue_driver_trip_bonus_progress();
DROP FUNCTION IF EXISTS public.sweep_driver_trip_bonus_progress_outbox();
DROP FUNCTION IF EXISTS public.drain_driver_trip_bonus_progress_outbox(integer);
DROP FUNCTION IF EXISTS public.enqueue_driver_trip_bonus_progress(uuid, uuid, uuid, uuid, timestamptz);
DROP TABLE IF EXISTS public.driver_trip_bonus_progress_outbox;

COMMIT;
