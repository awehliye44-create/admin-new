-- Preserve Admin HELD on scheduled INSERT.
-- Root cause: enforce_scheduled_trip_lifecycle forced scheduled_status='scheduled'
-- and stamped scheduled_broadcast_at on every unassigned scheduled INSERT, which:
--   1) wiped bookingSSOT admin_held
--   2) conflated create-time with Scheduled Jobs publication / Broadcast
--
-- Make Available in Scheduled Jobs is the explicit publication action.
-- Broadcast is the explicit NRO action.

CREATE OR REPLACE FUNCTION public.enforce_scheduled_trip_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_scheduled boolean;
  v_terminal boolean;
  v_broadcast timestamptz;
  v_convert timestamptz;
  v_sched text;
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

  v_sched := lower(COALESCE(NEW.scheduled_status, ''));

  -- Unassigned INSERT: preserve explicit Admin HELD from booking create.
  -- Do not stamp broadcasting here. UPDATE (STEP 2 / Broadcast) does not use this trigger.
  IF NEW.confirmed_driver_id IS NULL
     AND NEW.driver_id IS NULL
     AND NOT v_terminal
  THEN
    IF v_sched = 'admin_held' THEN
      NEW.scheduled_status := 'admin_held';
      -- HELD must not open Scheduled Jobs until Make Available / Broadcast.
      NEW.scheduled_broadcast_at := NULL;
    ELSIF v_sched = '' OR v_sched IS NULL THEN
      NEW.scheduled_status := 'scheduled';
    END IF;
  END IF;

  v_sched := lower(COALESCE(NEW.scheduled_status, ''));

  IF v_sched = 'admin_held' THEN
    -- Convert-at only (T−urgent safety). Never auto-publish broadcast_at.
    IF NEW.scheduled_convert_at IS NULL THEN
      SELECT a.scheduled_convert_at
        INTO v_convert
      FROM public.compute_scheduled_dispatch_anchors(NEW.scheduled_at, now()) a;
      NEW.scheduled_convert_at := v_convert;
    END IF;
    NEW.scheduled_broadcast_at := NULL;
  ELSIF NEW.scheduled_broadcast_at IS NULL OR NEW.scheduled_convert_at IS NULL THEN
    SELECT a.scheduled_broadcast_at, a.scheduled_convert_at
      INTO v_broadcast, v_convert
    FROM public.compute_scheduled_dispatch_anchors(NEW.scheduled_at, now()) a;

    IF NEW.scheduled_broadcast_at IS NULL THEN
      NEW.scheduled_broadcast_at := v_broadcast;
    END IF;
    IF NEW.scheduled_convert_at IS NULL THEN
      NEW.scheduled_convert_at := v_convert;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_scheduled_trip_lifecycle() IS
  'Scheduled INSERT lifecycle. Preserves admin_held + null broadcast_at for Admin HELD creates. Marketplace opens only via Make Available / Broadcast / activation.';
