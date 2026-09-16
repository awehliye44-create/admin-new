-- MK-260916-038: unassigned future scheduled INSERT must not open the marketplace.
-- scheduled_status = broadcasting is written only by canonical scheduled-dispatch STEP 2.

CREATE OR REPLACE FUNCTION public.enforce_scheduled_trip_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_scheduled boolean;
  v_terminal boolean;
BEGIN
  v_is_scheduled :=
    COALESCE(NEW.is_scheduled, false)
    OR LOWER(COALESCE(NEW.trip_type, '')) = 'scheduled'
    OR NEW.scheduled_at IS NOT NULL;

  IF NOT v_is_scheduled OR NEW.scheduled_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_terminal := LOWER(COALESCE(NEW.status, '')) IN (
    'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
    'no_show', 'expired', 'expired_no_driver'
  );

  NEW.is_scheduled := true;
  IF NEW.trip_type IS NULL OR btrim(NEW.trip_type) = '' OR LOWER(NEW.trip_type) = 'instant' THEN
    NEW.trip_type := 'scheduled';
  END IF;
  NEW.dispatch_mode := 'scheduled';

  IF NOT v_terminal THEN
    NEW.status := 'scheduled';
  END IF;

  -- Unassigned INSERT is pre-marketplace. Do not stamp broadcasting here.
  IF NEW.confirmed_driver_id IS NULL
     AND NEW.driver_id IS NULL
     AND NOT v_terminal
  THEN
    NEW.scheduled_status := 'scheduled';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_scheduled_trip_lifecycle() IS
  'MK-260916-038: future unassigned scheduled INSERT keeps scheduled_status=scheduled. Marketplace broadcasting is owned by scheduled-dispatch STEP 2.';
