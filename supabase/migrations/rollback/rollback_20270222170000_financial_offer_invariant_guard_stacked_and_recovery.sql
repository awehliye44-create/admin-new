-- Rollback of 20270222170000: restore the 20270222160000 guard (stacked skipped, committed-columns only).
-- LOCAL / release-candidate only. Does not touch any offer row.

CREATE OR REPLACE FUNCTION public.tr_ride_offer_financial_invariant_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_payable integer;
  v_base integer;
  v_old_base integer;
  v_checked boolean := false;
BEGIN
  IF COALESCE(NEW.is_stacked, false) THEN RETURN NEW; END IF;
  IF NEW.trip_id IS NULL OR NEW.offer_snapshot IS NULL THEN RETURN NEW; END IF;

  BEGIN
    v_base := public.offer_jsonb_pence(NEW.offer_snapshot, 'baseFarePence');
    IF v_base = 0 THEN
      v_base := public.offer_jsonb_pence(NEW.offer_snapshot, 'base_fare_pence');
    END IF;
    IF v_base = 0 THEN
      v_base := public.offer_jsonb_pence(NEW.offer_snapshot, 'final_trip_fare_pence');
    END IF;
    IF v_base <= 0 THEN RETURN NEW; END IF;

    -- UPDATE: only when this statement changes the snapshot base.
    IF TG_OP = 'UPDATE' THEN
      v_old_base := COALESCE(NULLIF(public.offer_jsonb_pence(OLD.offer_snapshot, 'baseFarePence'), 0),
                             NULLIF(public.offer_jsonb_pence(OLD.offer_snapshot, 'base_fare_pence'), 0),
                             NULLIF(public.offer_jsonb_pence(OLD.offer_snapshot, 'final_trip_fare_pence'), 0),
                             0);
      IF v_old_base = v_base THEN RETURN NEW; END IF;
    END IF;

    SELECT * INTO v_trip FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    -- Committed ONLY: a trip with just a breakdown / fare column is not a committed payable.
    IF GREATEST(0, COALESCE(v_trip.locked_base_fare_pence, 0)) = 0
       AND GREATEST(0, COALESCE(v_trip.final_customer_fare_pence, 0)) = 0
       AND GREATEST(0, COALESCE(v_trip.final_fare_pence, 0)) = 0
       AND GREATEST(0, COALESCE(v_trip.estimated_total_pence, 0)) = 0
       AND GREATEST(0, COALESCE(v_trip.authorised_amount_pence, 0)) = 0 THEN
      RETURN NEW;
    END IF;

    v_payable := public.trip_negotiation_base_fare_pence(v_trip);
    IF v_payable IS NULL OR v_payable <= 0 THEN RETURN NEW; END IF;

    v_checked := abs(v_base - v_payable) > 1;
  EXCEPTION WHEN OTHERS THEN
    -- Monitoring guard: never break offer writes because the check itself failed.
    RAISE LOG '[ride_offer_financial_invariant_guard] check skipped offer_id=% trip_id=% err=%',
      NEW.id, NEW.trip_id, SQLERRM;
    RETURN NEW;
  END;

  IF NOT v_checked THEN RETURN NEW; END IF;

  IF NEW.status = 'pending' THEN
    RAISE EXCEPTION
      'FINANCIAL_OFFER_INVARIANT: offer snapshot base % disagrees with committed payable % for trip %',
      v_base, v_payable, NEW.trip_id
      USING ERRCODE = 'FO001',
            HINT = 'Re-stamp the offer from the committed fare (restamp_pending_offer_financials_for_trip) instead of writing a stale quote.';
  END IF;

  RAISE WARNING
    'FINANCIAL_OFFER_INVARIANT (accepted, not blocked): offer snapshot base % disagrees with committed payable % for trip %',
    v_base, v_payable, NEW.trip_id;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tr_ride_offer_financial_invariant_guard_fn() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tr_ride_offer_financial_invariant_guard_fn() TO service_role;

DROP TRIGGER IF EXISTS zz_ride_offer_financial_invariant_guard ON public.ride_offers;
CREATE TRIGGER zz_ride_offer_financial_invariant_guard
  BEFORE INSERT OR UPDATE OF offer_snapshot, offered_driver_net_pence
  ON public.ride_offers
  FOR EACH ROW
  WHEN (NEW.status IN ('pending', 'accepted'))
  EXECUTE FUNCTION public.tr_ride_offer_financial_invariant_guard_fn();

DROP FUNCTION IF EXISTS public.offer_trip_financial_authority(public.trips);
