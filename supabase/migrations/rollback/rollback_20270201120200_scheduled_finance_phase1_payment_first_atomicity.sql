-- Rollback for 20270201120200 (run only with explicit approval).
BEGIN;

DROP TRIGGER IF EXISTS trg_trips_enforce_scheduled_modification_coverage ON public.trips;
DROP FUNCTION IF EXISTS public.trips_enforce_scheduled_modification_coverage();

DROP TRIGGER IF EXISTS trg_trips_enforce_payment_first_platform_card ON public.trips;
DROP FUNCTION IF EXISTS public.trips_enforce_payment_first_platform_card();

DROP FUNCTION IF EXISTS public.admin_assign_scheduled_driver(uuid, uuid);

-- Keep capture_deadline_observed_at column (backward-compatible); drop only if required:
-- ALTER TABLE public.payment_sessions DROP COLUMN IF EXISTS capture_deadline_observed_at;

COMMIT;
