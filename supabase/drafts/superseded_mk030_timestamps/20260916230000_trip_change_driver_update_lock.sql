-- Migration 20260916230000: close driver PostgREST forge of payment_status
-- Drivers must respond only via Edge (service_role). Apply of PLATFORM fare
-- increases requires protected hold >= revised payable, not a forgeable flag.
-- Rollback: rollback/rollback_20260916230000_trip_change_driver_update_lock.sql
BEGIN;

-- 1) Drop known/client UPDATE+DELETE policies on trip_change_requests.
DROP POLICY IF EXISTS "Drivers can respond to modification requests" ON public.trip_change_requests;
DROP POLICY IF EXISTS "Drivers can update modification requests" ON public.trip_change_requests;
DROP POLICY IF EXISTS "Drivers can update trip change requests" ON public.trip_change_requests;
DROP POLICY IF EXISTS "Drivers can respond to trip change requests" ON public.trip_change_requests;
DROP POLICY IF EXISTS "Assigned drivers can update trip_change_requests" ON public.trip_change_requests;
DROP POLICY IF EXISTS "Customers can update modification requests" ON public.trip_change_requests;
DROP POLICY IF EXISTS "Customers can update their trip modification requests" ON public.trip_change_requests;

-- Revoke direct table mutation from authenticated (Edge uses service_role).
REVOKE UPDATE, DELETE ON public.trip_change_requests FROM authenticated;
REVOKE UPDATE, DELETE ON public.trip_change_requests FROM anon;

-- Keep SELECT policies; INSERT remains customer-create (tightened in 20260916224500).
-- service_role retains full access by default.

-- 2) Strengthen apply guard: PLATFORM positive increase needs confirmed payment
--    AND protected authorisation covering the revised payable (not status string alone).
CREATE OR REPLACE FUNCTION public.enforce_trip_change_payment_before_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_committed int := 0;
  v_new int := 0;
  v_increase int := 0;
  v_required int := 0;
  v_protected int := 0;
  v_session_auth int := 0;
  v_model text;
  v_has_auth_evidence boolean := false;
BEGIN
  IF NEW.status IS DISTINCT FROM 'approved'
     AND NEW.status IS DISTINCT FROM 'applied' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = NEW.trip_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_model := upper(trim(COALESCE(v_trip.financial_model, '')));
  IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    RETURN NEW;
  END IF;

  v_committed := GREATEST(
    0,
    COALESCE(v_trip.final_customer_fare_pence, 0),
    COALESCE(v_trip.estimated_total_pence, 0),
    COALESCE(v_trip.locked_base_fare_pence, 0)
  );
  v_new := GREATEST(0, COALESCE(NEW.new_fare_pence, 0));
  v_increase := GREATEST(
    COALESCE(NEW.fare_delta_pence, 0),
    CASE WHEN v_new > 0 THEN GREATEST(0, v_new - v_committed) ELSE 0 END
  );

  IF v_increase <= 0 THEN
    RETURN NEW;
  END IF;

  IF lower(COALESCE(NEW.payment_status, '')) IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
      USING ERRCODE = 'P0001',
            DETAIL = 'cannot apply fare-increasing modification without confirmed payment';
  END IF;

  v_required := GREATEST(v_new, v_committed + v_increase);

  v_protected := GREATEST(0, COALESCE(v_trip.authorised_amount_pence, 0));

  SELECT GREATEST(
    0,
    COALESCE(ps.total_authorised_amount_pence, 0),
    COALESCE(ps.authorised_amount_pence, 0)
  )
  INTO v_session_auth
  FROM public.payment_sessions ps
  WHERE ps.trip_id = NEW.trip_id
    AND COALESCE(ps.purpose, '') IS DISTINCT FROM 'PAYMENT_RECOVERY'
  ORDER BY ps.created_at DESC
  LIMIT 1;

  v_protected := GREATEST(v_protected, COALESCE(v_session_auth, 0));

  SELECT EXISTS (
    SELECT 1
    FROM public.payment_session_authorisations psa
    WHERE psa.trip_change_request_id = NEW.id
      AND psa.status = 'ADDITIONAL_AUTHORISATION_CONFIRMED'
  )
  INTO v_has_auth_evidence;

  -- Fail closed unless hold covers revised payable AND (claim evidence OR
  -- already-covering hold when no increment was needed beyond existing auth).
  IF v_protected < v_required THEN
    RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'protected=%s required=%s — cannot apply unpaid fare increase',
              v_protected,
              v_required
            );
  END IF;

  -- When an increment was required above the prior committed basis, require
  -- claim/provider evidence row so a forged payment_status alone cannot apply.
  IF v_required > v_committed AND v_has_auth_evidence IS NOT TRUE THEN
    RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
      USING ERRCODE = 'P0001',
            DETAIL = 'missing ADDITIONAL_AUTHORISATION_CONFIRMED evidence for fare increase';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trip_change_payment_before_apply ON public.trip_change_requests;
CREATE TRIGGER trg_trip_change_payment_before_apply
  BEFORE INSERT OR UPDATE OF status, payment_status, fare_delta_pence, new_fare_pence
  ON public.trip_change_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trip_change_payment_before_apply();

REVOKE ALL ON FUNCTION public.enforce_trip_change_payment_before_apply() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_trip_change_payment_before_apply() TO service_role;

COMMIT;
