-- Customer non-accept of Driver £Y (Decline / ignore / timeout) enters the
-- existing declined_customer_awaiting_driver phase — Driver second chance at £X.
-- Uses Admin preset_offer_configs.countdown_seconds. Idempotent. No rematch.

CREATE OR REPLACE FUNCTION public.apply_customer_decline_grace(
  p_offer_id uuid,
  p_reason text DEFAULT 'decline'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_countdown integer;
  v_negotiation_expires_at timestamptz;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND');
  END IF;

  IF v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already', true,
      'grace_window_expires_at', v_offer.grace_window_expires_at,
      'negotiation_expires_at', v_offer.negotiation_expires_at,
      'reason', p_reason
    );
  END IF;

  IF v_offer.negotiation_status IS DISTINCT FROM 'waiting_customer' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_STATE',
      'negotiation_status', v_offer.negotiation_status
    );
  END IF;

  SELECT COALESCE(NULLIF(poc.countdown_seconds, 0), 30)
    INTO v_countdown
    FROM public.trips t
    LEFT JOIN public.preset_offer_configs poc
      ON poc.service_area_id = t.service_area_id
   WHERE t.id = v_offer.trip_id;

  IF v_countdown IS NULL OR v_countdown < 5 THEN
    v_countdown := 30;
  END IF;

  v_negotiation_expires_at := v_now + make_interval(secs => v_countdown);

  UPDATE public.ride_offers
  SET
    negotiation_status = 'declined_customer_awaiting_driver',
    responded_at = COALESCE(responded_at, v_now),
    customer_respond_by = NULL,
    driver_respond_by = v_negotiation_expires_at,
    grace_window_expires_at = v_negotiation_expires_at,
    negotiation_expires_at = v_negotiation_expires_at,
    expires_at = v_negotiation_expires_at,
    updated_at = v_now
  WHERE id = p_offer_id;

  UPDATE public.trips
  SET
    status = 'negotiating',
    dispatch_status = 'paused',
    broadcast_enabled = false,
    negotiation_owner_driver_id = v_offer.driver_id,
    current_offer_driver_id = v_offer.driver_id,
    current_negotiation_id = p_offer_id,
    negotiation_locked_until = v_negotiation_expires_at,
    updated_at = v_now
  WHERE id = v_offer.trip_id;

  RETURN jsonb_build_object(
    'success', true,
    'already', false,
    'grace_window_expires_at', v_negotiation_expires_at,
    'negotiation_expires_at', v_negotiation_expires_at,
    'countdown_seconds', v_countdown,
    'reason', p_reason
  );
END;
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
    IF v_row.negotiation_status = 'waiting_customer' AND v_row.responded_at IS NULL THEN
      v_res := public.apply_customer_decline_grace(v_row.id, 'timeout_customer');
      v_reason := 'timeout_customer_second_chance';
    ELSE
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
    END IF;

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
