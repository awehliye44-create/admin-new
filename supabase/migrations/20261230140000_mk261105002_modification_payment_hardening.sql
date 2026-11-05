-- MK-261105-002: trip modification payment hardening
-- 1) Live hold must cover revised fare for EVERY apply (increase / decrease / zero-delta)
-- 2) Reject releasing / released / expired / superseded sessions under FOR UPDATE
-- 3) claim_and_apply locks session and trusts session authorised totals
-- 4) Notice kinds: modification_unchanged, trip_cancelled_payment

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Extend durable notice kinds
-- ---------------------------------------------------------------------------
ALTER TABLE public.customer_payment_failure_notices
  DROP CONSTRAINT IF EXISTS customer_payment_failure_notices_kind_check;

ALTER TABLE public.customer_payment_failure_notices
  ADD CONSTRAINT customer_payment_failure_notices_kind_check
  CHECK (kind IN (
    'booking_not_created',
    'booking_cancelled_payment',
    'modification_unchanged',
    'trip_cancelled_payment'
  ));

-- ---------------------------------------------------------------------------
-- 1. Shared hold-coverage assert (FOR UPDATE on bound payment session)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_trip_modification_hold_coverage(
  p_trip_id uuid,
  p_required_payable_pence integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip RECORD;
  v_ps RECORD;
  v_required int := GREATEST(0, COALESCE(p_required_payable_pence, 0));
  v_method text;
  v_model text;
  v_provider text;
  v_status text;
  v_hold text;
  v_auth int := 0;
BEGIN
  IF p_trip_id IS NULL THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: trip_id required'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, payment_session_id, payment_method, financial_model, status
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: trip not found'
      USING ERRCODE = 'P0001';
  END IF;

  v_model := upper(trim(COALESCE(v_trip.financial_model::text, '')));
  IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'non_platform_collected'
    );
  END IF;

  v_method := upper(trim(COALESCE(v_trip.payment_method, '')));
  IF v_method NOT IN ('CARD', 'APPLE_PAY', 'GOOGLE_PAY') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'non_digital_method'
    );
  END IF;

  IF v_trip.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: missing_session'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: missing_session'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_ps.trip_id IS NOT NULL AND v_ps.trip_id IS DISTINCT FROM p_trip_id THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: superseded'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_ps.metadata->>'never_capture', '') = 'true' THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: superseded'
      USING ERRCODE = 'P0001';
  END IF;

  v_hold := lower(COALESCE(v_ps.hold_release_state, ''));
  IF v_hold = 'releasing' THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: releasing'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_hold = 'released'
     OR (v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL) THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: released'
      USING ERRCODE = 'P0001';
  END IF;

  v_provider := upper(COALESCE(v_ps.provider_state, ''));
  IF v_provider = 'EXPIRED' THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: expired'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_provider NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: not_authorised provider_state=%',
      v_ps.provider_state
      USING ERRCODE = 'P0001';
  END IF;

  v_status := lower(COALESCE(v_ps.status::text, ''));
  IF v_status IN (
    'cancelled', 'canceled', 'failed', 'expired', 'abandoned',
    'payment_orphaned', 'released', 'orphan_authorisation',
    'RECOVERY_CANCELLED', 'RECOVERY_DECLINED', 'RECOVERY_EXPIRED'
  ) THEN
    RAISE EXCEPTION 'MODIFICATION_HOLD_NOT_SATISFIED: session_status=%', v_ps.status
      USING ERRCODE = 'P0001';
  END IF;

  v_auth := GREATEST(
    0,
    COALESCE(v_ps.total_authorised_amount_pence, 0),
    COALESCE(v_ps.authorised_amount_pence, 0)
  );

  IF v_required > 0 AND v_auth < v_required THEN
    RAISE EXCEPTION
      'MODIFICATION_HOLD_NOT_SATISFIED: insufficient authorised=% required=%',
      v_auth, v_required
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'payment_session_id', v_ps.id,
    'authorised_amount_pence', v_auth,
    'required_payable_pence', v_required
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assert_trip_modification_hold_coverage(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_trip_modification_hold_coverage(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.assert_trip_modification_hold_coverage(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assert_trip_modification_hold_coverage(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.assert_trip_modification_hold_coverage(uuid, integer) IS
  'MK-261105-002: FOR UPDATE live-hold gate for trip modifications (any fare delta).';

-- ---------------------------------------------------------------------------
-- 2. Enforce live hold on EVERY apply (including ≤0 delta)
-- ---------------------------------------------------------------------------
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
  v_has_auth_evidence boolean := false;
  v_model text;
  v_method text;
  v_assert jsonb;
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

  v_method := upper(trim(COALESCE(v_trip.payment_method, '')));
  IF v_method NOT IN ('CARD', 'APPLE_PAY', 'GOOGLE_PAY') THEN
    RETURN NEW;
  END IF;

  -- Committed basis is the pre-modification fare on the TCR.
  v_committed := GREATEST(0, COALESCE(NEW.original_fare_pence, 0));
  IF v_committed <= 0 THEN
    v_committed := GREATEST(
      0,
      COALESCE(v_trip.final_customer_fare_pence, 0),
      COALESCE(v_trip.locked_base_fare_pence, 0)
    );
  END IF;
  v_new := GREATEST(0, COALESCE(NEW.new_fare_pence, 0));
  v_increase := GREATEST(
    COALESCE(NEW.fare_delta_pence, 0),
    CASE WHEN v_new > 0 THEN GREATEST(0, v_new - v_committed) ELSE 0 END
  );

  -- Revised payable the hold must cover (decrease/zero/increase).
  v_required := CASE
    WHEN v_new > 0 THEN v_new
    ELSE v_committed
  END;

  -- Live session lock + reject releasing/released/expired/superseded.
  v_assert := public.assert_trip_modification_hold_coverage(NEW.trip_id, v_required);
  v_protected := GREATEST(
    0,
    COALESCE((v_assert->>'authorised_amount_pence')::int, 0)
  );

  IF v_increase > 0 THEN
    IF lower(COALESCE(NEW.payment_status, '')) IS DISTINCT FROM 'confirmed' THEN
      RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
        USING ERRCODE = 'P0001',
              DETAIL = 'cannot apply fare-increasing modification without confirmed payment';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.payment_session_authorisations psa
      WHERE psa.trip_change_request_id = NEW.id
        AND psa.status = 'ADDITIONAL_AUTHORISATION_CONFIRMED'
    )
    INTO v_has_auth_evidence;

    IF v_protected < v_required THEN
      RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
        USING ERRCODE = 'P0001',
              DETAIL = format(
                'protected=%s required=%s — cannot apply unpaid fare increase',
                v_protected,
                v_required
              );
    END IF;

    IF v_required > v_committed AND v_has_auth_evidence IS NOT TRUE THEN
      RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
        USING ERRCODE = 'P0001',
              DETAIL = 'missing ADDITIONAL_AUTHORISATION_CONFIRMED evidence for fare increase';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_trip_change_payment_before_apply() IS
  'MK-261105-002: PLATFORM digital mods require a live hold covering the revised fare for any delta.';

-- ---------------------------------------------------------------------------
-- 3. claim_and_apply: lock session, reject dead holds, trust session auth
-- ---------------------------------------------------------------------------
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
  v_assert jsonb;
  v_session_auth int := 0;
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

  -- Live hold under the same FOR UPDATE discipline as release.
  -- Server session authorised total is authoritative — caller cannot invent coverage.
  v_assert := public.assert_trip_modification_hold_coverage(p_trip_id, v_required);
  v_session_auth := GREATEST(
    0,
    COALESCE((v_assert->>'authorised_amount_pence')::int, 0)
  );
  v_authorised := v_session_auth;
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

  v_session_id := NULLIF(v_assert->>'payment_session_id', '')::uuid;
  SELECT provider_order_id INTO v_order_id
  FROM public.payment_sessions
  WHERE id = v_session_id;

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

  RETURN jsonb_build_object(
    'ok', true,
    'code', CASE
      WHEN v_advanced.status = 'applied' THEN 'MODIFICATION_APPLIED'
      ELSE 'MODIFICATION_ADVANCED'
    END,
    'request_id', v_advanced.id,
    'request_status', v_advanced.status,
    'trip_id', v_trip.id,
    'fare_delta_pence', COALESCE(v_advanced.fare_delta_pence, v_req.fare_delta_pence, 0),
    'authorised_total_pence', v_authorised,
    'auth_inserted', v_auth_inserted,
    'auth_attached', v_auth_attached,
    'event_inserted', v_event_inserted
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_and_apply_fare_increase_modification(
  uuid, uuid, integer, text, integer, boolean, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_and_apply_fare_increase_modification(
  uuid, uuid, integer, text, integer, boolean, integer
) TO service_role;

-- Soften auto-apply for ≤0 delta: still calls apply, which hits enforce.
CREATE OR REPLACE FUNCTION public.handle_auto_applied_trip_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'approved' THEN
    IF COALESCE(NEW.fare_delta_pence, 0) > 0
       AND COALESCE(NEW.payment_status, '') IS DISTINCT FROM 'confirmed' THEN
      RETURN NEW;
    END IF;
    -- May raise MODIFICATION_HOLD_NOT_SATISFIED / CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED
    -- — fail closed; original trip unchanged.
    PERFORM public.apply_approved_trip_change_from_request(NEW);
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;
