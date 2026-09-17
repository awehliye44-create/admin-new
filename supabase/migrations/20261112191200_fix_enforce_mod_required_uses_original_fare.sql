-- Fix: enforce_trip_change_payment_before_apply double-counted fare delta
-- after apply_trip_modification_to_trip updated trips.final_* before status=applied.
-- Required payable must be new_fare (from original_fare + delta), not post-apply final + delta.
-- Rollback: rollback/rollback_20261112191200_fix_enforce_mod_required_uses_original_fare.sql
BEGIN;

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

  v_model := upper(trim(COALESCE(v_trip.financial_model::text, '')));
  IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    RETURN NEW;
  END IF;

  -- Committed basis is the pre-modification fare on the TCR.
  -- Do NOT use trips.final_* here: apply_approved updates the trip BEFORE
  -- status=applied, which would double-count fare_delta into required.
  v_committed := GREATEST(0, COALESCE(NEW.original_fare_pence, 0));
  IF v_committed <= 0 THEN
    v_committed := GREATEST(
      0,
      COALESCE(v_trip.final_customer_fare_pence, 0),
      COALESCE(v_trip.locked_base_fare_pence, 0)
    );
  END IF;
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
    AND ps.purpose IS DISTINCT FROM 'PAYMENT_RECOVERY'::public.payment_session_purpose
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

REVOKE ALL ON FUNCTION public.enforce_trip_change_payment_before_apply() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_trip_change_payment_before_apply() TO service_role;

COMMIT;
