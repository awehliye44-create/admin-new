-- MK-260916-038 RC4: persist canonical scheduled marketplace / conversion anchors
-- on INSERT. Formula matches computeScheduledDispatchAnchors in
-- supabase/functions/_shared/scheduledDispatchConfig.ts (single source of policy:
-- global_dispatch_settings.urgent_dispatch_trigger_minutes_before_pickup +
-- scheduled_response_window_minutes). Booking Edge still writes the same values;
-- this trigger fills NULL so a stale Edge deploy cannot drop the anchors.

CREATE OR REPLACE FUNCTION public.compute_scheduled_dispatch_anchors(
  p_scheduled_at timestamptz,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  scheduled_broadcast_at timestamptz,
  scheduled_convert_at timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_urgent int;
  v_response int;
  v_convert timestamptz;
  v_ideal_broadcast timestamptz;
BEGIN
  IF p_scheduled_at IS NULL THEN
    RETURN;
  END IF;

  SELECT
    CASE
      WHEN g.urgent_dispatch_trigger_minutes_before_pickup IS NOT NULL
           AND g.urgent_dispatch_trigger_minutes_before_pickup::numeric > 0
        THEN GREATEST(1, FLOOR(g.urgent_dispatch_trigger_minutes_before_pickup)::int)
      ELSE 5
    END,
    CASE
      WHEN g.scheduled_response_window_minutes IS NOT NULL
           AND g.scheduled_response_window_minutes::numeric > 0
        THEN GREATEST(1, FLOOR(g.scheduled_response_window_minutes)::int)
      ELSE 10
    END
  INTO v_urgent, v_response
  FROM public.global_dispatch_settings g
  WHERE g.singleton IS TRUE
  LIMIT 1;

  v_urgent := COALESCE(v_urgent, 5);
  v_response := COALESCE(v_response, 10);

  v_convert := p_scheduled_at - (v_urgent * interval '1 minute');
  v_ideal_broadcast := v_convert - (v_response * interval '1 minute');

  scheduled_convert_at := v_convert;
  scheduled_broadcast_at := CASE
    WHEN p_now < v_ideal_broadcast THEN v_ideal_broadcast
    ELSE p_now
  END;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.compute_scheduled_dispatch_anchors(timestamptz, timestamptz) IS
  'MK-260916-038: same formula as computeScheduledDispatchAnchors (urgent minutes before pickup, then response window). Never a second policy clock.';

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
  -- Trigger is BEFORE INSERT only; UPDATE (STEP 2 broadcasting) does not pass through.
  IF NEW.confirmed_driver_id IS NULL
     AND NEW.driver_id IS NULL
     AND NOT v_terminal
  THEN
    NEW.scheduled_status := 'scheduled';
  END IF;

  IF NEW.scheduled_broadcast_at IS NULL OR NEW.scheduled_convert_at IS NULL THEN
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
  'MK-260916-038: INSERT keeps scheduled_status=scheduled and persists broadcast/convert anchors. Marketplace broadcasting is owned by scheduled-dispatch STEP 2.';
