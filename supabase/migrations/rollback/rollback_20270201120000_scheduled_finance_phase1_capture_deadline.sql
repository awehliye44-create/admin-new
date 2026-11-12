-- Rollback for 20270201120000 (explicit approval only).
-- Restores assert_payment_gate to pre-Phase1 production definition
-- (amount/authorisation gate only — no scheduled capture-deadline coverage).
-- Drops Phase1 helper functions + preserve-deadline trigger.
-- RETAINS additive columns: capture_deadline*, scheduled_capture_coverage_enforced
-- (backward-compatible; safe for Edge that still writes deadlines).
-- Does NOT restore max_advance_days to 30 — approved policy remains 5.
-- Does NOT drop payment-first / schedule-mod triggers (roll those via 120200 scripts).

BEGIN;

DROP TRIGGER IF EXISTS trg_payment_sessions_preserve_capture_deadline ON public.payment_sessions;
DROP FUNCTION IF EXISTS public.payment_sessions_preserve_capture_deadline();

DROP FUNCTION IF EXISTS public.evaluate_scheduled_advance_window(timestamptz, timestamptz, integer, integer, boolean);
DROP FUNCTION IF EXISTS public.assert_scheduled_advance_window(timestamptz, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.required_capture_coverage_until(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS public.normalise_payment_gate_blocked_terminal_rows(boolean);
DROP FUNCTION IF EXISTS public.classify_scheduled_capture_deadline_backfill(boolean);

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
  SELECT id, payment_method, payment_session_id, currency_code, financial_model,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % not found', p_trip_id USING ERRCODE='P0001';
  END IF;

  IF v_trip.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN;
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
$function$
;

-- Keep max_advance_days = 5 (do not revert to 30).
UPDATE public.global_dispatch_settings
   SET max_advance_days = 5,
       updated_at = now()
 WHERE singleton = true
   AND COALESCE(max_advance_days, 5) <> 5;

-- Leave scheduled_capture_coverage_enforced column in place; force latch off so
-- rollback does not fail-closed grandfathered sessions without deadlines.
UPDATE public.global_dispatch_settings
   SET scheduled_capture_coverage_enforced = false,
       updated_at = now()
 WHERE singleton = true
   AND EXISTS (
     SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'global_dispatch_settings'
       AND column_name = 'scheduled_capture_coverage_enforced'
   );

COMMIT;
