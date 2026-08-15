-- MK-260815-020: SQL cron_sweep rematched waiting_customer after a timely
-- Customer tap because expire_stale_negotiations ignored ride_offers.responded_at.
-- JS expire-offers already skips in-flight holds; this is the SQL twin.
-- No new column. Abandoned holds still expire after 90s.

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
        (ro.negotiation_expires_at IS NOT NULL AND ro.negotiation_expires_at <= now())
        OR (
          ro.customer_respond_by IS NOT NULL
          AND ro.customer_respond_by <= now()
          AND NOT (
            ro.negotiation_status = 'waiting_customer'
            AND ro.responded_at IS NOT NULL
            AND ro.responded_at > now() - interval '90 seconds'
          )
        )
        OR (ro.driver_respond_by IS NOT NULL AND ro.driver_respond_by <= now())
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
  FOR v_row IN
    SELECT id, trip_id, driver_id, negotiation_status,
           customer_respond_by, driver_respond_by, grace_window_expires_at
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
            AND customer_respond_by IS NOT NULL AND customer_respond_by < v_now
            AND responded_at IS NULL)
         OR (negotiation_status = 'waiting_customer'
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
