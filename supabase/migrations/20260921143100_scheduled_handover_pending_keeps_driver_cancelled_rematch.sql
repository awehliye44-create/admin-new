-- MK-260817-006: status=driver_cancelled is rematch, not terminal cancel.
-- Excluding it from pending let a stale created_at TTL stamp/expire during
-- scheduled handover (same class as cancelled_by=driver). Isolated; does
-- not mutate MK-260817-006.

CREATE OR REPLACE FUNCTION public.expire_trip_when_search_exhausted(p_trip_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_g public.global_dispatch_settings%ROWTYPE;
  v_now timestamptz := now();
  v_search_deadline timestamptz;
  v_find_minutes integer;
  v_live_offer_count int := 0;
  v_seq int := 0;
  v_max_seq int := 9;
  v_scheduled_handover_pending boolean := false;
  v_scheduled_origin boolean := false;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_trip.driver_id IS NOT NULL OR v_trip.confirmed_driver_id IS NOT NULL THEN
    RETURN false;
  END IF;

  IF v_trip.status IN (
      'completed', 'cancelled', 'customer_cancelled', 'expired', 'expired_no_driver'
    )
    OR v_trip.dispatch_status IN ('expired', 'cancelled')
    OR v_trip.scheduled_status IN ('cancelled', 'expired', 'no_driver_found') THEN
    RETURN true;
  END IF;

  IF COALESCE(v_trip.broadcast_enabled, true) = false THEN
    RETURN false;
  END IF;

  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
  v_find_minutes := GREATEST(1, COALESCE(v_g.max_driver_find_time_minutes, 3));
  v_max_seq := GREATEST(1, COALESCE(v_g.max_dispatch_rounds, 3)) * 3;

  v_scheduled_handover_pending :=
    public.is_scheduled_instant_conversion_pending(
      v_trip.dispatch_mode,
      v_trip.scheduled_status,
      v_trip.is_scheduled,
      v_trip.scheduled_at
    )
    AND lower(COALESCE(v_trip.status, '')) NOT IN (
      'cancelled', 'canceled', 'customer_cancelled', 'no_show'
    );

  v_scheduled_origin :=
    COALESCE(v_trip.is_scheduled, false) = true
    OR lower(COALESCE(v_trip.dispatch_mode, '')) = 'scheduled'
    OR v_trip.scheduled_at IS NOT NULL
    OR COALESCE(v_trip.scheduled_status, '') <> '';

  -- Instant TTL has not started. Ignore any stale searching_expires_at stamp.
  IF v_scheduled_handover_pending THEN
    RETURN false;
  END IF;

  IF v_trip.searching_expires_at IS NOT NULL THEN
    v_search_deadline := v_trip.searching_expires_at;
  ELSIF v_scheduled_origin THEN
    -- Converted (or instant-mode) scheduled trip missing stamp: do not use booking created_at.
    v_search_deadline := v_now + make_interval(mins => v_find_minutes);
  ELSE
    v_search_deadline := COALESCE(
      v_trip.created_at + make_interval(mins => v_find_minutes),
      v_now + make_interval(mins => v_find_minutes)
    );
  END IF;

  -- Trip TTL is the only terminal condition.
  IF v_search_deadline <= v_now THEN
    UPDATE public.ride_offers
    SET status = 'revoked',
        revoked_reason = 'trip_expired_no_driver',
        updated_at = v_now
    WHERE trip_id = p_trip_id
      AND status IN ('pending', 'countered');

    UPDATE public.trips
    SET status = 'expired',
        dispatch_status = 'expired',
        scheduled_status = CASE
          WHEN v_trip.scheduled_status IS NOT NULL
            OR v_trip.dispatch_mode = 'scheduled'
            OR COALESCE(v_trip.is_scheduled, false) = true
          THEN 'no_driver_found'
          ELSE scheduled_status
        END,
        broadcast_enabled = false,
        updated_at = v_now
    WHERE id = p_trip_id
      AND status NOT IN (
        'completed', 'cancelled', 'customer_cancelled', 'expired', 'expired_no_driver'
      );

    RETURN true;
  END IF;

  SELECT COUNT(*)::int INTO v_live_offer_count
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id
    AND ro.status IN ('pending', 'countered', 'accepted')
    AND (ro.expires_at IS NULL OR ro.expires_at > v_now);

  v_seq := COALESCE(v_trip.current_broadcast_round, 0);

  IF v_live_offer_count > 0 THEN
    UPDATE public.trips
    SET status = 'offered',
        dispatch_status = 'broadcasting',
        searching_expires_at = COALESCE(searching_expires_at, v_search_deadline),
        updated_at = v_now
    WHERE id = p_trip_id
      AND status IN ('pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver', 'driver_cancelled');
    RETURN false;
  END IF;

  IF v_seq >= v_max_seq THEN
    UPDATE public.ride_offers
    SET status = 'revoked',
        revoked_reason = 'dispatch_rounds_exhausted',
        updated_at = v_now
    WHERE trip_id = p_trip_id
      AND status IN ('pending', 'countered');

    UPDATE public.trips
    SET status = 'expired',
        dispatch_status = 'expired',
        scheduled_status = CASE
          WHEN v_trip.scheduled_status IS NOT NULL
            OR v_trip.dispatch_mode = 'scheduled'
            OR COALESCE(v_trip.is_scheduled, false) = true
          THEN 'no_driver_found'
          ELSE scheduled_status
        END,
        broadcast_enabled = false,
        updated_at = v_now
    WHERE id = p_trip_id
      AND status NOT IN (
        'completed', 'cancelled', 'customer_cancelled', 'expired', 'expired_no_driver'
      );
    RETURN true;
  END IF;

  UPDATE public.trips
  SET status = 'searching',
      dispatch_status = 'broadcasting',
      searching_expires_at = COALESCE(searching_expires_at, v_search_deadline),
      updated_at = v_now
  WHERE id = p_trip_id
    AND status IN ('pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver', 'driver_cancelled');

  RETURN false;
END;
$function$;

COMMENT ON FUNCTION public.expire_trip_when_search_exhausted(uuid) IS
  'Expire searching trips after searching_expires_at. Scheduled handover ignores stale searching_expires_at, never uses created_at instant TTL, and stays pending through driver rematch (cancelled_by and status=driver_cancelled).';

CREATE OR REPLACE FUNCTION public.trg_scheduled_handover_block_premature_search_ttl()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pending boolean := false;
BEGIN
  v_pending :=
    public.is_scheduled_instant_conversion_pending(
      NEW.dispatch_mode,
      NEW.scheduled_status,
      NEW.is_scheduled,
      NEW.scheduled_at
    )
    AND lower(COALESCE(NEW.status, '')) NOT IN (
      'cancelled', 'canceled', 'customer_cancelled', 'no_show'
    );

  IF NOT v_pending THEN
    RETURN NEW;
  END IF;

  -- Instant TTL must not be stamped from booking created_at during handover.
  NEW.searching_expires_at := NULL;

  IF TG_OP = 'UPDATE'
     AND NEW.status IN ('expired', 'expired_no_driver')
     AND OLD.status NOT IN (
       'expired', 'expired_no_driver', 'cancelled', 'customer_cancelled', 'completed'
     )
  THEN
    NEW.status := OLD.status;
    NEW.dispatch_status := OLD.dispatch_status;
    NEW.broadcast_enabled := OLD.broadcast_enabled;
    IF lower(COALESCE(NEW.scheduled_status, '')) = 'no_driver_found' THEN
      NEW.scheduled_status := OLD.scheduled_status;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_scheduled_handover_block_premature_search_ttl ON public.trips;

CREATE TRIGGER trg_scheduled_handover_block_premature_search_ttl
BEFORE INSERT OR UPDATE ON public.trips
FOR EACH ROW
EXECUTE FUNCTION public.trg_scheduled_handover_block_premature_search_ttl();

COMMENT ON FUNCTION public.trg_scheduled_handover_block_premature_search_ttl() IS
  'MK-260817-006: while scheduled conversion is pending, do not stamp instant TTL or system-expire the trip. Driver rematch (searching_new_driver / driver_cancelled) stays pending.';
