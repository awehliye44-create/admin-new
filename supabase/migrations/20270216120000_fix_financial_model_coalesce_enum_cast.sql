-- Hotfix: COALESCE(NEW.financial_model, '') forces Postgres to cast '' to
-- service_area_financial_model and fails trip insert with:
--   invalid input value for enum service_area_financial_model: ""
-- That left payment_authorised sessions with trip_id NULL after Revolut auth
-- (CTAP + webhook finalize_paid_booking_session both fail on trips INSERT).
-- Cast to text before COALESCE.

CREATE OR REPLACE FUNCTION public.trips_enforce_payment_first_platform_card()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_method text;
  v_model text;
  v_ps RECORD;
BEGIN
  v_method := UPPER(COALESCE(NEW.payment_method, ''));
  IF v_method NOT IN ('CARD', 'APPLE_PAY', 'GOOGLE_PAY') THEN
    RETURN NEW;
  END IF;

  v_model := UPPER(COALESCE(NEW.financial_model::text, ''));
  IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN NEW;
  END IF;

  -- Corporate invoice / non-card billing methods are not in the card set above.

  IF UPPER(COALESCE(NEW.status, '')) = 'PENDING_PAYMENT' THEN
    RAISE EXCEPTION
      'PAYMENT_FIRST_VIOLATION: platform-collected card trips cannot be inserted as pending_payment'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.payment_session_id IS NULL THEN
    RAISE EXCEPTION
      'PAYMENT_FIRST_VIOLATION: platform-collected card trip requires authorised payment_session_id'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, status, provider_state, released_at, captured_at, metadata
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = NEW.payment_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'PAYMENT_FIRST_VIOLATION: payment_session % not found', NEW.payment_session_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL THEN
    RAISE EXCEPTION
      'PAYMENT_FIRST_VIOLATION: payment_session hold already released'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_ps.metadata->>'never_capture', '') = 'true'
     OR v_ps.status::text IN ('payment_orphaned', 'orphan_authorisation', 'cancelled', 'failed', 'released')
  THEN
    RAISE EXCEPTION
      'PAYMENT_FIRST_VIOLATION: payment_session is not a usable authorisation'
      USING ERRCODE = 'P0001';
  END IF;

  IF UPPER(COALESCE(v_ps.provider_state, '')) NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION
      'PAYMENT_FIRST_VIOLATION: payment_session provider_state=%', v_ps.provider_state
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trips_enforce_scheduled_modification_coverage()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_method text;
  v_model text;
  v_deadline timestamptz;
  v_until timestamptz;
  v_changing boolean;
BEGIN
  v_changing :=
    NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
    OR NEW.estimated_duration_minutes IS DISTINCT FROM OLD.estimated_duration_minutes;

  IF NOT v_changing THEN
    RETURN NEW;
  END IF;

  IF NEW.started_at IS NOT NULL
     OR NEW.completed_at IS NOT NULL
     OR NEW.cancelled_at IS NOT NULL
  THEN
    RETURN NEW;
  END IF;

  -- Advance window when pickup moves (INSERT/reschedule already covered for INSERT).
  IF NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
     AND NEW.scheduled_at IS NOT NULL
  THEN
    PERFORM public.assert_scheduled_advance_window(NEW.scheduled_at, now(), false);
  END IF;

  IF NOT (COALESCE(NEW.is_scheduled, false) OR NEW.scheduled_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  v_method := UPPER(COALESCE(NEW.payment_method, ''));
  IF v_method NOT IN ('CARD', 'APPLE_PAY', 'GOOGLE_PAY') THEN
    RETURN NEW;
  END IF;

  v_model := UPPER(COALESCE(NEW.financial_model::text, ''));
  IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_session_id IS NULL THEN
    RAISE EXCEPTION
      'SCHEDULE_MODIFICATION_BLOCKED: card scheduled trip missing payment_session_id'
      USING ERRCODE = 'P0001';
  END IF;

  -- Schedule modifications always re-validate payment coverage before apply
  -- (do not wait for the next dispatch gate). Legacy latch does not waive this.
  SELECT capture_deadline
    INTO v_deadline
    FROM public.payment_sessions
   WHERE id = NEW.payment_session_id;

  v_until := public.required_capture_coverage_until(
    NEW.scheduled_at,
    NEW.estimated_duration_minutes,
    360
  );

  IF v_deadline IS NULL THEN
    RAISE EXCEPTION
      'SCHEDULE_MODIFICATION_BLOCKED: CAPTURE_DEADLINE_MISSING — original schedule preserved'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_until IS NOT NULL AND v_deadline < v_until THEN
    RAISE EXCEPTION
      'SCHEDULE_MODIFICATION_BLOCKED: CAPTURE_DEADLINE_INSUFFICIENT deadline=% required_until=% — original schedule preserved',
      v_deadline, v_until
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;
