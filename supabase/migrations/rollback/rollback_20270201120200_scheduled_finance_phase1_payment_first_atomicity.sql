-- Rollback for 20270201120200 (explicit approval only).
-- Safe default: restore Assign Now / schedule-mod objects WITHOUT dropping the
-- payment-first INSERT trigger (dropping it can re-enable unpaid platform card
-- trip inserts if any legacy pending_payment client is still live).
--
-- Optional: to also drop payment-first, run
--   rollback_20270201120200_drop_payment_first_OPTIONAL.sql
-- AFTER hub/Admin clients no longer insert unpaid card trips.
--
-- Sequencing with Edge/clients: see docs/SCHEDULED_FINANCE_PHASE1_DEPLOY_ROLLBACK.md

BEGIN;

DROP TRIGGER IF EXISTS trg_trips_enforce_scheduled_modification_coverage ON public.trips;
DROP FUNCTION IF EXISTS public.trips_enforce_scheduled_modification_coverage();

DROP FUNCTION IF EXISTS public.admin_assign_scheduled_driver(uuid, uuid);

-- Keep capture_deadline_observed_at (additive, backward-compatible).

COMMIT;
