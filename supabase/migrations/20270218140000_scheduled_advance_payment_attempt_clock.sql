-- P0 targeted correction: advance-window payment-attempt clock + marketplace/NRO timing docs.
-- DO NOT apply until Owner approves the targeted release.
--
-- 1) Persist server-validated advance window at preauth.
-- 2) Trip insert trigger re-checks against validated attempt clock within a
--    bounded payment completion window (10 minutes) when scheduled_at matches.
-- 3) Marketplace scheduled_broadcast_at remains visibility-only (no schema change);
--    NRO/response clock uses broadcast_started_at / ride_offers (Edge SSOT).

BEGIN;

ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS advance_window_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS advance_window_validated_scheduled_at timestamptz;

COMMENT ON COLUMN public.payment_sessions.advance_window_validated_at IS
  'Server clock when create-preauth validated the scheduled advance window. Finalisation may re-use this within the bounded payment completion window.';
COMMENT ON COLUMN public.payment_sessions.advance_window_validated_scheduled_at IS
  'Immutable scheduled_at that passed advance validation at preauth. Mismatch or stale attempt fails closed.';

CREATE OR REPLACE FUNCTION public.trips_enforce_scheduled_advance_window()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
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
$fn$;

COMMENT ON FUNCTION public.trips_enforce_scheduled_advance_window() IS
  'Advance window on scheduled insert/reschedule. Insert may use payment_sessions.advance_window_validated_at within a 10-minute payment completion bound when scheduled_at matches the validated snapshot.';

COMMIT;
