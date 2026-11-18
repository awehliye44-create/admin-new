-- Rollback publish overlap helpers. Restores admin_save without overlap guard
-- from 20270226180000 (caller must re-apply that body if needed).

BEGIN;

DROP FUNCTION IF EXISTS public.driver_trip_bonus_campaign_scopes_overlap(text, uuid, uuid[], text, uuid, uuid[]);
DROP FUNCTION IF EXISTS public.driver_trip_bonus_campaign_windows_overlap(timestamptz, timestamptz, timestamptz, timestamptz);

-- Note: admin_save_driver_trip_bonus_campaign is left as last applied definition.
-- Re-run 20270226180000 save-function section to restore pre-overlap behaviour.

COMMIT;
