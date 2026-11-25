-- Rollback #89 booking financial policy snapshot (columns + version audit).
-- Prefer forward-fix; dropping snapshots does not restore live-buffer re-read defects by itself.

DROP TRIGGER IF EXISTS trg_trips_mirror_booking_financial_policy ON public.trips;
DROP FUNCTION IF EXISTS public.trg_trips_mirror_booking_financial_policy();
DROP TRIGGER IF EXISTS trg_service_area_preauth_settings_version ON public.service_area_preauth_settings;
DROP FUNCTION IF EXISTS public.trg_service_area_preauth_settings_version();
DROP TABLE IF EXISTS public.service_area_financial_policy_versions;
ALTER TABLE public.payment_sessions DROP COLUMN IF EXISTS booking_financial_policy_json;
ALTER TABLE public.trips DROP COLUMN IF EXISTS booking_financial_policy_json;
