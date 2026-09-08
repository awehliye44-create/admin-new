-- Rollback the PLATFORM_COLLECTED cash insert guard.
-- Restores the previous absence of this function and its triggers.
-- Does not rewrite historical cash trips. Does not restore a writer.

BEGIN;

DROP TRIGGER IF EXISTS trg_01_reject_platform_collected_operational_cash ON public.trips;
DROP TRIGGER IF EXISTS trg_reject_platform_collected_operational_cash_upd ON public.trips;
DROP FUNCTION IF EXISTS public.reject_platform_collected_operational_cash();

COMMIT;
