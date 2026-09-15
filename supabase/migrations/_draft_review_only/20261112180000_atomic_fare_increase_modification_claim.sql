-- DRAFT / REVIEW ONLY — DO NOT APPLY TO PRODUCTION
-- Candidate migration version: 20261112180000 (VERIFY against live schema_migrations before apply)
-- Former invalid filename 20260915120000 remains REJECTED (collides with stacked-ride migration).
-- Status: LOCAL_REVIEW_COMPLETE packaging onto origin/main — still not production-ready until Ahmed approves version + apply.
-- Source evidence tip: 06d40440 (rescue/local-atomic-fare-modification-20260915)
--
BEGIN;

-- 1) Link authorisation success rows to a single modification (idempotent confirm).
ALTER TABLE public.payment_session_authorisations
  ADD COLUMN IF NOT EXISTS trip_change_request_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_session_authorisations_trip_change_request_id_fkey'
  ) THEN
    ALTER TABLE public.payment_session_authorisations
      ADD CONSTRAINT payment_session_authorisations_trip_change_request_id_fkey
      FOREIGN KEY (trip_change_request_id)
      REFERENCES public.trip_change_requests(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_psa_additional_auth_confirmed_per_modification
  ON public.payment_session_authorisations (trip_change_request_id)
  WHERE trip_change_request_id IS NOT NULL
    AND status = 'ADDITIONAL_AUTHORISATION_CONFIRMED';

CREATE UNIQUE INDEX IF NOT EXISTS uq_psa_idempotency_key_not_null
  ON public.payment_session_authorisations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 2) Exactly one successful apply audit event per modification.
CREATE TABLE IF NOT EXISTS public.trip_modification_apply_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id),
  trip_change_request_id uuid NOT NULL REFERENCES public.trip_change_requests(id),
  event_type text NOT NULL,
  fare_delta_pence integer NOT NULL DEFAULT 0,
  new_fare_pence integer NULL,
  authorised_total_pence integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_modification_apply_events_type_chk
    CHECK (event_type = 'MODIFICATION_APPLIED'),
  CONSTRAINT uq_trip_modification_apply_events_request UNIQUE (trip_change_request_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_modification_apply_events_trip
  ON public.trip_modification_apply_events (trip_id);

ALTER TABLE public.trip_modification_apply_events ENABLE ROW LEVEL SECURITY;

-- 3) Unresolved fare-increase gate for completion (does not mutate fares).
CREATE OR REPLACE FUNCTION public.trip_has_unresolved_fare_increase_modification(
  p_trip_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.trip_change_requests r
    WHERE r.trip_id = p_trip_id
      AND COALESCE(r.fare_delta_pence, 0) > 0
      AND r.status IN (
        'payment_required',
        'payment_pending',
        'payment_confirmed'
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.trip_has_unresolved_fare_increase_modification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trip_has_unresolved_fare_increase_modification(uuid) TO service_role;

-- 4) Atomic claim + apply in one transaction.
--    PAYMENT_PENDING → PROVIDER_CONFIRMED → MODIFICATION_APPLIED (via advance).
--    Zero-row / failed validation → typed exceptions (never silent success).
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
  v_event_inserted int := 0;
BEGIN
  v_expected_status := lower(trim(COALESCE(p_expected_trip_status, '')));
  v_required := GREATEST(0, COALESCE(p_required_authorised_total_pence, 0));
  v_authorised := GREATEST(0, COALESCE(p_authorised_total_pence, 0));

  IF p_trip_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGS'
      USING ERRCODE = 'P0001';
  END IF;

  -- Serialize trip + request (SELECT … FOR UPDATE).
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

  -- Idempotent success: already applied for this modification.
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

  -- Conditional claim: only one worker may move into PROVIDER_CONFIRMED.
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

  -- Idempotent ADDITIONAL_AUTHORISATION_CONFIRMED per modification.
  SELECT ps.id, ps.provider_order_id
  INTO v_session_id, v_order_id
  FROM public.payment_sessions ps
  WHERE ps.trip_id = p_trip_id
    AND COALESCE(ps.purpose, '') IS DISTINCT FROM 'PAYMENT_RECOVERY'
  ORDER BY ps.created_at DESC
  LIMIT 1;

  IF v_session_id IS NOT NULL AND COALESCE(v_order_id, '') <> '' THEN
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
  END IF;

  -- Existing apply SSOT (trigger/advance). Same transaction as the claim.
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

  -- One success audit event (unique on request id) — no wallet/capture writes here.
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

COMMIT;
