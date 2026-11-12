-- Phase 1 critical gap closure (IN-REPO ONLY).
-- 1) capture_deadline_observed_at for freshness-based merge
-- 2) Forbid unpaid PLATFORM_COLLECTED card trip inserts (payment-first)
-- 3) Schedule/duration modification coverage before apply
-- 4) Atomic admin_assign_scheduled_driver (payment gate + assign)

BEGIN;

ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS capture_deadline_observed_at timestamptz NULL;

COMMENT ON COLUMN public.payment_sessions.capture_deadline_observed_at IS
  'When the persisted capture_deadline was last observed from an authoritative provider response. Used to reject stale out-of-order updates.';

-- ── Payment-first: no unpaid platform-collected card trips ───────────────────
CREATE OR REPLACE FUNCTION public.trips_enforce_payment_first_platform_card()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_method text;
  v_model text;
  v_ps RECORD;
BEGIN
  v_method := UPPER(COALESCE(NEW.payment_method, ''));
  IF v_method NOT IN ('CARD', 'APPLE_PAY', 'GOOGLE_PAY') THEN
    RETURN NEW;
  END IF;

  v_model := UPPER(COALESCE(NEW.financial_model, ''));
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
$fn$;

DROP TRIGGER IF EXISTS trg_trips_enforce_payment_first_platform_card ON public.trips;
CREATE TRIGGER trg_trips_enforce_payment_first_platform_card
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_enforce_payment_first_platform_card();

-- ── Schedule / duration modification: advance + coverage before apply ────────
CREATE OR REPLACE FUNCTION public.trips_enforce_scheduled_modification_coverage()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
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

  v_model := UPPER(COALESCE(NEW.financial_model, ''));
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
$fn$;

DROP TRIGGER IF EXISTS trg_trips_enforce_scheduled_modification_coverage ON public.trips;
CREATE TRIGGER trg_trips_enforce_scheduled_modification_coverage
  BEFORE UPDATE OF scheduled_at, estimated_duration_minutes
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_enforce_scheduled_modification_coverage();

-- ── Atomic Admin Assign Now ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_assign_scheduled_driver(
  p_trip_id uuid,
  p_driver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_trip RECORD;
  v_now timestamptz := now();
BEGIN
  IF NOT (
    public.is_admin()
    OR current_setting('request.jwt.claim.role', true) = 'service_role'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Admin access required');
  END IF;

  IF p_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_REQUIRED');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  IF v_trip.completed_at IS NOT NULL OR v_trip.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_TERMINAL');
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_LIVE_ASSIGNED');
  END IF;

  IF COALESCE(v_trip.scheduled_status::text, '') NOT IN (
    'admin_held', 'scheduled', 'broadcasting', 'pending', 'driver_assigned'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_STATE',
      'scheduled_status', v_trip.scheduled_status
    );
  END IF;

  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_GATE_NOT_SATISFIED',
      'message', SQLERRM
    );
  END;

  UPDATE public.trips
     SET confirmed_driver_id = p_driver_id,
         scheduled_status = 'driver_assigned',
         scheduled_accepted_at = v_now,
         status = 'scheduled',
         driver_id = NULL,
         pending_release_kind = NULL,
         pending_release_at = NULL,
         pending_release_driver_id = NULL,
         updated_at = v_now
   WHERE id = p_trip_id
     AND driver_id IS NULL
     AND completed_at IS NULL
     AND scheduled_status::text IN (
       'admin_held', 'scheduled', 'broadcasting', 'pending', 'driver_assigned'
     );

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'CAS_MISMATCH');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'confirmed_driver_id', p_driver_id
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_assign_scheduled_driver(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_assign_scheduled_driver(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_scheduled_driver(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.admin_assign_scheduled_driver(uuid, uuid) IS
  'Atomic Admin Assign Now: assert_payment_gate then preconfirm driver in one transaction.';

COMMIT;
