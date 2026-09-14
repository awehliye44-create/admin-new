-- A8B28F Stage A rollback — DRAFT / NOT APPLIED
BEGIN;

DROP FUNCTION IF EXISTS public.admin_set_driver_payout_operational_pause(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.driver_effective_payout_allowed(uuid);
DROP FUNCTION IF EXISTS public.driver_has_provider_verified_payout_destination(uuid);

ALTER TABLE public.drivers
  DROP COLUMN IF EXISTS payout_operational_paused;

COMMIT;
