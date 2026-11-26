-- #116 — Negotiation rematch must reopen broadcast when no scheduled hold is active.
--
-- Root cause (MK-261126-009): trips_enforce_airport_broadcast_hold ELSE branch
-- forced broadcast_enabled back to FALSE on EVERY false→true transition unless
-- onecab.release_airport_broadcast_hold='1'. finalize_negotiation_failure sets
-- broadcast_enabled=true for searching_new_driver rematch; the trigger silently
-- kept it false → auto-dispatch abort LOCKED_DRIVER_TRIP → no further waves →
-- search exhausted / cancel / hold release while customer still needed a driver.
--
-- Preserve: airport_pricing hold refuse; any non-null scheduled_hold_reason refuse
-- without the explicit release setting; release helper opt-in still works.
-- Allow: reopen when scheduled_hold_reason is NULL (instant negotiation rematch).

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
    -- Airport pricing hold: stay closed until authorised release helper.
    IF COALESCE(NEW.scheduled_hold_reason, '') = 'airport_pricing'
       OR COALESCE(OLD.scheduled_hold_reason, '') = 'airport_pricing'
    THEN
      NEW.broadcast_enabled := FALSE;
      NEW.scheduled_hold_reason := 'airport_pricing';
    ELSIF current_setting('onecab.release_airport_broadcast_hold', true) = '1' THEN
      -- Explicit SECURITY DEFINER release path opted in for this transaction.
      NULL;
    ELSIF COALESCE(NEW.scheduled_hold_reason, OLD.scheduled_hold_reason, '') <> '' THEN
      -- Any other active scheduled hold reason without release opt-in stays closed.
      NEW.broadcast_enabled := FALSE;
    END IF;
    -- scheduled_hold_reason IS NULL → allow reopen (negotiation rematch, etc.).
  END IF;
  RETURN NEW;
END;
$function$;
