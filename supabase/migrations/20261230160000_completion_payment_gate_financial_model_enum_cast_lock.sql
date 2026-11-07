-- MK-261106-004: completion payment gate crashed for every trip.
-- Cause: coalescing financial_model enum with an empty string literal forces
-- Postgres to cast '' to enum service_area_financial_model, which raises even
-- when financial_model is non-null PLATFORM_COLLECTED. Edge then returns
-- "Unable to verify trip payment protection before completion" (503).
-- Fix: cast enum → text before COALESCE (financial_model and payment_sessions.purpose).
-- Mid-trip recovery allow path uses payment_status + payment_hold_status only.

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

  IF COALESCE(v_unresolved, false) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED',
      'message', 'Trip has an unresolved customer payment increment; completion is blocked',
      'protected_pence', NULL,
      'required_pence', NULL
    );
  END IF;

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

  -- Mid-trip lost hold: journey may complete; payment remains recovery_required.
  -- Detect via payment_status + payment_hold_status only (trips has no metadata jsonb column).
  v_mid_trip_lost :=
    lower(COALESCE(v_trip.payment_status, '')) = 'recovery_required'
    AND lower(COALESCE(v_trip.payment_hold_status, '')) = 'payment_shortfall';

  IF v_mid_trip_lost THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'OK',
      'skipped', true,
      'reason', 'mid_trip_payment_auth_lost_recovery',
      'payment_unresolved', true,
      'protected_pence', 0,
      'required_pence', GREATEST(
        0,
        COALESCE(v_trip.final_customer_fare_pence, 0),
        COALESCE(v_trip.estimated_total_pence, 0),
        COALESCE(v_trip.locked_base_fare_pence, 0)
      )
    );
  END IF;

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

  IF v_required > 0 AND v_protected < v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED',
      'message', 'Protected customer payment is below the committed payable; completion is blocked',
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
  'Completion payment gate: unresolved fare-increase mods block; mid-trip auth-loss may complete; enum fields compared via ::text before empty-string coalesce.';

COMMIT;
