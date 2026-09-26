-- Fix: purpose is payment_session_purpose enum — COALESCE(ps.purpose, '')
-- casts '' to the enum and aborts claim/apply/completion gates.
-- Rollback: rollback/rollback_20261112191000_fix_payment_session_purpose_enum_filter.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_and_apply_fare_increase_modification(
  p_trip_id uuid,
  p_request_id uuid,
  p_expected_original_fare_pence integer,
  p_expected_trip_status text,
  p_required_authorised_total_pence integer,
  p_provider_confirmed boolean,
  p_authorised_total_pence integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_req public.trip_change_requests%ROWTYPE;
  v_advanced public.trip_change_requests%ROWTYPE;
  v_claimed int;
  v_current_fare int;
  v_expected_status text;
  v_required int;
  v_authorised int;
  v_session_id uuid;
  v_order_id text;
  v_auth_inserted int := 0;
  v_auth_attached int := 0;
  v_event_inserted int := 0;
  v_has_auth_evidence boolean := false;
BEGIN
  v_expected_status := lower(trim(COALESCE(p_expected_trip_status, '')));
  v_required := GREATEST(0, COALESCE(p_required_authorised_total_pence, 0));
  v_authorised := GREATEST(0, COALESCE(p_authorised_total_pence, 0));

  IF p_trip_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGS'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001', DETAIL = 'trip_not_found';
  END IF;

  SELECT * INTO v_req
  FROM public.trip_change_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001', DETAIL = 'request_not_found';
  END IF;

  IF v_req.trip_id IS DISTINCT FROM p_trip_id THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001', DETAIL = 'trip_request_mismatch';
  END IF;

  IF v_req.status = 'applied' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'ALREADY_APPLIED',
      'request_id', v_req.id,
      'trip_id', v_trip.id,
      'fare_delta_pence', COALESCE(v_req.fare_delta_pence, 0),
      'final_customer_fare_pence', v_trip.final_customer_fare_pence
    );
  END IF;

  IF COALESCE(v_req.fare_delta_pence, 0) <= 0 THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001', DETAIL = 'not_a_fare_increase';
  END IF;

  IF p_provider_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'PAYMENT_NOT_CONFIRMED'
      USING ERRCODE = 'P0001', DETAIL = 'provider_not_confirmed';
  END IF;

  IF v_authorised < v_required OR v_required <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_NOT_CONFIRMED'
      USING ERRCODE = 'P0001',
            DETAIL = format('authorised=%s required=%s', v_authorised, v_required);
  END IF;

  IF lower(COALESCE(v_trip.status, '')) IS DISTINCT FROM v_expected_status THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001',
            DETAIL = format('trip_status=%s expected=%s', v_trip.status, v_expected_status);
  END IF;

  v_current_fare := COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.gross_fare_pence, 0),
    0
  );

  IF v_current_fare IS DISTINCT FROM COALESCE(p_expected_original_fare_pence, -1) THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001',
            DETAIL = format('fare=%s expected=%s', v_current_fare, p_expected_original_fare_pence);
  END IF;

  IF COALESCE(v_req.original_fare_pence, -1)
       IS DISTINCT FROM COALESCE(p_expected_original_fare_pence, -2) THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001', DETAIL = 'original_fare_mismatch';
  END IF;

  UPDATE public.trip_change_requests
  SET payment_status = 'confirmed',
      payment_confirmed_at = COALESCE(payment_confirmed_at, now()),
      status = 'payment_confirmed',
      updated_at = now(),
      rejection_reason = NULL
  WHERE id = p_request_id
    AND status IN ('payment_required', 'payment_pending', 'payment_confirmed')
    AND COALESCE(fare_delta_pence, 0) > 0
  RETURNING * INTO v_req;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT * INTO v_req FROM public.trip_change_requests WHERE id = p_request_id;
    IF v_req.status = 'applied' THEN
      RAISE EXCEPTION 'ALREADY_APPLIED'
        USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001', DETAIL = 'claim_zero_rows';
  END IF;

  SELECT ps.id, ps.provider_order_id
  INTO v_session_id, v_order_id
  FROM public.payment_sessions ps
  WHERE ps.trip_id = p_trip_id
    AND ps.purpose IS DISTINCT FROM 'PAYMENT_RECOVERY'::public.payment_session_purpose
  ORDER BY ps.created_at DESC
  LIMIT 1;

  IF v_session_id IS NULL OR COALESCE(v_order_id, '') = '' THEN
    RAISE EXCEPTION 'PAYMENT_NOT_CONFIRMED'
      USING ERRCODE = 'P0001', DETAIL = 'missing_payment_session_for_fare_increase';
  END IF;

  INSERT INTO public.payment_session_authorisations (
    payment_session_id,
    payment_provider,
    provider_order_id,
    authorised_amount_pence,
    authorised_at,
    status,
    source,
    trip_change_request_id,
    requested_target_total_pence,
    provider_confirmed_total_pence,
    cumulative_total_authorised_pence,
    idempotency_key,
    metadata,
    verified_at
  ) VALUES (
    v_session_id,
    'revolut',
    v_order_id,
    v_authorised,
    now(),
    'ADDITIONAL_AUTHORISATION_CONFIRMED',
    'fare_increase_modification',
    p_request_id,
    v_required,
    v_authorised,
    v_authorised,
    'mod_auth_confirmed:' || p_request_id::text || ':' || v_required::text,
    jsonb_build_object(
      'trip_id', p_trip_id,
      'trip_change_request_id', p_request_id,
      'required_authorised_total_pence', v_required
    ),
    now()
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_auth_inserted = ROW_COUNT;

  -- Attach orphan confirmed rows written by increment without TCR linkage
  -- (unique on session+order+target otherwise blocks claim-owned insert).
  UPDATE public.payment_session_authorisations psa
  SET
    trip_change_request_id = p_request_id,
    verified_at = COALESCE(psa.verified_at, now()),
    metadata = COALESCE(psa.metadata, '{}'::jsonb) || jsonb_build_object(
      'trip_change_request_id', p_request_id,
      'attached_by_claim', true
    )
  WHERE psa.payment_session_id = v_session_id
    AND psa.status = 'ADDITIONAL_AUTHORISATION_CONFIRMED'
    AND psa.trip_change_request_id IS NULL
    AND (
      psa.requested_target_total_pence = v_required
      OR COALESCE(psa.provider_confirmed_total_pence, 0) >= v_required
      OR COALESCE(psa.cumulative_total_authorised_pence, 0) >= v_required
      OR psa.authorised_amount_pence >= v_required
    );

  GET DIAGNOSTICS v_auth_attached = ROW_COUNT;

  SELECT EXISTS (
    SELECT 1
    FROM public.payment_session_authorisations psa
    WHERE psa.trip_change_request_id = p_request_id
      AND psa.status = 'ADDITIONAL_AUTHORISATION_CONFIRMED'
  )
  INTO v_has_auth_evidence;

  IF v_has_auth_evidence IS NOT TRUE THEN
    RAISE EXCEPTION 'PAYMENT_NOT_CONFIRMED'
      USING ERRCODE = 'P0001',
            DETAIL = 'missing_ADDITIONAL_AUTHORISATION_CONFIRMED_evidence';
  END IF;

  SELECT * INTO v_advanced
  FROM public.advance_trip_change_after_payment(p_request_id);

  IF v_advanced.id IS NULL THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001', DETAIL = 'advance_returned_null';
  END IF;

  IF v_advanced.status IS DISTINCT FROM 'applied'
     AND v_advanced.status IS DISTINCT FROM 'approved'
     AND v_advanced.status IS DISTINCT FROM 'pending_driver_approval' THEN
    RAISE EXCEPTION 'STALE_MODIFICATION'
      USING ERRCODE = 'P0001',
            DETAIL = format('advance_status=%s', v_advanced.status);
  END IF;

  INSERT INTO public.trip_modification_apply_events (
    trip_id,
    trip_change_request_id,
    event_type,
    fare_delta_pence,
    new_fare_pence,
    authorised_total_pence
  ) VALUES (
    p_trip_id,
    p_request_id,
    'MODIFICATION_APPLIED',
    COALESCE(v_advanced.fare_delta_pence, v_req.fare_delta_pence, 0),
    v_advanced.new_fare_pence,
    v_authorised
  )
  ON CONFLICT (trip_change_request_id) DO NOTHING;

  GET DIAGNOSTICS v_event_inserted = ROW_COUNT;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;

  RETURN jsonb_build_object(
    'ok', true,
    'code', CASE
      WHEN v_advanced.status = 'applied' AND v_event_inserted = 0 THEN 'ALREADY_APPLIED'
      ELSE 'MODIFICATION_APPLIED'
    END,
    'request_id', p_request_id,
    'trip_id', p_trip_id,
    'request_status', v_advanced.status,
    'fare_delta_pence', COALESCE(v_advanced.fare_delta_pence, 0),
    'final_customer_fare_pence', v_trip.final_customer_fare_pence,
    'authorised_total_pence', v_authorised,
    'auth_row_inserted', v_auth_inserted > 0,
    'auth_row_attached', v_auth_attached > 0,
    'apply_event_inserted', v_event_inserted > 0
  );
END;
$function$;


REVOKE ALL ON FUNCTION public.claim_and_apply_fare_increase_modification(
  uuid, uuid, integer, text, integer, boolean, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_and_apply_fare_increase_modification(
  uuid, uuid, integer, text, integer, boolean, integer
) TO service_role;

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

  v_model := upper(trim(COALESCE(v_trip.financial_model, '')));
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
