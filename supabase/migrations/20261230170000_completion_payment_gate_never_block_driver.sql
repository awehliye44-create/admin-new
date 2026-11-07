-- Driver Complete Trip must never be blocked by payment protection shortfalls.
-- Under-protected / unresolved fare-increase → stamp recovery_required and
-- allow completion (same posture as mid-trip auth-loss). Capture/support
-- still chase the money; the driver is not stranded at drop-off.

BEGIN;

CREATE OR REPLACE FUNCTION public.assert_trip_completion_customer_payment_gate(
  p_trip_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_unresolved boolean;
  v_model text;
  v_protected int := 0;
  v_required int := 0;
  v_session_auth int := 0;
  v_mid_trip_lost boolean := false;
  v_allow_reason text := null;
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INVALID_ARGS',
      'message', 'trip_id required'
    );
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'TRIP_NOT_FOUND',
      'message', 'Trip not found'
    );
  END IF;

  SELECT public.trip_has_unresolved_fare_increase_modification(p_trip_id)
    INTO v_unresolved;

  -- Enum columns must be cast to text before coalescing with ''.
  v_model := upper(trim(COALESCE(v_trip.financial_model::text, '')));
  IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'OK',
      'skipped', true,
      'reason', 'not_platform_collected'
    );
  END IF;

  v_mid_trip_lost :=
    lower(COALESCE(v_trip.payment_status, '')) = 'recovery_required'
    AND lower(COALESCE(v_trip.payment_hold_status, '')) = 'payment_shortfall';

  v_protected := GREATEST(
    0,
    COALESCE(v_trip.authorised_amount_pence, 0)
  );

  SELECT GREATEST(
    0,
    COALESCE(ps.total_authorised_amount_pence, 0),
    COALESCE(ps.authorised_amount_pence, 0)
  )
  INTO v_session_auth
  FROM public.payment_sessions ps
  WHERE ps.trip_id = p_trip_id
    AND COALESCE(ps.purpose::text, '') IS DISTINCT FROM 'PAYMENT_RECOVERY'
  ORDER BY ps.created_at DESC
  LIMIT 1;

  v_protected := GREATEST(v_protected, COALESCE(v_session_auth, 0));

  v_required := GREATEST(
    0,
    COALESCE(v_trip.final_customer_fare_pence, 0),
    COALESCE(v_trip.estimated_total_pence, 0),
    COALESCE(v_trip.locked_base_fare_pence, 0)
  );

  IF COALESCE(v_unresolved, false) THEN
    v_allow_reason := 'unresolved_fare_increase_allow_complete';
  ELSIF v_mid_trip_lost THEN
    v_allow_reason := 'mid_trip_payment_auth_lost_recovery';
  ELSIF v_required > 0 AND v_protected < v_required THEN
    v_allow_reason := 'under_protected_allow_complete';
  END IF;

  IF v_allow_reason IS NOT NULL THEN
    -- Stamp recovery so support/capture see the shortfall; never block Complete.
    UPDATE public.trips
    SET payment_status = 'recovery_required',
        payment_hold_status = CASE
          WHEN lower(COALESCE(payment_hold_status, '')) IN ('payment_shortfall', 'lost')
            THEN payment_hold_status
          ELSE 'payment_shortfall'
        END,
        payment_coverage_status = 'recovery_required',
        updated_at = now()
    WHERE id = p_trip_id
      AND lower(COALESCE(payment_status, '')) IS DISTINCT FROM 'paid'
      AND lower(COALESCE(payment_status, '')) IS DISTINCT FROM 'captured'
      AND lower(COALESCE(payment_status, '')) IS DISTINCT FROM 'completed';

    RETURN jsonb_build_object(
      'ok', true,
      'code', 'OK',
      'skipped', true,
      'reason', v_allow_reason,
      'payment_unresolved', true,
      'protected_pence', v_protected,
      'required_pence', v_required
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'protected_pence', v_protected,
    'required_pence', v_required
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_trip_completion_customer_payment_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_trip_completion_customer_payment_gate(uuid) TO service_role;

COMMENT ON FUNCTION public.assert_trip_completion_customer_payment_gate(uuid) IS
  'Driver completion never blocked by payment shortfall/unresolved mod — stamps recovery_required and returns ok. Enum fields compared via ::text.';

COMMIT;
