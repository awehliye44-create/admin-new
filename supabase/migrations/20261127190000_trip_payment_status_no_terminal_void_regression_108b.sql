-- #108B — trips.payment_status must not regress to pre-capture after a
-- terminal void projection (canceled/cancelled), matching the edge guard
-- extension for delayed ORDER_AUTHORISED after NO_FEE_FULL_RELEASE
-- (MK-261127-002). Capture refuse from #108 is preserved.
-- No production row repair in this migration.

CREATE OR REPLACE FUNCTION public.trips_refuse_regressive_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  incoming text := lower(btrim(coalesce(NEW.payment_status, '')));
  prior text := lower(btrim(coalesce(OLD.payment_status, '')));
  hold text := lower(btrim(coalesce(OLD.payment_hold_status, '')));
  trip_st text := lower(btrim(coalesce(OLD.status, '')));
  capture_pence integer := coalesce(OLD.capture_amount_pence, 0);
  pre_capture boolean := incoming IN (
    'authorized', 'authorised', 'pending', 'processing',
    'capture_requested', 'capture_pending',
    'preauth_authorized', 'preauth_authorised'
  );
  prior_confirmed boolean := prior IN ('captured', 'paid', 'completed');
  row_confirmed boolean := hold = 'captured' AND capture_pence > 0;
  prior_voided boolean := prior IN ('canceled', 'cancelled');
  trip_terminal boolean := trip_st IN ('cancelled', 'canceled', 'no_show');
BEGIN
  IF pre_capture AND (prior_confirmed OR row_confirmed) THEN
    IF prior_confirmed THEN
      NEW.payment_status := OLD.payment_status;
    ELSE
      NEW.payment_status := 'captured';
    END IF;
  ELSIF pre_capture AND (prior_voided OR trip_terminal) THEN
    -- Keep the terminal void projection; refuse AUTHORISED echo.
    NEW.payment_status := OLD.payment_status;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trips_refuse_regressive_payment_status() IS
  '#108/#108B writer backstop: refuse pre-capture payment_status writes after confirmed capture or terminal void/cancelled trip projection. No provider mutation.';
