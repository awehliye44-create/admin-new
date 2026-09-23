-- Fix: financial_model is service_area_financial_model enum —
-- COALESCE(v_trip.financial_model, '') casts '' to the enum and aborts apply.
-- Rollback: rollback/rollback_20261112191100_fix_financial_model_enum_coalesce.sql
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

  v_model := upper(trim(COALESCE(v_trip.financial_model::text, '')));
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
    AND ps.purpose IS DISTINCT FROM 'PAYMENT_RECOVERY'::public.payment_session_purpose
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

CREATE OR REPLACE FUNCTION public.enforce_trip_change_payment_before_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_committed int := 0;
  v_new int := 0;
  v_increase int := 0;
  v_required int := 0;
  v_protected int := 0;
  v_session_auth int := 0;
  v_model text;
  v_has_auth_evidence boolean := false;
BEGIN
  IF NEW.status IS DISTINCT FROM 'approved'
     AND NEW.status IS DISTINCT FROM 'applied' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = NEW.trip_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_model := upper(trim(COALESCE(v_trip.financial_model::text, '')));
  IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    RETURN NEW;
  END IF;

  v_committed := GREATEST(
    0,
    COALESCE(v_trip.final_customer_fare_pence, 0),
    COALESCE(v_trip.estimated_total_pence, 0),
    COALESCE(v_trip.locked_base_fare_pence, 0)
  );
  v_new := GREATEST(0, COALESCE(NEW.new_fare_pence, 0));
  v_increase := GREATEST(
    COALESCE(NEW.fare_delta_pence, 0),
    CASE WHEN v_new > 0 THEN GREATEST(0, v_new - v_committed) ELSE 0 END
  );

  IF v_increase <= 0 THEN
    RETURN NEW;
  END IF;

  IF lower(COALESCE(NEW.payment_status, '')) IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
      USING ERRCODE = 'P0001',
            DETAIL = 'cannot apply fare-increasing modification without confirmed payment';
  END IF;

  v_required := GREATEST(v_new, v_committed + v_increase);

  v_protected := GREATEST(0, COALESCE(v_trip.authorised_amount_pence, 0));

  SELECT GREATEST(
    0,
    COALESCE(ps.total_authorised_amount_pence, 0),
    COALESCE(ps.authorised_amount_pence, 0)
  )
  INTO v_session_auth
  FROM public.payment_sessions ps
  WHERE ps.trip_id = NEW.trip_id
    AND ps.purpose IS DISTINCT FROM 'PAYMENT_RECOVERY'::public.payment_session_purpose
  ORDER BY ps.created_at DESC
  LIMIT 1;

  v_protected := GREATEST(v_protected, COALESCE(v_session_auth, 0));

  SELECT EXISTS (
    SELECT 1
    FROM public.payment_session_authorisations psa
    WHERE psa.trip_change_request_id = NEW.id
      AND psa.status = 'ADDITIONAL_AUTHORISATION_CONFIRMED'
  )
  INTO v_has_auth_evidence;

  -- Fail closed unless hold covers revised payable AND (claim evidence OR
  -- already-covering hold when no increment was needed beyond existing auth).
  IF v_protected < v_required THEN
    RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'protected=%s required=%s — cannot apply unpaid fare increase',
              v_protected,
              v_required
            );
  END IF;

  -- When an increment was required above the prior committed basis, require
  -- claim/provider evidence row so a forged payment_status alone cannot apply.
  IF v_required > v_committed AND v_has_auth_evidence IS NOT TRUE THEN
    RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
      USING ERRCODE = 'P0001',
            DETAIL = 'missing ADDITIONAL_AUTHORISATION_CONFIRMED evidence for fare increase';
  END IF;

  RETURN NEW;
END;
$function$;



REVOKE ALL ON FUNCTION public.enforce_trip_change_payment_before_apply() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_trip_change_payment_before_apply() TO service_role;

COMMIT;
