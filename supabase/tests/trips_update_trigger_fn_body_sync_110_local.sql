-- #110 P3 LOCAL ONLY — sync mismatched trigger function bodies from prod.
-- Never apply to production.
BEGIN;
-- enforce_digital_payment_gate
CREATE OR REPLACE FUNCTION public.enforce_digital_payment_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_method text := UPPER(COALESCE(NEW.payment_method, ''));
  v_new_status text := LOWER(COALESCE(NEW.status, ''));
  v_gated_states text[] := ARRAY[
    'searching','searching_new_driver','broadcasting',
    'offered','offering','negotiating','driver_notified',
    'awaiting_driver_response','accepted','confirmed',
    'driver_assigned','assigned','queued',
    'en_route','en_route_to_pickup','driver_en_route','enroute_to_pickup',
    'driver_arriving','arrived','arrived_pickup','arrived_at_pickup',
    'at_pickup','pickup_waiting','waiting','waiting_at_pickup',
    'in_progress','started','on_trip','ongoing','trip_started','completed',
    'scheduled'
  ];
  v_ps RECORD;
  v_fm text := UPPER(COALESCE((NEW.financial_model)::text, ''));
  v_session_status text;
BEGIN
  IF v_fm = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN NEW;
  END IF;

  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN NEW;
  END IF;

  IF NOT (v_new_status = ANY(v_gated_states)) THEN
    RETURN NEW;
  END IF;

  -- Mid-trip lost authorisation: the passenger is already on board and
  -- assert_trip_completion_customer_payment_gate has flagged the trip
  -- recovery_required. Ending the ride must not be blocked; support recovers payment.
  IF TG_OP = 'UPDATE'
     AND v_new_status = 'completed'
     AND LOWER(COALESCE(OLD.status, '')) IN ('in_progress','started','on_trip','ongoing','trip_started')
     AND LOWER(COALESCE(NEW.payment_status, '')) = 'recovery_required'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: digital-payment trip requires payment_session_id (trip=%, method=%)',
      NEW.id, v_method USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, provider_state, currency, authorised_amount_pence, hold_release_state
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = NEW.payment_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session % not found', NEW.payment_session_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- MUST cast enum → text before IN-list; US "canceled" is not a valid enum label
  -- and crashes ALL digital trip inserts (MK-261105-002 outage).
  v_session_status := lower(COALESCE((v_ps.status)::text, ''));

  IF UPPER(COALESCE(v_ps.provider_state,'')) NOT IN ('AUTHORISED','AUTHORIZED','COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=% for session % (trip=%)',
      v_ps.provider_state, v_ps.id, NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF v_session_status IN (
    'cancelled','canceled','failed','expired','abandoned','payment_orphaned','released'
  ) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=% (trip=%)', v_ps.status, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF lower(COALESCE(v_ps.hold_release_state, '')) IN ('released', 'releasing') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: hold_release_state=% (trip=%)',
      v_ps.hold_release_state, NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF LOWER(COALESCE(v_ps.currency,'')) <> LOWER(COALESCE(NEW.currency, v_ps.currency, '')) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: currency mismatch session=% trip=%',
      v_ps.currency, NEW.currency USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence not positive for session %',
      v_ps.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;
-- trips_enforce_airport_broadcast_hold
-- #116: refuse reopen only for airport_pricing / active scheduled_hold_reason /
-- without release opt-in. NULL hold reason must allow negotiation rematch reopen.
CREATE OR REPLACE FUNCTION public.trips_enforce_airport_broadcast_hold()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.broadcast_enabled IS FALSE
     AND NEW.broadcast_enabled IS DISTINCT FROM FALSE
  THEN
    IF COALESCE(NEW.scheduled_hold_reason, '') = 'airport_pricing'
       OR COALESCE(OLD.scheduled_hold_reason, '') = 'airport_pricing'
    THEN
      NEW.broadcast_enabled := FALSE;
      NEW.scheduled_hold_reason := 'airport_pricing';
    ELSIF current_setting('onecab.release_airport_broadcast_hold', true) = '1' THEN
      -- Explicit SECURITY DEFINER release path opted in for this transaction.
      NULL;
    ELSIF COALESCE(NEW.scheduled_hold_reason, OLD.scheduled_hold_reason, '') <> '' THEN
      NEW.broadcast_enabled := FALSE;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
-- trips_enforce_scheduled_advance_window
CREATE OR REPLACE FUNCTION public.trips_enforce_scheduled_advance_window()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_changing_schedule boolean;
  v_ps RECORD;
  v_check_now timestamptz;
  v_bound interval := interval '10 minutes';
BEGIN
  IF NEW.scheduled_at IS NULL AND COALESCE(NEW.is_scheduled, false) = false THEN
    RETURN NEW;
  END IF;

  IF NEW.started_at IS NOT NULL
     OR NEW.completed_at IS NOT NULL
     OR NEW.cancelled_at IS NOT NULL
     OR UPPER(COALESCE(NEW.status, '')) IN (
       'IN_PROGRESS', 'IN_TRIP', 'STARTED', 'ARRIVED', 'WAITING', 'ON_TRIP',
       'COMPLETED', 'CANCELLED', 'CANCELED', 'NO_SHOW', 'EXPIRED'
     )
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.scheduled_at IS NOT NULL OR COALESCE(NEW.is_scheduled, false) THEN
      v_check_now := now();

      IF NEW.payment_session_id IS NOT NULL THEN
        SELECT
          advance_window_validated_at,
          advance_window_validated_scheduled_at
        INTO v_ps
        FROM public.payment_sessions
        WHERE id = NEW.payment_session_id;

        IF v_ps.advance_window_validated_at IS NOT NULL
           AND v_ps.advance_window_validated_scheduled_at IS NOT NULL
           AND v_ps.advance_window_validated_scheduled_at = NEW.scheduled_at
           AND now() >= v_ps.advance_window_validated_at
           AND now() <= v_ps.advance_window_validated_at + v_bound
        THEN
          -- Pickup must still be in the future (operational feasibility).
          IF NEW.scheduled_at <= now() THEN
            RAISE EXCEPTION 'SCHEDULED_ADVANCE_WINDOW: PICKUP_NO_LONGER_FEASIBLE — Pickup time is no longer feasible.'
              USING ERRCODE = 'P0001';
          END IF;
          v_check_now := v_ps.advance_window_validated_at;
        ELSIF v_ps.advance_window_validated_at IS NOT NULL
           AND v_ps.advance_window_validated_scheduled_at IS NOT NULL
           AND v_ps.advance_window_validated_scheduled_at = NEW.scheduled_at
           AND now() > v_ps.advance_window_validated_at + v_bound
        THEN
          RAISE EXCEPTION 'SCHEDULED_ADVANCE_WINDOW: STALE_PAYMENT_ATTEMPT — Payment attempt exceeded the bounded completion window.'
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      PERFORM public.assert_scheduled_advance_window(NEW.scheduled_at, v_check_now, false);
    END IF;
    RETURN NEW;
  END IF;

  v_changing_schedule := NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at;
  IF v_changing_schedule AND NEW.scheduled_at IS NOT NULL THEN
    PERFORM public.assert_scheduled_advance_window(NEW.scheduled_at, now(), false);
  END IF;

  RETURN NEW;
END;
$function$;
-- trips_enforce_scheduled_modification_coverage
CREATE OR REPLACE FUNCTION public.trips_enforce_scheduled_modification_coverage()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
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
COMMIT;
