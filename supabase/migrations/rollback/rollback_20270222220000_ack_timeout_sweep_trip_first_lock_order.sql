-- Rollback of 20270222220000: restore process_ride_offer_ack_timeouts() as it was
-- (candidate cursor FOR UPDATE SKIP LOCKED on ride_offers ONLY; trips updated later = offer -> trip order).
-- LOCAL / release-candidate only. Re-introduces the offer->trip vs trip->offer deadlock risk against
-- accept_ride_offer_core. No row is rewritten.
CREATE OR REPLACE FUNCTION public.process_ride_offer_ack_timeouts()
 RETURNS TABLE(offer_id uuid, trip_id uuid, driver_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_offer_id uuid;
  v_trip_id uuid;
  v_driver_id uuid;
  v_broadcast_round int;
  v_expires_at timestamptz;
  v_now timestamptz := now();
  v_wave1_secs int;
  v_wave2_secs int;
  v_wave3_secs int;
  v_max_rounds int;
  v_presence_secs int;
  v_gds_id uuid;
  v_fallback_secs int;
BEGIN
  SELECT
    g.id,
    NULLIF(g.wave1_offer_expiry_seconds, 0),
    NULLIF(g.wave2_offer_expiry_seconds, 0),
    NULLIF(g.wave3_offer_expiry_seconds, 0),
    NULLIF(g.max_dispatch_rounds, 0),
    NULLIF(g.presence_max_age_seconds, 0)
  INTO
    v_gds_id,
    v_wave1_secs,
    v_wave2_secs,
    v_wave3_secs,
    v_max_rounds,
    v_presence_secs
  FROM public.global_dispatch_settings g
  WHERE g.singleton = true
  LIMIT 1;

  v_fallback_secs := COALESCE(v_wave1_secs, v_wave2_secs, v_wave3_secs);

  FOR r IN
    SELECT
      ro.id AS oid,
      ro.trip_id AS tid,
      ro.driver_id AS did,
      ro.broadcast_round AS round,
      ro.expires_at AS exp_at,
      ro.offered_at,
      ro.delivery_first_dispatched_at
    FROM public.ride_offers ro
    WHERE ro.status = 'pending'
      AND ro.ack_at IS NULL
      AND ro.responded_at IS NULL
      AND (
        (ro.expires_at IS NOT NULL AND ro.expires_at <= v_now)
        OR (
          ro.expires_at IS NULL
          AND v_fallback_secs IS NOT NULL
          AND COALESCE(ro.delivery_first_dispatched_at, ro.offered_at)
            + make_interval(
                secs => CASE COALESCE(ro.broadcast_round, 1)
                  WHEN 1 THEN COALESCE(v_wave1_secs, v_fallback_secs)
                  WHEN 2 THEN COALESCE(v_wave2_secs, v_fallback_secs)
                  ELSE COALESCE(v_wave3_secs, v_fallback_secs)
                END
              ) <= v_now
        )
      )
    ORDER BY COALESCE(ro.expires_at, ro.offered_at) ASC
    LIMIT 120
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.ride_offers o
    SET
      status = 'expired',
      delivery_phase = 'ack_timeout',
      -- Delivery miss is NOT a voluntary decline: do not set responded_at.
      -- Cooldown / decline metrics must ignore ack_timeout expiries.
      responded_at = NULL,
      revoked_reason = COALESCE(o.revoked_reason, 'ack_timeout'),
      delivery_trace = COALESCE(delivery_trace, '{}'::jsonb) || jsonb_build_object(
        'ack_timeout_at', v_now,
        'reassigned_at', v_now,
        'reassigned_reason', 'booking_received_miss',
        'ack_timeout_policy', 'offer_expires_at',
        'timeout_reason', 'pending_unacked_past_expires_at',
        'non_driver_fault', true,
        'responded_at_suppressed', true,
        'broadcast_round', r.round,
        'expires_at', r.exp_at,
        'gds_id', v_gds_id,
        'gds_wave1_offer_expiry_seconds', v_wave1_secs,
        'gds_wave2_offer_expiry_seconds', v_wave2_secs,
        'gds_wave3_offer_expiry_seconds', v_wave3_secs,
        'gds_max_dispatch_rounds', v_max_rounds,
        'gds_presence_max_age_seconds', v_presence_secs,
        'redispatch_owner', 'ack_timeout_sweep_edge'
      ),
      updated_at = v_now
    WHERE o.id = r.oid
      AND o.status = 'pending'
      AND o.ack_at IS NULL
      AND o.responded_at IS NULL
      AND o.status NOT IN ('accepted', 'declined', 'revoked', 'expired')
    RETURNING o.id, o.trip_id, o.driver_id, o.broadcast_round, o.expires_at
      INTO v_offer_id, v_trip_id, v_driver_id, v_broadcast_round, v_expires_at;

    IF NOT FOUND THEN
      RAISE LOG '[booking_delivery] ack_timeout_skip offer_id=% booking_id=% reason=no_row_updated_concurrent_ack_or_terminal',
        r.oid, r.tid;
      CONTINUE;
    END IF;

    RAISE LOG '[delivery] ack_timeout_sweep booking_id=% offer_id=% driver_id=% round=% expires_at=% timeout_at=% phase=offer_expired gds_id=% non_driver_fault=true',
      v_trip_id, v_offer_id, v_driver_id, v_broadcast_round, v_expires_at, v_now, v_gds_id;

    PERFORM public.record_booking_delivery(
      v_trip_id,
      'ack_timeout',
      v_driver_id,
      v_offer_id,
      'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'timeout_at', v_now,
        'policy', 'offer_expires_at',
        'timeout_reason', 'pending_unacked_past_expires_at',
        'non_driver_fault', true,
        'broadcast_round', v_broadcast_round,
        'expires_at', v_expires_at,
        'gds_id', v_gds_id,
        'redispatch_owner', 'ack_timeout_sweep_edge'
      ))
    );

    UPDATE public.trips t
    SET
      current_offer_driver_id = NULL,
      current_offer_expires_at = NULL,
      updated_at = v_now
    WHERE t.id = v_trip_id
      AND t.current_offer_driver_id IS NOT DISTINCT FROM v_driver_id;

    PERFORM public.record_booking_delivery(
      v_trip_id,
      'reassigned',
      v_driver_id,
      v_offer_id,
      'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'note', 'trip_pointer_cleared',
        'prior_driver_id', v_driver_id,
        'reassigned_at', v_now,
        'broadcast_round', v_broadcast_round,
        'redispatch_owner', 'ack_timeout_sweep_edge',
        'non_driver_fault', true
      ))
    );

    offer_id := v_offer_id;
    trip_id := v_trip_id;
    driver_id := v_driver_id;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM anon;
REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_ride_offer_ack_timeouts() TO service_role;
