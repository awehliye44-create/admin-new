-- Rollback trip-bonus campaigns. Does not delete BONUS ledger rows already credited.

BEGIN;

DROP FUNCTION IF EXISTS public.record_driver_trip_bonus_progress(uuid, uuid, uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.admin_save_driver_trip_bonus_campaign(jsonb, uuid[]);

DROP TABLE IF EXISTS public.driver_trip_bonus_campaign_trip_events;
DROP TABLE IF EXISTS public.driver_trip_bonus_campaign_progress;
DROP TABLE IF EXISTS public.driver_trip_bonus_campaign_service_areas;
DROP TABLE IF EXISTS public.driver_trip_bonus_campaigns;

DELETE FROM public.role_page_permissions WHERE page_slug = 'driver-trip-bonuses';

COMMIT;
