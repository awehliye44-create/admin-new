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
  v_push_enqueued int;
  v_push_sent int;
  v_total_offers int;
  v_reassigned int;
  v_accepted_offers int;
  v_expired_offers int;
  v_avg_accept_seconds numeric;
  v_timeline jsonb;
  v_hourly jsonb;
  v_failed jsonb;
  v_dup_ack int;
  v_dup_push int;
  v_retry_delivery int;
  v_pending_recovery int;
  v_trips_total int;
  v_trips_no_eligible int;
BEGIN
  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  WITH bdl_raw AS (
    SELECT b.offer_id, b.booking_id, b.driver_id, b.phase, b.created_at, b.detail
    FROM public.booking_delivery_log b
    LEFT JOIN public.trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
  ),
  bdl AS (
    SELECT DISTINCT ON (
      COALESCE(offer_id::text, booking_id::text || ':' || COALESCE(driver_id::text,'')),
      phase
    )
      offer_id, booking_id, driver_id, phase, created_at, detail
    FROM bdl_raw
    ORDER BY
      COALESCE(offer_id::text, booking_id::text || ':' || COALESCE(driver_id::text,'')),
      phase, created_at ASC
  ),
  collapsed AS (
    SELECT
      COALESCE(offer_id::text, booking_id::text || ':' || COALESCE(driver_id::text,'')) AS k,
      CASE WHEN phase IN ('booking_received','offer_opened','offer_popup_shown','offer_acknowledged')
           THEN 'booking_received' ELSE phase END AS phase
    FROM bdl GROUP BY 1, 2
  ),
  deduped AS (
    SELECT
      COUNT(*) FILTER (WHERE phase = 'booking_sent') AS offered,
      COUNT(*) FILTER (WHERE phase = 'booking_received') AS received,
      COUNT(*) FILTER (WHERE phase = 'push_enqueued') AS push_enqueued,
      COUNT(*) FILTER (WHERE phase = 'push_sent') AS push_sent
    FROM collapsed
  ),
  raw_counts AS (
    SELECT
      COUNT(*) FILTER (WHERE phase IN ('booking_received','offer_opened','offer_popup_shown','offer_acknowledged')) AS raw_ack,
      COUNT(*) FILTER (WHERE phase = 'push_sent') AS raw_push_sent,
      COUNT(*) FILTER (WHERE phase IN ('reassigned','reassigned_auto_dispatch','retry')) AS retry_delivery,
      COUNT(*) FILTER (WHERE phase = 'pending_offers_fallback') AS pending_recovery
    FROM bdl_raw
  )
  SELECT d.offered, d.received, d.push_enqueued, d.push_sent,
         GREATEST(r.raw_ack - d.received, 0),
         GREATEST(r.raw_push_sent - d.push_sent, 0),
         r.retry_delivery, r.pending_recovery
  INTO v_offered, v_received, v_push_enqueued, v_push_sent,
       v_dup_ack, v_dup_push, v_retry_delivery, v_pending_recovery
  FROM deduped d CROSS JOIN raw_counts r;

  -- Offer-level metrics
  SELECT
    COUNT(DISTINCT ro.id),
    COUNT(DISTINCT ro.id) FILTER (WHERE ro.broadcast_round > 1 OR ro.revoked_reason IN ('reassigned','ack_timeout')),
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

  -- No eligible drivers: trips in window with zero eligible drivers in dispatch_eligibility_log
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

  -- Timeline
  SELECT jsonb_agg(jsonb_build_object('bucket', s.bucket, 'offered', s.offered, 'received', s.received) ORDER BY s.bucket)
  INTO v_timeline
  FROM (
    SELECT date_trunc('hour', created_at) AS bucket,
      COUNT(DISTINCT key) FILTER (WHERE phase = 'booking_sent') AS offered,
      COUNT(DISTINCT key) FILTER (WHERE phase IN ('booking_received','offer_opened','offer_popup_shown','offer_acknowledged')) AS received
    FROM (
      SELECT b.created_at, b.phase,
        COALESCE(b.offer_id::text, b.booking_id::text || ':' || COALESCE(b.driver_id::text,'')) AS key
      FROM public.booking_delivery_log b
      LEFT JOIN public.trips t ON t.id = b.booking_id
      WHERE b.created_at >= p_start AND b.created_at < p_end
        AND (p_region_id IS NULL OR t.region_id = p_region_id)
        AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
        AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    ) x GROUP BY 1
  ) s;

  SELECT jsonb_agg(jsonb_build_object('bucket', s.bucket, 'timeout', s.timeout_count, 'reassigned', s.reassigned_count) ORDER BY s.bucket)
  INTO v_hourly
  FROM (
    SELECT date_trunc('hour', created_at) AS bucket,
      COUNT(DISTINCT key) FILTER (WHERE phase = 'ack_timeout') AS timeout_count,
      COUNT(DISTINCT key) FILTER (WHERE phase IN ('reassigned','reassigned_auto_dispatch')) AS reassigned_count
    FROM (
      SELECT b.created_at, b.phase,
        COALESCE(b.offer_id::text, b.booking_id::text || ':' || COALESCE(b.driver_id::text,'')) AS key
      FROM public.booking_delivery_log b
      LEFT JOIN public.trips t ON t.id = b.booking_id
      WHERE b.created_at >= p_start AND b.created_at < p_end
        AND (p_region_id IS NULL OR t.region_id = p_region_id)
        AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
        AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    ) x GROUP BY 1
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
      AND b.phase IN ('ack_timeout','reassigned','reassigned_auto_dispatch','pending_offers_fallback')
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    GROUP BY b.booking_id, b.driver_id, b.offer_id, b.phase, failure_reason
    ORDER BY last_event_at DESC LIMIT 50
  ) f;

  RETURN jsonb_build_object(
    'offered', COALESCE(v_offered,0),
    'received', LEAST(COALESCE(v_received,0), COALESCE(v_offered,0)),
    'ack_success_rate', CASE WHEN COALESCE(v_offered,0) > 0
      THEN LEAST(ROUND((LEAST(v_received, v_offered)::numeric / v_offered) * 100, 2), 100) ELSE NULL END,
    'push_enqueued', COALESCE(v_push_enqueued,0),
    'push_sent', LEAST(COALESCE(v_push_sent,0), COALESCE(v_push_enqueued,0)),
    'push_success_rate', CASE WHEN COALESCE(v_push_enqueued,0) > 0
      THEN LEAST(ROUND((LEAST(v_push_sent, v_push_enqueued)::numeric / v_push_enqueued) * 100, 2), 100) ELSE NULL END,
    'avg_accept_seconds', ROUND(COALESCE(v_avg_accept_seconds,0)::numeric, 2),
    'total_offers', COALESCE(v_total_offers,0),
    'reassigned_offers', COALESCE(v_reassigned,0),
    'reassigned_pct', CASE WHEN COALESCE(v_total_offers,0) > 0
      THEN LEAST(ROUND((v_reassigned::numeric / v_total_offers) * 100, 2), 100) ELSE NULL END,
    'accepted_offers', COALESCE(v_accepted_offers,0),
    'acceptance_rate', CASE WHEN COALESCE(v_total_offers,0) > 0
      THEN LEAST(ROUND((v_accepted_offers::numeric / v_total_offers) * 100, 2), 100) ELSE NULL END,
    'expired_offers', COALESCE(v_expired_offers,0),
    'timeout_rate', CASE WHEN COALESCE(v_total_offers,0) > 0
      THEN LEAST(ROUND((v_expired_offers::numeric / v_total_offers) * 100, 2), 100) ELSE NULL END,
    'fallback_rate', CASE WHEN COALESCE(v_offered,0) > 0
      THEN LEAST(ROUND((COALESCE(v_pending_recovery,0)::numeric / v_offered) * 100, 2), 100) ELSE NULL END,
    'trips_evaluated', COALESCE(v_trips_total,0),
    'trips_no_eligible', COALESCE(v_trips_no_eligible,0),
    'no_eligible_rate', CASE WHEN COALESCE(v_trips_total,0) > 0
      THEN LEAST(ROUND((v_trips_no_eligible::numeric / v_trips_total) * 100, 2), 100) ELSE NULL END,
    'timeline', COALESCE(v_timeline, '[]'::jsonb),
    'hourly_failures', COALESCE(v_hourly, '[]'::jsonb),
    'recent_failures', COALESCE(v_failed, '[]'::jsonb),
    'debug', jsonb_build_object(
      'duplicate_ack_count', COALESCE(v_dup_ack,0),
      'duplicate_push_count', COALESCE(v_dup_push,0),
      'retry_delivery_count', COALESCE(v_retry_delivery,0),
      'pending_offer_recovery_count', COALESCE(v_pending_recovery,0)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_dispatch_metrics(timestamptz, timestamptz, uuid, uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_dispatch_metrics(timestamptz, timestamptz, uuid, uuid, uuid) TO authenticated;