-- Customer £Y deadline: expire-offers (enterDriverSecondChanceAtOriginalFare)
-- is the sole cron owner. SQL expire_stale_negotiations must not apply grace
-- (that path sent no Driver push and raced the Edge helper).
-- get_driver_pending_ride_offers keeps active negotiation rows retrievable
-- after the previous Customer deadline until second-chance stamps the new TTL.

CREATE OR REPLACE FUNCTION public.get_driver_pending_ride_offers()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'offer', row_to_json(ro)::jsonb,
      'trip', row_to_json(t)::jsonb
    )
    ORDER BY ro.created_at DESC
  ), '[]'::jsonb)
  FROM public.ride_offers ro
  INNER JOIN public.trips t ON t.id = ro.trip_id
  WHERE ro.driver_id = (SELECT d.id FROM public.drivers d WHERE d.user_id = auth.uid() LIMIT 1)
    AND ro.status IN ('pending', 'countered')
    AND (
      ro.expires_at > now()
      OR (
        ro.status = 'countered'
        AND ro.negotiation_status IN (
          'waiting_customer',
          'waiting_driver',
          'waiting_driver_final',
          'declined_customer_awaiting_driver'
        )
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.expire_stale_negotiations_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.ride_offers ro
    WHERE ro.negotiation_status IS NOT NULL
      AND ro.status IN ('pending', 'countered')
      AND (
        (
          ro.negotiation_expires_at IS NOT NULL
          AND ro.negotiation_expires_at <= now()
          AND ro.negotiation_status IS DISTINCT FROM 'waiting_customer'
        )
        OR (
          ro.negotiation_status = 'waiting_customer'
          AND ro.responded_at IS NOT NULL
          AND ro.responded_at < now() - interval '90 seconds'
        )
        OR (
          ro.driver_respond_by IS NOT NULL
          AND ro.driver_respond_by <= now()
          AND ro.negotiation_status IN ('waiting_driver', 'waiting_driver_final')
        )
        OR (
          ro.negotiation_status = 'declined_customer_awaiting_driver'
          AND ro.grace_window_expires_at IS NOT NULL
          AND ro.grace_window_expires_at <= now()
        )
      )
    LIMIT 1
  )
  OR EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.negotiation_status = 'active'
      AND t.status IN ('negotiating', 'searching', 'offered')
      AND t.negotiation_locked_until IS NOT NULL
      AND t.negotiation_locked_until <= now()
    LIMIT 1
  );
$function$;

CREATE OR REPLACE FUNCTION public.expire_stale_negotiations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_row record;
  v_processed int := 0;
  v_results jsonb := '[]'::jsonb;
  v_reason text;
  v_res jsonb;
BEGIN
  -- Customer £Y timeout (waiting_customer, responded_at IS NULL) is owned by
  -- expire-offers → enterDriverSecondChanceAtOriginalFare. Do not apply grace here.
  FOR v_row IN
    SELECT id, trip_id, driver_id, negotiation_status,
           customer_respond_by, driver_respond_by, grace_window_expires_at, responded_at
      FROM public.ride_offers
     WHERE status IN ('pending', 'countered')
       AND negotiation_status IN (
         'waiting_customer',
         'waiting_driver',
         'waiting_driver_final',
         'declined_customer_awaiting_driver'
       )
       AND (
         (negotiation_status = 'waiting_customer'
            AND responded_at IS NOT NULL
            AND responded_at < v_now - interval '90 seconds')
         OR (negotiation_status IN ('waiting_driver','waiting_driver_final')
            AND driver_respond_by IS NOT NULL AND driver_respond_by < v_now)
         OR (negotiation_status = 'declined_customer_awaiting_driver'
            AND grace_window_expires_at IS NOT NULL AND grace_window_expires_at < v_now)
       )
     ORDER BY updated_at ASC
     LIMIT 200
     FOR UPDATE SKIP LOCKED
  LOOP
    v_reason := CASE v_row.negotiation_status
      WHEN 'waiting_customer' THEN 'timeout_customer'
      WHEN 'waiting_driver'   THEN 'timeout_driver'
      WHEN 'waiting_driver_final' THEN 'timeout_driver'
      ELSE 'failed'
    END;
    v_res := public.finalize_negotiation_failure(
      v_row.trip_id,
      v_row.driver_id,
      v_row.id,
      'expired',
      v_reason
    );

    v_processed := v_processed + 1;
    v_results := v_results || jsonb_build_object(
      'offer_id', v_row.id,
      'trip_id', v_row.trip_id,
      'driver_id', v_row.driver_id,
      'prev_status', v_row.negotiation_status,
      'reason', v_reason,
      'result', v_res
    );

    PERFORM public.log_audit_event(
      'negotiation_timeout',
      NULL,
      v_row.driver_id,
      v_row.trip_id,
      jsonb_build_object(
        'offer_id', v_row.id,
        'reason', v_reason,
        'prev_negotiation_status', v_row.negotiation_status,
        'source', 'cron_sweep',
        'finalize_result', v_res,
        'expired_at', v_now
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'ran_at', v_now,
    'details', v_results
  );
END;
$function$;
