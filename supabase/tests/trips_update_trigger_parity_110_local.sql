-- #110 P2 — LOCAL ONLY: restore the 4 UPDATE-capable trips triggers present in
-- production but missing from the pg-gates harness (48 → 52).
-- Never run against production. Never drops financial/security triggers.
--
-- Missing vs prod (2026-11-26 inventory):
--   trg_trips_enforce_airport_broadcast_hold
--   trg_trips_enforce_scheduled_advance_window
--   trg_trips_enforce_scheduled_modification_coverage
--   trips_capture_action_location_evidence
--
-- Source migrations (already applied on prod; absent from harness baseline dump):
--   20270213120000_scheduled_marketplace_hold_reason.sql
--   20270201120100_scheduled_finance_phase1_gap_closure.sql
--   20270201120200_scheduled_finance_phase1_payment_first_atomicity.sql
--   20261113143331_dcf7be32-10f0-47b6-ae4a-36fde9be63f2.sql

BEGIN;

-- Local harness may lack Phase-1 helpers that prod already has.
DO $$
BEGIN
  IF to_regprocedure('public.assert_scheduled_advance_window(timestamptz, timestamptz, boolean)') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION public.assert_scheduled_advance_window(
        p_scheduled_at timestamptz,
        p_now timestamptz,
        p_allow_past boolean
      ) RETURNS void LANGUAGE plpgsql AS $body$
      BEGIN
        NULL;
      END;
      $body$;
    $fn$;
  END IF;
END $$;

-- ── airport broadcast hold ──────────────────────────────────────────────────
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
      NULL;
    ELSE
      NEW.broadcast_enabled := FALSE;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trips_enforce_airport_broadcast_hold ON public.trips;
CREATE TRIGGER trg_trips_enforce_airport_broadcast_hold
  BEFORE UPDATE OF broadcast_enabled, scheduled_hold_reason
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_enforce_airport_broadcast_hold();

-- ── scheduled advance window ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trips_enforce_scheduled_advance_window()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_changing_schedule boolean;
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
      PERFORM public.assert_scheduled_advance_window(NEW.scheduled_at, now(), false);
    END IF;
    RETURN NEW;
  END IF;

  v_changing_schedule := NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at;
  IF v_changing_schedule AND NEW.scheduled_at IS NOT NULL THEN
    PERFORM public.assert_scheduled_advance_window(NEW.scheduled_at, now(), false);
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_trips_enforce_scheduled_advance_window ON public.trips;
CREATE TRIGGER trg_trips_enforce_scheduled_advance_window
  BEFORE INSERT OR UPDATE OF scheduled_at, is_scheduled, status, started_at, completed_at, cancelled_at
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_enforce_scheduled_advance_window();

-- ── scheduled modification coverage ─────────────────────────────────────────
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

-- ── action location evidence (status / arrived) ─────────────────────────────
-- Requires capture_trip_action_location_evidence helper from the same migration.
-- Create a minimal stub only when the production helper is absent.
DO $$
BEGIN
  IF to_regprocedure('public.capture_trip_action_location_evidence(public.trips, text)') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION public.capture_trip_action_location_evidence(p_trip public.trips, p_action text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      AS $body$
      BEGIN
        -- Local harness stub: production writes trip_action_location_evidence.
        -- Keep no-op when evidence table/driver GPS unavailable in fixtures.
        NULL;
      END;
      $body$;
    $fn$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.capture_trip_action_location_evidence(public.trips, text) FROM PUBLIC, anon, authenticated';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.trips_capture_action_location_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(OLD.pickup_arrived_at, OLD.arrived_at) IS NULL
     AND COALESCE(NEW.pickup_arrived_at, NEW.arrived_at) IS NOT NULL THEN
    PERFORM public.capture_trip_action_location_evidence(NEW, 'arrived_pickup');
  END IF;

  IF lower(COALESCE(NEW.status, '')) IS DISTINCT FROM lower(COALESCE(OLD.status, '')) THEN
    IF lower(NEW.status) = 'no_show' THEN
      PERFORM public.capture_trip_action_location_evidence(NEW, 'no_show');
    ELSIF lower(NEW.status) = 'completed' THEN
      PERFORM public.capture_trip_action_location_evidence(NEW, 'trip_completed');
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trips_capture_action_location_evidence() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trips_capture_action_location_evidence ON public.trips;
CREATE TRIGGER trips_capture_action_location_evidence
AFTER UPDATE ON public.trips
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.pickup_arrived_at IS DISTINCT FROM NEW.pickup_arrived_at
  OR OLD.arrived_at IS DISTINCT FROM NEW.arrived_at
)
EXECUTE FUNCTION public.trips_capture_action_location_evidence();

COMMIT;
