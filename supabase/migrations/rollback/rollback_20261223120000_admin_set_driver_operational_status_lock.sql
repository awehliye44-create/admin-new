-- Rollback admin_set_driver_operational_status (restore prior status-enforce body without intent clear).

BEGIN;

DROP FUNCTION IF EXISTS public.admin_set_driver_operational_status(uuid, public.driver_status);

CREATE OR REPLACE FUNCTION public.tr_driver_status_enforce()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.driver_status IS DISTINCT FROM 'active' AND OLD.driver_status = 'active' THEN
    PERFORM public.allow_driver_availability_write();
    NEW.is_online := false;

    IF OLD.is_online IS DISTINCT FROM false THEN
      PERFORM public.log_driver_availability_event(
        NEW.id,
        'effective_offline_account',
        CASE
          WHEN NEW.driver_status = 'disabled' THEN 'admin_disabled'
          WHEN NEW.driver_status = 'deleted' THEN 'account_deleted'
          ELSE 'account_ineligible'
        END,
        OLD.driver_online_intent,
        NEW.driver_online_intent,
        OLD.is_online,
        false,
        jsonb_build_object(
          'source', 'tr_driver_status_enforce',
          'active_trip_preserved', NEW.current_trip_id IS NOT NULL
        ),
        'admin'
      );
    END IF;
  END IF;

  IF NEW.driver_status = 'deleted' AND OLD.driver_status IS DISTINCT FROM 'deleted' THEN
    IF NEW.current_trip_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot delete a driver with an active trip (trip_id: %)',
        NEW.current_trip_id;
    END IF;
    NEW.deleted_at := now();
  END IF;

  IF NEW.driver_status IS DISTINCT FROM 'deleted' AND OLD.driver_status = 'deleted' THEN
    NEW.deleted_at := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
