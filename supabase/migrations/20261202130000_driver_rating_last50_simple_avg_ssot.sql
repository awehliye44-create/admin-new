-- Driver customer rating SSOT: simple average of last 50 trip ratings.
-- Replaces Bayesian display_rating ((5×20)+sum)/(20+count) which rounded to 5.0
-- at 1dp while Driver Standards showed last-50 at 2dp (e.g. MK0007 4.86).
-- Formula matches get_driver_standards rating window (completed trip feedback,
-- rating 1–5, exclude flagged). Rating skips (dismissed) remain included so
-- header/sidebar match the Profile Standards number Drivers already see.

CREATE OR REPLACE FUNCTION public.recalculate_driver_display_rating(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_window constant integer := 50;
  v_sum numeric := 0;
  v_count integer := 0;
  v_display numeric := 5.0;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(x.rating), 0)::numeric,
    COALESCE(COUNT(x.rating), 0)::integer
  INTO v_sum, v_count
  FROM (
    SELECT rf.rating
    FROM public.rider_feedback rf
    INNER JOIN public.trips t ON t.id = rf.trip_id
    WHERE rf.driver_id = p_driver_id
      AND rf.feedback_type = 'trip'
      AND t.status = 'completed'
      AND rf.rating BETWEEN 1 AND 5
      AND rf.status IS DISTINCT FROM 'flagged'
    ORDER BY rf.created_at DESC
    LIMIT v_window
  ) x;

  IF v_count > 0 THEN
    v_display := ROUND((v_sum / v_count::numeric), 2);
  ELSE
    v_display := 5.0;
  END IF;

  UPDATE public.drivers
  SET
    rating_sum = v_sum,
    rating_count = v_count,
    display_rating = v_display,
    rating = v_display,
    updated_at = now()
  WHERE id = p_driver_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_display_rating(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_driver_standards(p_driver_id uuid, p_period_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_authorized boolean := false;
  v_period_days integer;
  v_period_start timestamptz;
  v_period_end timestamptz := now();
  v_rating_window constant integer := 50;
  v_min_offers constant integer := 5;
  v_min_accepted_trips constant integer := 5;
  v_pickup_prompt_seconds constant integer := 300;
  v_on_time_grace_seconds constant integer := 300;

  v_total_offers integer := 0;
  v_accepted_offers integer := 0;
  v_accepted_trips integer := 0;
  v_completed_trips integer := 0;
  v_driver_cancelled_trips integer := 0;
  v_pickup_reliable_trips integer := 0;
  v_on_time_arrivals integer := 0;

  v_acceptance_rate numeric;
  v_cancellation_rate numeric;
  v_completion_rate numeric;
  v_pickup_reliability_rate numeric;
  v_on_time_arrival_rate numeric;

  v_average_rating numeric := 0;
  v_rating_count integer := 0;
  v_rating_breakdown jsonb := '{}'::jsonb;
  v_customer_feedback_tags jsonb := '[]'::jsonb;
  v_performance_trend jsonb := '[]'::jsonb;
  v_recent_activity jsonb := '[]'::jsonb;
  v_commitment_warnings jsonb := '[]'::jsonb;
  v_commitment_warning_count integer := 0;

  v_driver_status text := 'needs_improvement';
  v_warning_banner jsonb := NULL;
  v_last_updated_at timestamptz;
BEGIN
  IF v_user_id IS NULL AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  v_period_days := GREATEST(1, LEAST(COALESCE(p_period_days, 30), 365));
  v_period_start := v_period_end - (v_period_days || ' days')::interval;

  SELECT EXISTS (
    SELECT 1 FROM public.drivers d WHERE d.id = p_driver_id AND d.user_id = v_user_id
  ) OR public.has_role(v_user_id, 'admin'::app_role)
  OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role'
  INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = p_driver_id) THEN
    RAISE EXCEPTION 'Driver not found' USING ERRCODE = 'P0002';
  END IF;

  -- Offer acceptance (period window by offered_at).
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE ro.status = 'accepted')::integer
  INTO v_total_offers, v_accepted_offers
  FROM public.ride_offers ro
  WHERE ro.driver_id = p_driver_id
    AND ro.offered_at >= v_period_start
    AND ro.offered_at < v_period_end;

  -- Accepted trips in period (by offer accept time).
  WITH accepted AS (
    SELECT
      ro.id AS offer_id,
      ro.trip_id,
      ro.responded_at AS accepted_at,
      ro.eta_seconds,
      t.started_at,
      t.status AS trip_status,
      COALESCE(ts.arrived_at, t.pickup_arrived_at, t.arrived_at) AS pickup_at,
      (
        t.status = 'completed'
      ) AS is_completed,
      (
        t.cancel_reason IN (
          'driver_cancelled',
          'driver_cancelled_before_pickup',
          'driver_cancelled_negotiation'
        )
        OR t.cancelled_by = 'driver'
        OR t.cancelled_by_role = 'driver'
        OR t.status = 'driver_cancelled'
      ) AS is_driver_cancelled,
      (
        COALESCE(t.driver_started_journey_to_pickup_at, t.started_at) IS NOT NULL
        AND ro.responded_at IS NOT NULL
        AND EXTRACT(EPOCH FROM (
          COALESCE(t.driver_started_journey_to_pickup_at, t.started_at) - ro.responded_at
        )) <= v_pickup_prompt_seconds
        AND NOT EXISTS (
          SELECT 1 FROM public.driver_commitment_warnings dcw
          WHERE dcw.trip_id = ro.trip_id
        )
      ) AS started_promptly,
      (
        COALESCE(ts.arrived_at, t.pickup_arrived_at, t.arrived_at) IS NOT NULL
        AND ro.eta_seconds IS NOT NULL
        AND COALESCE(ts.arrived_at, t.pickup_arrived_at, t.arrived_at)
          <= (
            COALESCE(t.driver_started_journey_to_pickup_at, t.started_at, ro.responded_at)
            + (ro.eta_seconds * INTERVAL '1 second')
            + (v_on_time_grace_seconds * INTERVAL '1 second')
          )
      ) AS arrived_on_time
    FROM public.ride_offers ro
    INNER JOIN public.trips t ON t.id = ro.trip_id
    LEFT JOIN public.trip_stops ts
      ON ts.trip_id = t.id AND ts.type = 'pickup' AND ts.stop_index = 0
    WHERE ro.driver_id = p_driver_id
      AND ro.status = 'accepted'
      AND ro.responded_at >= v_period_start
      AND ro.responded_at < v_period_end
  )
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE is_completed)::integer,
    COUNT(*) FILTER (WHERE is_driver_cancelled)::integer,
    COUNT(*) FILTER (WHERE started_promptly)::integer,
    COUNT(*) FILTER (WHERE arrived_on_time)::integer
  INTO
    v_accepted_trips,
    v_completed_trips,
    v_driver_cancelled_trips,
    v_pickup_reliable_trips,
    v_on_time_arrivals
  FROM accepted;

  IF v_total_offers >= v_min_offers THEN
    v_acceptance_rate := ROUND((v_accepted_offers::numeric / v_total_offers::numeric) * 100, 1);
  END IF;

  IF v_accepted_trips >= v_min_accepted_trips THEN
    v_cancellation_rate := ROUND((v_driver_cancelled_trips::numeric / v_accepted_trips::numeric) * 100, 1);
    v_completion_rate := ROUND((v_completed_trips::numeric / v_accepted_trips::numeric) * 100, 1);
    v_pickup_reliability_rate := ROUND((v_pickup_reliable_trips::numeric / v_accepted_trips::numeric) * 100, 1);
    v_on_time_arrival_rate := ROUND((v_on_time_arrivals::numeric / v_accepted_trips::numeric) * 100, 1);
  END IF;

  -- Customer rating: last 50 completed-trip ratings (not limited to period).
  WITH recent_ratings AS (
    SELECT rf.rating, rf.comment, rf.created_at
    FROM public.rider_feedback rf
    INNER JOIN public.trips t ON t.id = rf.trip_id
    WHERE rf.driver_id = p_driver_id
      AND rf.feedback_type = 'trip'
      AND t.status = 'completed'
      AND rf.rating BETWEEN 1 AND 5
      AND rf.status IS DISTINCT FROM 'flagged'
    ORDER BY rf.created_at DESC
    LIMIT v_rating_window
  )
  SELECT
    COUNT(*)::integer,
    COALESCE(ROUND(AVG(rating)::numeric, 2), 0)
  INTO v_rating_count, v_average_rating
  FROM recent_ratings;

  WITH recent_ratings AS (
    SELECT rf.rating
    FROM public.rider_feedback rf
    INNER JOIN public.trips t ON t.id = rf.trip_id
    WHERE rf.driver_id = p_driver_id
      AND rf.feedback_type = 'trip'
      AND t.status = 'completed'
      AND rf.rating BETWEEN 1 AND 5
      AND rf.status IS DISTINCT FROM 'flagged'
    ORDER BY rf.created_at DESC
    LIMIT v_rating_window
  )
  SELECT COALESCE(jsonb_object_agg(star::text, cnt), '{}'::jsonb)
  INTO v_rating_breakdown
  FROM (
    SELECT s.star, COALESCE(c.cnt, 0) AS cnt
    FROM generate_series(1, 5) AS s(star)
    LEFT JOIN (
      SELECT rating AS star, COUNT(*)::integer AS cnt
      FROM recent_ratings
      GROUP BY rating
    ) c ON c.star = s.star
    ORDER BY s.star DESC
  ) dist;

  -- Customer feedback tags (period window, real tags only).
  WITH feedback_in_period AS (
    SELECT rf.rating, rf.comment
    FROM public.rider_feedback rf
    INNER JOIN public.trips t ON t.id = rf.trip_id
    WHERE rf.driver_id = p_driver_id
      AND rf.feedback_type = 'trip'
      AND t.status = 'completed'
      AND rf.created_at >= v_period_start
      AND rf.created_at < v_period_end
      AND rf.rating BETWEEN 1 AND 5
  ),
  tag_rows AS (
    SELECT
      CASE btrim(tag.token)
        WHEN 'Great service' THEN 'Excellent service'
        WHEN 'Clean car' THEN 'Clean car'
        WHEN 'Good route' THEN 'Smooth journey'
        WHEN 'Punctual' THEN 'Punctual arrival'
        WHEN 'Safe driving' THEN 'Safe driving'
        WHEN 'Driver behaviour' THEN 'Communication issues'
        WHEN 'Pickup issue' THEN 'Late pickup'
        WHEN 'Unsafe driving' THEN 'Unsafe driving'
        WHEN 'Car quality' THEN 'Vehicle quality'
        WHEN 'Overcharged' THEN 'Fare concerns'
        WHEN 'Safety concern' THEN 'Safety concerns'
        WHEN 'Off-app payment request' THEN 'Payment process'
        WHEN 'Bad odour' THEN 'Vehicle cleanliness'
        WHEN 'Car cleanliness' THEN 'Vehicle cleanliness'
        ELSE btrim(tag.token)
      END AS tag_label,
      COUNT(*)::integer AS cnt
    FROM feedback_in_period f
    CROSS JOIN LATERAL (
      SELECT unnest(
        string_to_array(
          CASE
            WHEN f.comment IS NULL OR btrim(f.comment) = '' THEN ''
            WHEN position(' — ' IN f.comment) > 0 THEN split_part(f.comment, ' — ', 1)
            ELSE f.comment
          END,
          ','
        )
      ) AS token
    ) tag
    WHERE btrim(tag.token) <> ''
      AND btrim(tag.token) = ANY (ARRAY[
        'Great service', 'Clean car', 'Good route', 'Punctual', 'Safe driving',
        'Unsafe driving', 'Driver behaviour', 'Car quality', 'Overcharged',
        'Safety concern', 'Pickup issue', 'Off-app payment request', 'Bad odour', 'Car cleanliness'
      ])
    GROUP BY 1
  )
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object('tag', tag_label, 'count', cnt) ORDER BY cnt DESC),
    '[]'::jsonb
  )
  INTO v_customer_feedback_tags
  FROM tag_rows;

  -- Performance trend buckets.
  IF v_period_days <= 30 THEN
    WITH buckets AS (
      SELECT generate_series(
        date_trunc('day', v_period_start),
        date_trunc('day', v_period_end - INTERVAL '1 day'),
        INTERVAL '1 day'
      ) AS bucket_start
    ),
    daily AS (
      SELECT
        b.bucket_start,
        COUNT(ro.id)::integer AS total_offers,
        COUNT(ro.id) FILTER (WHERE ro.status = 'accepted')::integer AS accepted_offers,
        COUNT(ro.id) FILTER (
          WHERE ro.status = 'accepted'
            AND COALESCE(t.driver_started_journey_to_pickup_at, t.started_at) IS NOT NULL
            AND ro.responded_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (
              COALESCE(t.driver_started_journey_to_pickup_at, t.started_at) - ro.responded_at
            )) <= v_pickup_prompt_seconds
            AND NOT EXISTS (
              SELECT 1 FROM public.driver_commitment_warnings dcw
              WHERE dcw.trip_id = ro.trip_id
            )
        )::integer AS pickup_reliable,
        COUNT(ro.id) FILTER (
          WHERE ro.status = 'accepted'
            AND COALESCE(ts.arrived_at, t.pickup_arrived_at, t.arrived_at) IS NOT NULL
            AND ro.eta_seconds IS NOT NULL
            AND COALESCE(ts.arrived_at, t.pickup_arrived_at, t.arrived_at)
              <= (
                COALESCE(t.driver_started_journey_to_pickup_at, t.started_at, ro.responded_at)
                + (ro.eta_seconds * INTERVAL '1 second')
                + (v_on_time_grace_seconds * INTERVAL '1 second')
              )
        )::integer AS on_time,
        COUNT(ro.id) FILTER (
          WHERE ro.status = 'accepted'
            AND (
              t.cancel_reason IN (
                'driver_cancelled',
                'driver_cancelled_before_pickup',
                'driver_cancelled_negotiation'
              )
              OR t.cancelled_by = 'driver'
              OR t.cancelled_by_role = 'driver'
              OR t.status = 'driver_cancelled'
            )
        )::integer AS driver_cancelled
      FROM buckets b
      LEFT JOIN public.ride_offers ro
        ON ro.driver_id = p_driver_id
       AND ro.responded_at >= b.bucket_start
       AND ro.responded_at < b.bucket_start + INTERVAL '1 day'
      LEFT JOIN public.trips t ON t.id = ro.trip_id
      LEFT JOIN public.trip_stops ts
        ON ts.trip_id = t.id AND ts.type = 'pickup' AND ts.stop_index = 0
      GROUP BY b.bucket_start
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'date', to_char(bucket_start, 'YYYY-MM-DD'),
          'acceptance_rate',
            CASE WHEN total_offers >= 3
              THEN ROUND((accepted_offers::numeric / total_offers::numeric) * 100, 1)
              ELSE NULL END,
          'pickup_reliability_rate',
            CASE WHEN accepted_offers >= 3
              THEN ROUND((pickup_reliable::numeric / accepted_offers::numeric) * 100, 1)
              ELSE NULL END,
          'on_time_arrival_rate',
            CASE WHEN accepted_offers >= 3
              THEN ROUND((on_time::numeric / accepted_offers::numeric) * 100, 1)
              ELSE NULL END,
          'cancellation_rate',
            CASE WHEN accepted_offers >= 3
              THEN ROUND((driver_cancelled::numeric / accepted_offers::numeric) * 100, 1)
              ELSE NULL END
        )
        ORDER BY bucket_start
      ),
      '[]'::jsonb
    )
    INTO v_performance_trend
    FROM daily;
  ELSE
    WITH buckets AS (
      SELECT generate_series(
        date_trunc('week', v_period_start),
        date_trunc('week', v_period_end),
        INTERVAL '1 week'
      ) AS bucket_start
    ),
    weekly AS (
      SELECT
        b.bucket_start,
        COUNT(ro.id)::integer AS total_offers,
        COUNT(ro.id) FILTER (WHERE ro.status = 'accepted')::integer AS accepted_offers,
        COUNT(ro.id) FILTER (
          WHERE ro.status = 'accepted'
            AND COALESCE(t.driver_started_journey_to_pickup_at, t.started_at) IS NOT NULL
            AND ro.responded_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (
              COALESCE(t.driver_started_journey_to_pickup_at, t.started_at) - ro.responded_at
            )) <= v_pickup_prompt_seconds
            AND NOT EXISTS (
              SELECT 1 FROM public.driver_commitment_warnings dcw
              WHERE dcw.trip_id = ro.trip_id
            )
        )::integer AS pickup_reliable,
        COUNT(ro.id) FILTER (
          WHERE ro.status = 'accepted'
            AND COALESCE(ts.arrived_at, t.pickup_arrived_at, t.arrived_at) IS NOT NULL
            AND ro.eta_seconds IS NOT NULL
            AND COALESCE(ts.arrived_at, t.pickup_arrived_at, t.arrived_at)
              <= (
                COALESCE(t.driver_started_journey_to_pickup_at, t.started_at, ro.responded_at)
                + (ro.eta_seconds * INTERVAL '1 second')
                + (v_on_time_grace_seconds * INTERVAL '1 second')
              )
        )::integer AS on_time,
        COUNT(ro.id) FILTER (
          WHERE ro.status = 'accepted'
            AND (
              t.cancel_reason IN (
                'driver_cancelled',
                'driver_cancelled_before_pickup',
                'driver_cancelled_negotiation'
              )
              OR t.cancelled_by = 'driver'
              OR t.cancelled_by_role = 'driver'
              OR t.status = 'driver_cancelled'
            )
        )::integer AS driver_cancelled
      FROM buckets b
      LEFT JOIN public.ride_offers ro
        ON ro.driver_id = p_driver_id
       AND ro.responded_at >= b.bucket_start
       AND ro.responded_at < b.bucket_start + INTERVAL '1 week'
      LEFT JOIN public.trips t ON t.id = ro.trip_id
      LEFT JOIN public.trip_stops ts
        ON ts.trip_id = t.id AND ts.type = 'pickup' AND ts.stop_index = 0
      GROUP BY b.bucket_start
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'date', to_char(bucket_start, 'YYYY-MM-DD'),
          'acceptance_rate',
            CASE WHEN total_offers >= 3
              THEN ROUND((accepted_offers::numeric / total_offers::numeric) * 100, 1)
              ELSE NULL END,
          'pickup_reliability_rate',
            CASE WHEN accepted_offers >= 3
              THEN ROUND((pickup_reliable::numeric / accepted_offers::numeric) * 100, 1)
              ELSE NULL END,
          'on_time_arrival_rate',
            CASE WHEN accepted_offers >= 3
              THEN ROUND((on_time::numeric / accepted_offers::numeric) * 100, 1)
              ELSE NULL END,
          'cancellation_rate',
            CASE WHEN accepted_offers >= 3
              THEN ROUND((driver_cancelled::numeric / accepted_offers::numeric) * 100, 1)
              ELSE NULL END
        )
        ORDER BY bucket_start
      ),
      '[]'::jsonb
    )
    INTO v_performance_trend
    FROM weekly;
  END IF;

  -- Recent performance activity.
  WITH activity AS (
    SELECT t.completed_at AS at, 'trip_completed'::text AS kind, 'Trip completed'::text AS label
    FROM public.trips t
    WHERE t.driver_id = p_driver_id
      AND t.status = 'completed'
      AND t.completed_at >= v_period_start
      AND t.completed_at < v_period_end

    UNION ALL

    SELECT rf.created_at AS at,
      'new_rating'::text AS kind,
      ('New ' || rf.rating::text || ' star rating')::text AS label
    FROM public.rider_feedback rf
    INNER JOIN public.trips t ON t.id = rf.trip_id
    WHERE rf.driver_id = p_driver_id
      AND rf.feedback_type = 'trip'
      AND t.status = 'completed'
      AND rf.created_at >= v_period_start
      AND rf.created_at < v_period_end

    UNION ALL

    SELECT COALESCE(t.cancelled_at, t.updated_at) AS at,
      'trip_cancelled'::text AS kind,
      'Trip cancelled by driver'::text AS label
    FROM public.trips t
    WHERE t.driver_id = p_driver_id
      AND (
        t.cancel_reason IN (
          'driver_cancelled',
          'driver_cancelled_before_pickup',
          'driver_cancelled_negotiation'
        )
        OR t.cancelled_by = 'driver'
        OR t.cancelled_by_role = 'driver'
        OR t.status = 'driver_cancelled'
      )
      AND COALESCE(t.cancelled_at, t.updated_at) >= v_period_start
      AND COALESCE(t.cancelled_at, t.updated_at) < v_period_end

    UNION ALL

    SELECT cw.created_at AS at,
      'commitment_warning'::text AS kind,
      ('Commitment warning: ' || cw.message)::text AS label
    FROM public.driver_commitment_warnings cw
    WHERE cw.driver_id = p_driver_id
      AND cw.created_at >= v_period_start
      AND cw.created_at < v_period_end
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'at', at,
        'kind', kind,
        'label', label
      )
      ORDER BY at DESC
    ),
    '[]'::jsonb
  )
  INTO v_recent_activity
  FROM (SELECT * FROM activity ORDER BY at DESC LIMIT 20) recent;

  SELECT COUNT(*)::integer
  INTO v_commitment_warning_count
  FROM public.driver_commitment_warnings cw
  WHERE cw.driver_id = p_driver_id
    AND cw.created_at >= v_period_start
    AND cw.created_at < v_period_end;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'at', cw.created_at,
        'warning_type', cw.warning_type,
        'message', cw.message,
        'trip_id', cw.trip_id
      )
      ORDER BY cw.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_commitment_warnings
  FROM (
    SELECT created_at, warning_type, message, trip_id
    FROM public.driver_commitment_warnings
    WHERE driver_id = p_driver_id
      AND created_at >= v_period_start
      AND created_at < v_period_end
    ORDER BY created_at DESC
    LIMIT 20
  ) cw;

  -- Driver status thresholds.
  IF v_rating_count >= 1
     AND v_accepted_trips >= v_min_accepted_trips
     AND v_total_offers >= v_min_offers THEN
    IF v_cancellation_rate > 15
       OR v_average_rating < 4.0
       OR v_acceptance_rate < 70 THEN
      v_driver_status := 'at_risk';
    ELSIF v_average_rating >= 4.8
      AND v_cancellation_rate <= 7
      AND v_acceptance_rate >= 90 THEN
      v_driver_status := 'excellent';
    ELSIF v_average_rating >= 4.5 AND v_cancellation_rate <= 12 THEN
      v_driver_status := 'good';
    ELSE
      v_driver_status := 'needs_improvement';
    END IF;
  ELSIF v_rating_count = 0 AND v_accepted_trips < v_min_accepted_trips THEN
    v_driver_status := 'needs_improvement';
  END IF;

  -- Smart warning banner (real triggers only).
  IF v_accepted_trips >= v_min_accepted_trips THEN
    IF v_pickup_reliability_rate IS NOT NULL AND v_pickup_reliability_rate < 80 THEN
      v_warning_banner := jsonb_build_object(
        'code', 'heading_to_pickup',
        'title', 'Keep heading to the pickup location',
        'message', 'Customers appreciate drivers who start driving towards the pickup right after accepting.'
      );
    ELSIF v_cancellation_rate IS NOT NULL AND v_cancellation_rate > 12 THEN
      v_warning_banner := jsonb_build_object(
        'code', 'reduce_cancellations',
        'title', 'Reduce cancellations',
        'message', 'High cancellation rates can affect your access to trips and your driver status.'
      );
    ELSIF v_on_time_arrival_rate IS NOT NULL AND v_on_time_arrival_rate < 85 THEN
      v_warning_banner := jsonb_build_object(
        'code', 'improve_arrival',
        'title', 'Improve pickup arrival time',
        'message', 'Arriving within the expected pickup window helps keep customers happy and improves your standards.'
      );
    END IF;
  END IF;

  v_last_updated_at := date_trunc('day', v_period_end);

  RETURN jsonb_build_object(
    'driver_id', p_driver_id,
    'period_days', v_period_days,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'average_rating', CASE WHEN v_rating_count > 0 THEN v_average_rating ELSE NULL END,
    'rating_count', v_rating_count,
    'rating_window_size', v_rating_window,
    'rating_breakdown', v_rating_breakdown,
    'acceptance_rate', v_acceptance_rate,
    'accepted_offers', v_accepted_offers,
    'total_offers', v_total_offers,
    'cancellation_rate', v_cancellation_rate,
    'driver_cancelled_trips', v_driver_cancelled_trips,
    'accepted_trips', v_accepted_trips,
    'completion_rate', v_completion_rate,
    'completed_trips', v_completed_trips,
    'pickup_reliability_rate', v_pickup_reliability_rate,
    'pickup_reliable_trips', v_pickup_reliable_trips,
    'on_time_arrival_rate', v_on_time_arrival_rate,
    'on_time_arrivals', v_on_time_arrivals,
    'customer_feedback_tags', v_customer_feedback_tags,
    'performance_trend', v_performance_trend,
    'recent_activity', v_recent_activity,
    'commitment_warnings', v_commitment_warnings,
    'commitment_warning_count', v_commitment_warning_count,
    'driver_status', v_driver_status,
    'warning_banner', v_warning_banner,
    'last_updated_at', v_last_updated_at,
    'metrics_refresh_note', 'Metrics update every 24 hours',
    'min_offers_for_rates', v_min_offers,
    'min_accepted_trips_for_rates', v_min_accepted_trips
  );
END;
$function$;

-- Backfill every driver from the new last-50 SSOT.
DO $backfill$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM public.drivers LOOP
    PERFORM public.recalculate_driver_display_rating(r.id);
  END LOOP;
END;
$backfill$;
