
-- Indexes for booking_delivery_log
CREATE INDEX IF NOT EXISTS idx_bdl_booking_id ON public.booking_delivery_log(booking_id);
CREATE INDEX IF NOT EXISTS idx_bdl_driver_id ON public.booking_delivery_log(driver_id);
CREATE INDEX IF NOT EXISTS idx_bdl_offer_id ON public.booking_delivery_log(offer_id);
CREATE INDEX IF NOT EXISTS idx_bdl_phase ON public.booking_delivery_log(phase);
CREATE INDEX IF NOT EXISTS idx_bdl_created_at ON public.booking_delivery_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ride_offers_offered_at ON public.ride_offers(offered_at DESC);

-- Aggregated metrics RPC
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
  v_avg_accept_seconds numeric;
  v_timeline jsonb;
  v_hourly jsonb;
  v_failed jsonb;
BEGIN
  -- Admin gate
  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Booking delivery counts (joined to trips for region/SA filters)
  WITH bdl AS (
    SELECT b.* FROM booking_delivery_log b
    LEFT JOIN trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
  )
  SELECT
    COUNT(*) FILTER (WHERE phase = 'booking_sent'),
    COUNT(*) FILTER (WHERE phase = 'booking_received'),
    COUNT(*) FILTER (WHERE phase = 'push_enqueued'),
    COUNT(*) FILTER (WHERE phase = 'push_sent')
  INTO v_offered, v_received, v_push_enqueued, v_push_sent
  FROM bdl;

  -- Ride offers metrics
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE broadcast_round > 1 OR revoked_reason IN ('reassigned','ack_timeout')),
    AVG(EXTRACT(EPOCH FROM (responded_at - offered_at))) FILTER (WHERE status = 'accepted' AND responded_at IS NOT NULL)
  INTO v_total_offers, v_reassigned, v_avg_accept_seconds
  FROM ride_offers ro
  LEFT JOIN trips t ON t.id = ro.trip_id
  WHERE ro.offered_at >= p_start AND ro.offered_at < p_end
    AND (p_region_id IS NULL OR t.region_id = p_region_id)
    AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
    AND (p_driver_id IS NULL OR ro.driver_id = p_driver_id);

  -- Hourly timeline: offered vs received
  SELECT jsonb_agg(jsonb_build_object(
    'bucket', bucket,
    'offered', offered,
    'received', received
  ) ORDER BY bucket)
  INTO v_timeline
  FROM (
    SELECT date_trunc('hour', b.created_at) AS bucket,
      COUNT(*) FILTER (WHERE phase = 'booking_sent') AS offered,
      COUNT(*) FILTER (WHERE phase = 'booking_received') AS received
    FROM booking_delivery_log b
    LEFT JOIN trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    GROUP BY 1
  ) s;

  -- Hourly timeout/reassigned counts
  SELECT jsonb_agg(jsonb_build_object(
    'bucket', bucket,
    'timeout', timeout_count,
    'reassigned', reassigned_count
  ) ORDER BY bucket)
  INTO v_hourly
  FROM (
    SELECT date_trunc('hour', b.created_at) AS bucket,
      COUNT(*) FILTER (WHERE phase = 'ack_timeout') AS timeout_count,
      COUNT(*) FILTER (WHERE phase IN ('reassigned','reassigned_auto_dispatch')) AS reassigned_count
    FROM booking_delivery_log b
    LEFT JOIN trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    GROUP BY 1
  ) s;

  -- Recent failed deliveries (timeout / reassigned)
  SELECT jsonb_agg(row_to_json(f) ORDER BY f.last_event_at DESC)
  INTO v_failed
  FROM (
    SELECT
      b.booking_id,
      b.driver_id,
      b.offer_id,
      b.phase,
      COALESCE(b.detail->>'reason', b.detail->>'failure_reason', b.phase) AS failure_reason,
      MIN(b.created_at) AS created_at,
      MAX(b.created_at) AS last_event_at
    FROM booking_delivery_log b
    LEFT JOIN trips t ON t.id = b.booking_id
    WHERE b.created_at >= p_start AND b.created_at < p_end
      AND b.phase IN ('ack_timeout','reassigned','reassigned_auto_dispatch','pending_offers_fallback')
      AND (p_region_id IS NULL OR t.region_id = p_region_id)
      AND (p_service_area_id IS NULL OR t.service_area_id = p_service_area_id)
      AND (p_driver_id IS NULL OR b.driver_id = p_driver_id)
    GROUP BY b.booking_id, b.driver_id, b.offer_id, b.phase, failure_reason
    ORDER BY last_event_at DESC
    LIMIT 50
  ) f;

  RETURN jsonb_build_object(
    'offered', COALESCE(v_offered,0),
    'received', COALESCE(v_received,0),
    'ack_success_rate', CASE WHEN COALESCE(v_offered,0) > 0 THEN ROUND((v_received::numeric / v_offered) * 100, 2) ELSE NULL END,
    'push_enqueued', COALESCE(v_push_enqueued,0),
    'push_sent', COALESCE(v_push_sent,0),
    'push_success_rate', CASE WHEN COALESCE(v_push_enqueued,0) > 0 THEN ROUND((v_push_sent::numeric / v_push_enqueued) * 100, 2) ELSE NULL END,
    'avg_accept_seconds', ROUND(COALESCE(v_avg_accept_seconds,0)::numeric, 2),
    'total_offers', COALESCE(v_total_offers,0),
    'reassigned_offers', COALESCE(v_reassigned,0),
    'reassigned_pct', CASE WHEN COALESCE(v_total_offers,0) > 0 THEN ROUND((v_reassigned::numeric / v_total_offers) * 100, 2) ELSE NULL END,
    'timeline', COALESCE(v_timeline, '[]'::jsonb),
    'hourly_failures', COALESCE(v_hourly, '[]'::jsonb),
    'recent_failures', COALESCE(v_failed, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_dispatch_metrics(timestamptz, timestamptz, uuid, uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_dispatch_metrics(timestamptz, timestamptz, uuid, uuid, uuid) TO authenticated;
