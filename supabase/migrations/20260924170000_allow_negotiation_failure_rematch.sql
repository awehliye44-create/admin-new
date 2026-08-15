-- Negotiation decline / £Y timeout must rematch the same trip at the
-- committed fare. The driver-cancel rematch trigger blocked
-- negotiating → searching_new_driver, so Customer Decline and expiry
-- returned success/TIMEOUT while the offer stayed waiting_customer.
--
-- Allow that transition only when assignment is clear and exclusion
-- markers are present (finalize_negotiation_failure). Do not add
-- negotiating to driver-cancel eligibility.

CREATE OR REPLACE FUNCTION public.enforce_driver_cancel_rematch_invariants()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old text := lower(COALESCE(OLD.status, ''));
  v_new text := lower(COALESCE(NEW.status, ''));
  v_is_rematch_restore boolean := false;
BEGIN
  IF v_new = 'searching_new_driver' AND NEW.confirmed_driver_id IS NOT NULL THEN
    RAISE EXCEPTION 'REMATCH_INVARIANT: searching_new_driver cannot have confirmed_driver_id'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_old IS DISTINCT FROM v_new
     AND v_new = 'searching_new_driver'
  THEN
    IF v_old IN (
      'no_show', 'no-show', 'in_progress', 'on_trip', 'started', 'ongoing',
      'completing', 'passenger_onboard', 'completed', 'cancelled', 'canceled',
      'customer_cancelled', 'customer_canceled', 'expired', 'expired_no_driver',
      'declined', 'failed'
    ) THEN
      RAISE EXCEPTION 'REMATCH_INVARIANT: cannot transition % to searching_new_driver', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;

    v_is_rematch_restore :=
      NEW.confirmed_driver_id IS NULL
      AND v_old IN (
        'searching', 'pending', 'offered', 'broadcasting', 'offering', 'negotiating'
      )
      AND (
        lower(COALESCE(NEW.cancelled_by, '')) = 'driver'
        OR COALESCE(cardinality(NEW.cancelled_driver_ids), 0) > 0
        OR COALESCE(cardinality(NEW.excluded_driver_ids), 0) > 0
        OR NEW.negotiation_disabled = true
        OR EXISTS (
          SELECT 1
          FROM public.trip_driver_exclusions tde
          WHERE tde.trip_id = NEW.id
          LIMIT 1
        )
      );

    IF NOT v_is_rematch_restore
       AND NOT public.is_driver_cancel_rematch_eligible_status(v_old)
    THEN
      RAISE EXCEPTION 'REMATCH_INVARIANT: cannot transition % to searching_new_driver', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_new IN (
    'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup', 'pickup_waiting',
    'waiting', 'driver_arrived', 'waiting_at_pickup',
    'en_route', 'en_route_to_pickup', 'driver_en_route', 'enroute_to_pickup', 'driver_arriving',
    'in_progress', 'on_trip', 'started', 'ongoing', 'passenger_onboard', 'completing'
  ) AND NEW.confirmed_driver_id IS NULL THEN
    RAISE EXCEPTION 'ASSIGNMENT_REQUIRED: status % requires confirmed_driver_id', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND v_new = 'completed'
     AND NEW.confirmed_driver_id IS NULL
     AND v_old IN ('searching_new_driver', 'searching', 'broadcasting', 'offered', 'pending')
  THEN
    RAISE EXCEPTION 'ASSIGNMENT_REQUIRED: cannot complete from % without confirmed_driver_id', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;
