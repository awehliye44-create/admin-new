-- P0 #1 gap close: session↔trip bind on payment gate + amount gate on boolean dispatch overload.

CREATE OR REPLACE FUNCTION public.payment_authorisation_valid(p_trip_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_ps RECORD;
  v_method text;
  v_provider_state text;
  v_required integer;
  v_authorised integer;
BEGIN
  SELECT id, payment_method, payment_session_id, payment_provider,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence, gross_fare_pence, offer_discount_pence
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_method := UPPER(COALESCE(v_trip.payment_method,''));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN true;
  END IF;

  IF v_trip.payment_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id, status, provider_state, authorised_amount_pence, total_authorised_amount_pence,
         currency, released_at, captured_at, trip_id, metadata
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Session must belong to this trip when linked (reject orphaned/superseded binds).
  IF v_ps.trip_id IS NOT NULL AND v_ps.trip_id <> p_trip_id THEN
    RETURN false;
  END IF;

  IF COALESCE(v_ps.metadata->>'never_capture','') = 'true'
     OR COALESCE(v_ps.metadata->>'orphan_reason','') <> '' THEN
    IF v_ps.status::text IN ('payment_orphaned','orphan_authorisation') THEN
      RETURN false;
    END IF;
  END IF;

  IF v_ps.status::text IN (
    'cancelled','failed','payment_orphaned','orphan_authorisation',
    'released','RECOVERY_CANCELLED','RECOVERY_DECLINED','RECOVERY_EXPIRED'
  ) THEN
    RETURN false;
  END IF;

  IF v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL THEN
    RETURN false;
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RETURN false;
  END IF;

  v_authorised := COALESCE(
    NULLIF(v_ps.total_authorised_amount_pence, 0),
    NULLIF(v_ps.authorised_amount_pence, 0),
    NULLIF(v_trip.authorised_amount_pence, 0),
    0
  );
  IF v_authorised <= 0 THEN
    RETURN false;
  END IF;

  v_required := COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    0
  );
  IF v_required <= 0 THEN
    RETURN false;
  END IF;

  RETURN v_authorised >= v_required;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_payment_gate(p_trip_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_ps RECORD;
  v_method text;
  v_provider_state text;
  v_required integer;
  v_authorised integer;
BEGIN
  SELECT id, payment_method, payment_session_id, currency_code,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % not found', p_trip_id USING ERRCODE='P0001';
  END IF;

  v_method := UPPER(COALESCE(v_trip.payment_method,''));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN;
  END IF;

  IF v_trip.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % has no payment_session_id', p_trip_id
      USING ERRCODE='P0001';
  END IF;

  SELECT id, status, provider_state, authorised_amount_pence, total_authorised_amount_pence,
         currency, released_at, captured_at, trip_id, metadata
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session missing' USING ERRCODE='P0001';
  END IF;

  IF v_ps.trip_id IS NOT NULL AND v_ps.trip_id <> p_trip_id THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session bound to different trip'
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'payment_orphaned','orphan_authorisation'
  ) OR COALESCE(v_ps.metadata->>'never_capture','') = 'true' THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session orphaned/superseded'
      USING ERRCODE='P0001';
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'cancelled','failed','released',
    'RECOVERY_CANCELLED','RECOVERY_DECLINED','RECOVERY_EXPIRED'
  ) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=%', v_ps.status
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: hold released without capture'
      USING ERRCODE='P0001';
  END IF;

  v_authorised := COALESCE(
    NULLIF(v_ps.total_authorised_amount_pence, 0),
    NULLIF(v_ps.authorised_amount_pence, 0),
    NULLIF(v_trip.authorised_amount_pence, 0),
    0
  );
  IF v_authorised <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=%', v_authorised
      USING ERRCODE='P0001';
  END IF;

  v_required := COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    0
  );
  IF v_required <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: locked customer payable missing'
      USING ERRCODE='P0001';
  END IF;

  IF v_authorised < v_required THEN
    RAISE EXCEPTION
      'PAYMENT_GATE_NOT_SATISFIED: PAYMENT_AUTHORISATION_INSUFFICIENT authorised=% required=%',
      v_authorised, v_required
      USING ERRCODE='P0001';
  END IF;
END;
$function$;

-- Inject amount gate into boolean overload (emergency/manual SQL path).
DO $patch$
DECLARE
  v_def text;
  v_marker text := E'BEGIN\n  IF NOT p_internal THEN';
  v_inject text :=
$inj$
BEGIN
  -- P0 #1: amount gate before any ride_offer insert (boolean overload).
  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION '%', SQLERRM USING ERRCODE = 'P0001';
  END;

  IF NOT p_internal THEN
$inj$;
BEGIN
  SELECT pg_get_functiondef('public.dispatch_trip_offers(uuid,boolean)'::regprocedure)
    INTO v_def;
  IF v_def IS NULL THEN
    RAISE NOTICE 'dispatch_trip_offers(uuid,boolean) missing — skip';
    RETURN;
  END IF;
  IF position('assert_payment_gate(p_trip_id)' in v_def) > 0 THEN
    RAISE NOTICE 'boolean dispatch already gated';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'boolean dispatch patch marker not found';
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch$;
