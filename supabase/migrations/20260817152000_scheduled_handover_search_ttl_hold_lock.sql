-- MK-260817-006: scheduled handover must not use instant created_at search TTL,
-- and must not void an AUTHORISED hold on premature system expiry.
-- Isolated: replace expire_trip_when_search_exhausted + terminal hold trigger only.

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
    lower(COALESCE(v_trip.dispatch_mode, '')) = 'scheduled'
    AND lower(COALESCE(v_trip.scheduled_status, '')) IS DISTINCT FROM 'converted_to_instant'
    AND COALESCE(NULLIF(trim(COALESCE(v_trip.cancelled_by, '')), ''), '') = ''
    AND lower(COALESCE(v_trip.status, '')) NOT IN (
      'cancelled', 'canceled', 'customer_cancelled', 'driver_cancelled', 'no_show'
    );

  v_scheduled_origin :=
    COALESCE(v_trip.is_scheduled, false) = true
    OR lower(COALESCE(v_trip.dispatch_mode, '')) = 'scheduled'
    OR v_trip.scheduled_at IS NOT NULL
    OR COALESCE(v_trip.scheduled_status, '') <> '';

  IF v_trip.searching_expires_at IS NOT NULL THEN
    v_search_deadline := v_trip.searching_expires_at;
  ELSIF v_scheduled_handover_pending THEN
    -- Instant TTL has not started. Conversion stamps searching_expires_at.
    RETURN false;
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
      AND status IN ('pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver');
    RETURN false;
  END IF;

  -- All 3-wave rounds consumed but TTL remains: expire early only when rounds are exhausted.
  IF v_seq >= v_max_seq THEN
    IF v_scheduled_handover_pending THEN
      RETURN false;
    END IF;

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
    AND status IN ('pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver');

  RETURN false;
END;
$function$;

COMMENT ON FUNCTION public.expire_trip_when_search_exhausted(uuid) IS
  'Expire searching trips after searching_expires_at. Scheduled handover (dispatch_mode=scheduled, not converted_to_instant) must not use created_at instant TTL.';

CREATE OR REPLACE FUNCTION public.trg_trips_terminal_payment_disposition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_terminal boolean;
  v_new_eligible_terminal boolean;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Never dispose completed trips (separate settlement owner).
  IF NEW.status = 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  -- Keep auth on rematch / active statuses.
  IF NEW.status IN (
    'searching', 'searching_new_driver', 'broadcasting', 'offered', 'offering',
    'negotiating', 'pending', 'payment_pending', 'driver_assigned', 'accepted',
    'confirmed', 'queued', 'en_route', 'en_route_to_pickup', 'driver_en_route',
    'arrived', 'arrived_at_pickup', 'at_pickup', 'waiting', 'pickup_waiting',
    'in_progress', 'on_trip', 'started', 'ongoing', 'completing'
  ) THEN
    RETURN NEW;
  END IF;

  v_old_terminal := OLD.status IN (
    'cancelled', 'canceled', 'customer_cancelled', 'driver_cancelled',
    'expired', 'expired_no_driver', 'no_show', 'failed', 'declined', 'completed'
  );
  -- Already terminal: do not re-enqueue on terminal→terminal label changes.
  IF v_old_terminal THEN
    RETURN NEW;
  END IF;

  v_new_eligible_terminal := NEW.status IN (
    'cancelled', 'canceled', 'customer_cancelled', 'driver_cancelled',
    'expired', 'expired_no_driver', 'no_show', 'failed', 'declined'
  );
  IF NOT v_new_eligible_terminal THEN
    RETURN NEW;
  END IF;

  -- MK-260817-006: premature scheduled system expiry must not void the hold.
  -- Customer/admin cancel and converted instant exhaustion still enqueue.
  IF NEW.status IN ('expired', 'expired_no_driver')
     AND lower(COALESCE(NEW.dispatch_mode, '')) = 'scheduled'
     AND lower(COALESCE(NEW.scheduled_status, '')) IS DISTINCT FROM 'converted_to_instant'
     AND COALESCE(NULLIF(trim(COALESCE(NEW.cancelled_by, '')), ''), '') = ''
     AND COALESCE(NULLIF(trim(COALESCE(NEW.cancellation_reason, '')), ''), '') = ''
  THEN
    RETURN NEW;
  END IF;

  PERFORM public.invoke_release_terminal_trip_hold(
    NEW.id,
    CASE
      WHEN NEW.status IN ('expired', 'expired_no_driver') THEN 'search_expired'
      WHEN lower(coalesce(NEW.cancelled_by, '')) = 'admin' THEN 'admin_cancel'
      WHEN lower(coalesce(NEW.cancelled_by, '')) = 'driver' THEN 'driver_cancel_terminal'
      ELSE 'customer_cancel'
    END
  );

  RETURN NEW;
END;
$function$;
