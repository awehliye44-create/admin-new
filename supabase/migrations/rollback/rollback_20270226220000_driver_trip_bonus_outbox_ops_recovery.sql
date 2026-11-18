BEGIN;

DROP FUNCTION IF EXISTS public.admin_reenqueue_dead_driver_trip_bonus_progress_outbox(uuid[]);
DROP FUNCTION IF EXISTS public.admin_list_dead_driver_trip_bonus_progress_outbox();
DROP FUNCTION IF EXISTS public.process_driver_trip_bonus_progress_outbox_trip(uuid);

COMMIT;
