CREATE OR REPLACE FUNCTION public.recover_authorised_paid_booking_sessions(p_limit integer DEFAULT 25)
 RETURNS TABLE(payment_session_id uuid, provider_order_id text, result text, trip_id uuid, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ps RECORD;
  v_trip_id uuid;
  v_error text;
BEGIN
  FOR v_ps IN
    SELECT ps.id, ps.provider_order_id, ps.recovery_attempt_count
      FROM public.payment_sessions ps
     WHERE ps.payment_provider = 'revolut'
       AND ps.purpose = 'RIDE_BOOKING'
       AND ps.trip_id IS NULL
       AND UPPER(COALESCE(ps.provider_state,'')) IN ('AUTHORISED','COMPLETED')
       AND ps.status::text NOT IN ('cancelled','failed','payment_orphaned','orphan_authorisation')
       AND COALESCE(NULLIF(ps.booking_snapshot, '{}'::jsonb), NULLIF(ps.fare_snapshot, '{}'::jsonb)) IS NOT NULL
       AND ps.recovery_attempt_count < 5
     ORDER BY ps.created_at ASC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100))
  LOOP
    BEGIN
      UPDATE public.payment_sessions ps
         SET recovery_attempt_count = ps.recovery_attempt_count + 1,
             last_recovery_attempt_at = now(),
             status = CASE WHEN ps.status::text IN ('pending_payment','authorising') THEN 'payment_authorised'::public.payment_session_status ELSE ps.status END,
             metadata = COALESCE(ps.metadata, '{}'::jsonb) || jsonb_build_object('last_auto_recovery_started_at', now())
       WHERE ps.id = v_ps.id;

      v_trip_id := public.finalize_paid_booking_session(v_ps.id);

      INSERT INTO public.admin_payment_audit (action, provider, provider_payment_id, trip_id, metadata)
      VALUES ('authorised_session_auto_recovered', 'revolut', v_ps.provider_order_id, v_trip_id,
        jsonb_build_object('payment_session_id', v_ps.id, 'recovery_attempt', v_ps.recovery_attempt_count + 1, 'result', 'trip_created'));

      payment_session_id := v_ps.id;
      provider_order_id := v_ps.provider_order_id;
      result := 'trip_created';
      trip_id := v_trip_id;
      error := NULL;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      v_error := SQLERRM;
      UPDATE public.payment_sessions ps
         SET recovery_attempt_count = ps.recovery_attempt_count + 1,
             last_recovery_attempt_at = now(),
             metadata = COALESCE(ps.metadata, '{}'::jsonb) || jsonb_build_object('last_auto_recovery_error', v_error, 'last_auto_recovery_error_at', now())
       WHERE ps.id = v_ps.id;

      INSERT INTO public.admin_payment_audit (action, provider, provider_payment_id, trip_id, metadata)
      VALUES ('authorised_session_auto_recovery_failed', 'revolut', v_ps.provider_order_id, NULL,
        jsonb_build_object('payment_session_id', v_ps.id, 'recovery_attempt', v_ps.recovery_attempt_count + 1, 'error', v_error));

      payment_session_id := v_ps.id;
      provider_order_id := v_ps.provider_order_id;
      result := 'failed';
      trip_id := NULL;
      error := v_error;
      RETURN NEXT;
    END;
  END LOOP;
END;
$function$;