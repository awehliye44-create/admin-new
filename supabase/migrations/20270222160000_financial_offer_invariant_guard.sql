-- Release candidate. Not applied. NO prod deploy from this change set.
--
-- Soft DB guard: a NEW pending ride offer must not carry a snapshot base fare that
-- disagrees (> 1p) with the trip's COMMITTED payable (MK-261113-004/005 stale 500
-- beside committed 480). Defence in depth behind tr_stamp_offer_presets_fn
-- (20270222150000) — the stamp is the primary fix; this only fails closed if a stale
-- quote still reaches ride_offers.
--
-- Behaviour
--   * BEFORE INSERT OR UPDATE OF offer_snapshot, offered_driver_net_pence
--     ON ride_offers, WHEN NEW.status IN ('pending','accepted').
--   * Committed payable = public.trip_negotiation_base_fare_pence(trip) (the SAME SQL
--     SSOT the stamp uses), and ONLY when the trip carries a committed column
--     (locked_base / final_customer / final_fare / estimated_total / authorised).
--     A trip with only a fare_breakdown / fare column is NOT treated as committed.
--   * Snapshot base = baseFarePence | base_fare_pence | final_trip_fare_pence.
--     Null / absent / zero snapshot base, or no committed payable -> SKIP.
--   * pending  + INSERT                      -> RAISE EXCEPTION (fail closed)
--   * pending  + UPDATE that CHANGES the base -> RAISE EXCEPTION
--   * accepted (insert or update)            -> RAISE WARNING only. Acceptance /
--     negotiated-fare finalisation must never be blocked by a monitoring guard.
--   * Stacked offers and every other status are untouched. Closed / historical
--     offers are never rewritten and never re-validated.
--   * Any unexpected error while computing the check fails OPEN (RAISE LOG).
--
-- Error: SQLSTATE 'FO001', message prefix FINANCIAL_OFFER_INVARIANT:
--
-- Trigger ordering: BEFORE row triggers fire in NAME order. The trigger name starts
-- with "zz_" so it runs AFTER tr_stamp_offer_presets (which rewrites the snapshot to
-- the committed gross) and sees the stamped values.
--
-- NOT changed: payment / capture / Revolut policy, ledgers, trips columns, offer
-- amounts, notifications, any historical row.
--
-- Note on 20270222140000_driver_live_locations_local_schema_repair.sql: it is
-- CREATE TABLE / INDEX IF NOT EXISTS plus pg_policy-guarded policies and writes no
-- data. Production already has public.driver_live_locations, so it is a NO-OP there;
-- it only repairs LOCAL / snapshot-restored databases. This migration does not
-- depend on it.
--
-- Requires 20270222150000_committed_offer_fare_sql_ssot.sql (trip_negotiation_base_fare_pence,
-- offer_jsonb_pence).
-- Rollback: supabase/migrations/rollback/rollback_20270222160000_financial_offer_invariant_guard.sql

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
