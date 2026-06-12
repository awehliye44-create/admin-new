-- Dispatch metrics: one row per offer+phase (idempotent phases), accurate per-offer rates.

-- Phases that must not be double-counted in analytics.
CREATE OR REPLACE FUNCTION public.booking_delivery_phase_is_idempotent(p_phase text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_phase IN (
    'booking_sent',
    'socket_sent',
    'push_enqueued',
    'push_enqueued_skip_no_token',
    'push_sent',
    'push_failed',
    'booking_received',
    'offer_opened',
    'offer_popup_shown',
    'offer_acknowledged',
    'offer_popup_surfaced',
    'pending_offers_fallback',
    'ack_timeout',
    'reassigned',
    'reassigned_auto_dispatch',
    'accepted',
    'driver_declined',
    'no_eligible_drivers'
  );
$$;

CREATE OR REPLACE FUNCTION public.record_booking_delivery(
  p_booking_id uuid,
  p_phase text,
  p_driver_id uuid DEFAULT NULL,
  p_offer_id uuid DEFAULT NULL,
  p_source text DEFAULT 'postgres',
  p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ok BOOLEAN := FALSE;
  v_src text;
  v_exists boolean := false;
BEGIN
  IF pg_trigger_depth() > 0 THEN
    v_ok := TRUE;
  ELSIF COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN
    v_ok := TRUE;
  ELSIF auth.uid() IS NOT NULL AND p_driver_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.drivers d WHERE d.id = p_driver_id AND d.user_id = auth.uid()
    ) INTO v_ok;
  END IF;

  IF NOT v_ok THEN
    RETURN;
  END IF;

  IF public.booking_delivery_phase_is_idempotent(p_phase) THEN
    IF p_offer_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.booking_delivery_log
        WHERE offer_id = p_offer_id
          AND phase = p_phase
      ) INTO v_exists;
    ELSIF p_driver_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.booking_delivery_log
        WHERE booking_id = p_booking_id
          AND driver_id = p_driver_id
          AND phase = p_phase
      ) INTO v_exists;
    END IF;

    IF v_exists THEN
      RETURN;
    END IF;
  END IF;

  v_src := COALESCE(NULLIF(TRIM(p_source), ''), CASE WHEN pg_trigger_depth() > 0 THEN 'postgres' ELSE 'edge' END);

  BEGIN
    INSERT INTO public.booking_delivery_log (
      booking_id, driver_id, offer_id, phase, source, detail
    ) VALUES (
      p_booking_id,
      p_driver_id,
      p_offer_id,
      p_phase,
      v_src,
      COALESCE(p_detail, '{}'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[record_booking_delivery_failed] phase=% booking_id=% sqlstate=% sqlerrm=%',
      p_phase, p_booking_id, SQLSTATE, SQLERRM;
  END;
END;
$$;

-- Only log booking_received on first ACK (not every realtime/poll/http retry).
CREATE OR REPLACE FUNCTION public.ack_offer_delivery(
  p_offer_id UUID,
  p_method TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_driver_id UUID;
  v_trip_id UUID;
  v_now TIMESTAMPTZ := now();
  v_already_acked BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  IF p_method NOT IN ('realtime', 'push', 'poll', 'http') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_method');
  END IF;

  SELECT id INTO v_driver_id FROM public.drivers WHERE user_id = v_uid LIMIT 1;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_driver');
  END IF;

  PERFORM 1 FROM public.ride_offers WHERE id = p_offer_id AND driver_id = v_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'offer_not_found');
  END IF;

  SELECT trip_id INTO v_trip_id FROM public.ride_offers WHERE id = p_offer_id;

  SELECT (ack_at IS NOT NULL) INTO v_already_acked
  FROM public.ride_offers WHERE id = p_offer_id;

  UPDATE public.ride_offers
  SET
    delivered_at = COALESCE(delivered_at, v_now),
    delivery_method = COALESCE(delivery_method, p_method),
    ack_at = COALESCE(ack_at, v_now),
    delivery_phase = CASE
      WHEN delivery_phase IN ('driver_received', 'driver_viewed', 'driver_accepted') THEN delivery_phase
      ELSE 'driver_received'
    END,
    delivery_trace = COALESCE(delivery_trace, '{}'::jsonb) || jsonb_build_object(
      'booking_received_at', v_now,
      'booking_received_via', p_method
    ),
    updated_at = v_now
  WHERE id = p_offer_id;

  IF p_method = 'realtime' THEN
    UPDATE public.driver_presence
    SET last_realtime_seen_at = v_now, updated_at = v_now
    WHERE driver_id = v_driver_id;
  END IF;

  IF NOT COALESCE(v_already_acked, FALSE) THEN
    RAISE LOG '[booking_delivery] booking_received booking_id=% offer_id=% driver_id=% method=% first_write=true',
      v_trip_id, p_offer_id, v_driver_id, p_method;

    PERFORM public.record_booking_delivery(
      v_trip_id,
      'booking_received',
      v_driver_id,
      p_offer_id,
      'postgres',
      jsonb_build_object('method', p_method, 'first_write', true)
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'offer_id', p_offer_id,
    'method', p_method,
    'first_ack', NOT COALESCE(v_already_acked, false),
    'ack_at', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_dispatch_metrics(
  p_start timestamptz,
  p_end timestamptz,
  p_region_id uuid DEFAULT NULL,
  p_service_area_id uuid DEFAULT NULL,
  p_driver_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
  v_offered int;
  v_received int;
  v_socket_delivered int;
  v_push_enqueued int;
  v_push_sent int;
  v_push_failed int;
  v_fallback_offers int;
  v_total_offers int;
  v_reassigned int;
  v_accepted_offers int;
  v_expired_offers int;
  v_avg_accept_seconds numeric;
  v_timeline jsonb;
  v_hourly jsonb;
  v_failed jsonb;
  v_retry_delivery int;
  v_trips_total int;
  v_trips_no_eligible int;
BEGIN
  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  WITH filtered AS (
    SELECT
      b.offer_id,
      b.booking_id,
      b.driver_id,
      b.phase,
      b.created_at,
      COALESCE(b.offer_id::text, b.booking_id::text || ':' || COALESCE(b.driver_id::text, '')) AS offer_key
    FROM public.booking_delivery_log b
    LEFT JOIN public.trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
  ),
  per_offer AS (
    SELECT
      offer_key,
      bool_or(phase = 'booking_sent') AS offered,
      bool_or(phase IN (
        'booking_received', 'offer_opened', 'offer_popup_shown', 'offer_acknowledged'
      )) AS received,
      bool_or(phase = 'socket_sent') AS socket_delivered,
      bool_or(phase = 'push_enqueued') AS push_enqueued,
      bool_or(phase = 'push_sent') AS push_sent,
      bool_or(phase = 'push_failed') AS push_failed,
      bool_or(phase = 'pending_offers_fallback') AS fallback_used,
      bool_or(phase IN ('reassigned', 'reassigned_auto_dispatch', 'retry')) AS retried
    FROM filtered
    GROUP BY offer_key
  )
  SELECT
    COUNT(*) FILTER (WHERE offered),
    COUNT(*) FILTER (WHERE received),
    COUNT(*) FILTER (WHERE socket_delivered),
    COUNT(*) FILTER (WHERE push_enqueued),
    COUNT(*) FILTER (WHERE push_sent),
    COUNT(*) FILTER (WHERE push_failed AND NOT push_sent),
    COUNT(*) FILTER (WHERE fallback_used),
    COUNT(*) FILTER (WHERE retried)
  INTO v_offered, v_received, v_socket_delivered, v_push_enqueued, v_push_sent,
       v_push_failed, v_fallback_offers, v_retry_delivery
  FROM per_offer;

  SELECT
    COUNT(DISTINCT ro.id),
    COUNT(DISTINCT ro.id) FILTER (WHERE ro.broadcast_round > 1 OR ro.revoked_reason IN ('reassigned', 'ack_timeout')),
    COUNT(DISTINCT ro.id) FILTER (WHERE ro.status = 'accepted'),
    COUNT(DISTINCT ro.id) FILTER (WHERE ro.status = 'expired' OR ro.revoked_reason = 'ack_timeout'),
    AVG(EXTRACT(EPOCH FROM (ro.responded_at - ro.offered_at))) FILTER (WHERE ro.status = 'accepted' AND ro.responded_at IS NOT NULL)
  INTO v_total_offers, v_reassigned, v_accepted_offers, v_expired_offers, v_avg_accept_seconds
  FROM public.ride_offers ro
  LEFT JOIN public.trips t ON t.id = ro.trip_id
  WHERE ro.offered_at >= p_start AND ro.offered_at < p_end
    AND (p_region_id IS NULL OR t.region_id = p_region_id)
    AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
    AND (p_driver_id IS NULL OR ro.driver_id = p_driver_id);

  WITH trip_window AS (
    SELECT t.id
    FROM public.trips t
    WHERE t.created_at >= p_start AND t.created_at < p_end
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
  ),
  trip_eligibility AS (
    SELECT tw.id,
           COALESCE(SUM(CASE WHEN del.is_eligible THEN 1 ELSE 0 END), 0) AS eligible_count,
           COUNT(del.id) AS total_logged
    FROM trip_window tw
    LEFT JOIN public.dispatch_eligibility_log del ON del.trip_id = tw.id
    GROUP BY tw.id
  )
  SELECT COUNT(*) FILTER (WHERE total_logged > 0),
         COUNT(*) FILTER (WHERE total_logged > 0 AND eligible_count = 0)
  INTO v_trips_total, v_trips_no_eligible
  FROM trip_eligibility;

  SELECT jsonb_agg(jsonb_build_object('bucket', s.bucket, 'offered', s.offered, 'received', s.received) ORDER BY s.bucket)
  INTO v_timeline
  FROM (
    SELECT date_trunc('hour', b.created_at) AS bucket,
      COUNT(DISTINCT COALESCE(b.offer_id::text, b.booking_id::text || ':' || COALESCE(b.driver_id::text, '')))
        FILTER (WHERE b.phase = 'booking_sent') AS offered,
      COUNT(DISTINCT COALESCE(b.offer_id::text, b.booking_id::text || ':' || COALESCE(b.driver_id::text, '')))
        FILTER (WHERE b.phase IN (
          'booking_received', 'offer_opened', 'offer_popup_shown', 'offer_acknowledged'
        )) AS received
    FROM public.booking_delivery_log b
    LEFT JOIN public.trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    GROUP BY 1
  ) s;

  SELECT jsonb_agg(jsonb_build_object('bucket', s.bucket, 'timeout', s.timeout_count, 'reassigned', s.reassigned_count) ORDER BY s.bucket)
  INTO v_hourly
  FROM (
    SELECT date_trunc('hour', b.created_at) AS bucket,
      COUNT(DISTINCT COALESCE(b.offer_id::text, b.booking_id::text || ':' || COALESCE(b.driver_id::text, '')))
        FILTER (WHERE b.phase = 'ack_timeout') AS timeout_count,
      COUNT(DISTINCT COALESCE(b.offer_id::text, b.booking_id::text || ':' || COALESCE(b.driver_id::text, '')))
        FILTER (WHERE b.phase IN ('reassigned', 'reassigned_auto_dispatch')) AS reassigned_count
    FROM public.booking_delivery_log b
    LEFT JOIN public.trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    GROUP BY 1
  ) s;

  SELECT jsonb_agg(row_to_json(f) ORDER BY f.last_event_at DESC)
  INTO v_failed
  FROM (
    SELECT b.booking_id, b.driver_id, b.offer_id, b.phase,
      COALESCE(b.detail->>'reason', b.detail->>'failure_reason', b.phase) AS failure_reason,
      MIN(b.created_at) AS created_at, MAX(b.created_at) AS last_event_at
    FROM public.booking_delivery_log b
    LEFT JOIN public.trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND b.phase IN ('ack_timeout', 'reassigned', 'reassigned_auto_dispatch', 'push_failed')
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    GROUP BY b.booking_id, b.driver_id, b.offer_id, b.phase, failure_reason
    ORDER BY last_event_at DESC LIMIT 50
  ) f;

  RETURN jsonb_build_object(
    'offered', COALESCE(v_offered, 0),
    'received', LEAST(COALESCE(v_received, 0), COALESCE(v_offered, 0)),
    'ack_success_rate', CASE WHEN COALESCE(v_offered, 0) > 0
      THEN ROUND((LEAST(v_received, v_offered)::numeric / v_offered) * 100, 2) ELSE NULL END,
    'socket_delivered', COALESCE(v_socket_delivered, 0),
    'socket_success_rate', CASE WHEN COALESCE(v_offered, 0) > 0
      THEN ROUND((LEAST(v_socket_delivered, v_offered)::numeric / v_offered) * 100, 2) ELSE NULL END,
    'push_enqueued', COALESCE(v_push_enqueued, 0),
    'push_sent', COALESCE(v_push_sent, 0),
    'push_failed', COALESCE(v_push_failed, 0),
    'push_success_rate', CASE WHEN COALESCE(v_push_enqueued, 0) > 0
      THEN ROUND((v_push_sent::numeric / v_push_enqueued) * 100, 2) ELSE NULL END,
    'avg_accept_seconds', ROUND(COALESCE(v_avg_accept_seconds, 0)::numeric, 2),
    'total_offers', COALESCE(v_total_offers, 0),
    'reassigned_offers', COALESCE(v_reassigned, 0),
    'reassigned_pct', CASE WHEN COALESCE(v_total_offers, 0) > 0
      THEN ROUND((v_reassigned::numeric / v_total_offers) * 100, 2) ELSE NULL END,
    'accepted_offers', COALESCE(v_accepted_offers, 0),
    'acceptance_rate', CASE WHEN COALESCE(v_total_offers, 0) > 0
      THEN ROUND((v_accepted_offers::numeric / v_total_offers) * 100, 2) ELSE NULL END,
    'expired_offers', COALESCE(v_expired_offers, 0),
    'timeout_rate', CASE WHEN COALESCE(v_total_offers, 0) > 0
      THEN ROUND((v_expired_offers::numeric / v_total_offers) * 100, 2) ELSE NULL END,
    'fallback_offers', COALESCE(v_fallback_offers, 0),
    'fallback_rate', CASE WHEN COALESCE(v_offered, 0) > 0
      THEN ROUND((v_fallback_offers::numeric / v_offered) * 100, 2) ELSE NULL END,
    'trips_evaluated', COALESCE(v_trips_total, 0),
    'trips_no_eligible', COALESCE(v_trips_no_eligible, 0),
    'no_eligible_rate', CASE WHEN COALESCE(v_trips_total, 0) > 0
      THEN ROUND((v_trips_no_eligible::numeric / v_trips_total) * 100, 2) ELSE NULL END,
    'timeline', COALESCE(v_timeline, '[]'::jsonb),
    'hourly_failures', COALESCE(v_hourly, '[]'::jsonb),
    'recent_failures', COALESCE(v_failed, '[]'::jsonb),
    'debug', jsonb_build_object(
      'retry_delivery_count', COALESCE(v_retry_delivery, 0),
      'metrics_basis', 'distinct_offer_per_phase'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_dispatch_metrics(timestamptz, timestamptz, uuid, uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_dispatch_metrics(timestamptz, timestamptz, uuid, uuid, uuid) TO authenticated;
