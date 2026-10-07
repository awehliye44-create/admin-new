-- Order 3: customer rating on EVERY ride offer, not only Edge auto-dispatch.
--
-- First-round offers are written by the database dispatcher
-- (dispatch_trip_offers overloads via tr_dispatch_trip_offers and
-- activate_paid_corporate_trip). Those rows never carried
-- passenger_rating / passenger_rating_count, so the Driver offer card could
-- not show "★ 4.9" / "New customer" for most offers.
--
-- Shape mirrors supabase/functions/_shared/passengerOfferRating.ts
-- (mapPassengerOfferRating), source public.get_customer_trip_stats:
--   rating_count > 0, avg 1–5 → { passenger_rating: avg (2dp), passenger_rating_count: n }
--   rating_count = 0          → { passenger_rating: null, passenger_rating_count: 0 }  ("New customer")
--   unknown / failure         → { passenger_rating: null, passenger_rating_count: null }
-- Aggregate only — never name, phone, email or plate.
--
-- A writer that already stamped passenger_rating_count (Edge auto-dispatch via
-- commit_dispatch_wave) is left untouched. Dispatcher bodies, wave logic,
-- offer TTL, radius, pricing, payment and category eligibility are unchanged.

CREATE OR REPLACE FUNCTION public.passenger_offer_rating(p_passenger_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unknown constant jsonb := jsonb_build_object(
    'passenger_rating', NULL, 'passenger_rating_count', NULL);
  v_avg   numeric;
  v_count integer;
BEGIN
  IF p_passenger_id IS NULL THEN
    RETURN v_unknown;
  END IF;

  SELECT s.avg_rating, s.rating_count
    INTO v_avg, v_count
    FROM public.get_customer_trip_stats(p_passenger_id) s;

  IF v_count IS NULL THEN
    RETURN v_unknown;
  END IF;
  IF v_count <= 0 THEN
    RETURN jsonb_build_object('passenger_rating', NULL, 'passenger_rating_count', 0);
  END IF;
  -- Stars are 1–5; anything else is not a rating.
  IF v_avg IS NULL OR v_avg < 1 OR v_avg > 5 THEN
    RETURN v_unknown;
  END IF;

  RETURN jsonb_build_object(
    'passenger_rating', round(v_avg, 2)::double precision,
    'passenger_rating_count', v_count);
EXCEPTION WHEN OTHERS THEN
  RAISE LOG '[passenger_offer_rating] stats_failed passenger_id=% err=%', p_passenger_id, SQLERRM;
  RETURN v_unknown;
END;
$function$;

REVOKE ALL ON FUNCTION public.passenger_offer_rating(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.passenger_offer_rating(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passenger_offer_rating(uuid) TO service_role;

COMMENT ON FUNCTION public.passenger_offer_rating(uuid) IS
  'Order 3: aggregate customer rating for the Driver offer card. Mirrors _shared/passengerOfferRating.ts mapPassengerOfferRating. No identity fields.';

CREATE OR REPLACE FUNCTION public.tr_stamp_offer_passenger_rating_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_passenger_id uuid;
  v_rating       jsonb;
BEGIN
  IF COALESCE(NEW.offer_snapshot, '{}'::jsonb) ? 'passenger_rating_count' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT t.passenger_id INTO v_passenger_id FROM public.trips t WHERE t.id = NEW.trip_id;
    v_rating := public.passenger_offer_rating(v_passenger_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[tr_stamp_offer_passenger_rating] failed trip_id=% err=%', NEW.trip_id, SQLERRM;
    v_rating := jsonb_build_object('passenger_rating', NULL, 'passenger_rating_count', NULL);
  END;

  NEW.offer_snapshot := COALESCE(NEW.offer_snapshot, '{}'::jsonb) || v_rating;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tr_stamp_offer_passenger_rating_fn() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_stamp_offer_passenger_rating_fn() FROM anon, authenticated;

DROP TRIGGER IF EXISTS tr_stamp_offer_passenger_rating ON public.ride_offers;
CREATE TRIGGER tr_stamp_offer_passenger_rating
  BEFORE INSERT ON public.ride_offers
  FOR EACH ROW EXECUTE FUNCTION public.tr_stamp_offer_passenger_rating_fn();
