-- Rollback for 20261216180000_sync_driver_profile_full_name.sql
-- Removes the sync only; profile names already synced are left as they are.

DROP TRIGGER IF EXISTS trg_sync_driver_profile_full_name ON public.drivers;
DROP FUNCTION IF EXISTS public.sync_driver_profile_full_name();
