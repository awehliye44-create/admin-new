-- Migration 20260916221500: race-safe PLATFORM_COLLECTED completion payment gate
-- Locks the trip row, rejects unresolved positive increments, and requires
-- protected hold >= committed customer payable (excludes tip / live waiting
-- that capture same-order-increments at settlement).
-- Rollback: rollback/rollback_20260916221500_completion_payment_gate_lock.sql
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
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INVALID_ARGS',
      'message', 'trip_id required'
    );
  END IF;

  -- Serialize vs claim_and_apply_fare_increase_modification (also FOR UPDATE trips).
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

  v_model := upper(trim(COALESCE(v_trip.financial_model, '')));
  IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'OK',
      'skipped', true,
      'reason', 'not_platform_collected'
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
    AND COALESCE(ps.purpose, '') IS DISTINCT FROM 'PAYMENT_RECOVERY'
  ORDER BY ps.created_at DESC
  LIMIT 1;

  v_protected := GREATEST(v_protected, COALESCE(v_session_auth, 0));

  -- Committed customer payable (booking + applied mods). Waiting/tip shortfalls
  -- are covered by revolutCompletionCapture same-order increment — not this gate.
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

COMMIT;
