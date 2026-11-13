-- Release candidate. Not applied. NO prod deploy from this change set.
--
-- Replaces public.tr_ride_offer_financial_invariant_guard_fn() (20270222160000 was already
-- pushed, so this is a NEW migration; the trigger zz_ride_offer_financial_invariant_guard is
-- re-created unchanged).
--
-- Why
--   1. 160000 SKIPPED stacked offers. Stacked offers are NOT stamped by tr_stamp_offer_presets
--      (is_stacked => RETURN NEW), so their baseFarePence / offered_driver_net_pence /
--      airport fields come straight from auto-dispatch. They were the one actionable offer
--      class with no DB financial protection.
--   2. 160000 only validated trips that carried a COMMITTED COLUMN. A breakdown-only legacy
--      trip with an authorised payment_session / fare_snapshot was skipped even though the
--      authoritative fare is recoverable; and a trip with nothing verifiable at all could
--      receive a brand-new actionable offer.
--
-- Authoritative contract (offer_trip_financial_authority)
--   committed : any of locked_base / final_customer / final_fare / estimated_total /
--               authorised_amount columns > 0 -> payable = trip_negotiation_base_fare_pence(trip)
--               (the SAME SQL SSOT the stamp uses; committedBookingOfferFareSSOT.ts parity).
--   recovered : no committed column, but the SAME SSOT resolves a payable once the unverifiable
--               legacy fallbacks (fare_breakdown / fare / estimated_fare / base_fare / bare gross)
--               are ignored: fare_snapshot_json committed keys, trip authorised amount, or the
--               payment_session authorised amount. NOT blindly rejected: validated like committed.
--   none      : nothing verifiable. Existing offers / updates / accepted are left alone; a NEW
--               pending offer is rejected (FO002) - it would be actionable with an unverifiable
--               financial snapshot.
--
-- Checks (all SQLSTATE FO001 unless noted, message prefix FINANCIAL_OFFER_INVARIANT)
--   every actionable offer (stacked or not):
--     * stale quote: snapshot base (baseFarePence | base_fare_pence | final_trip_fare_pence)
--       disagrees > 1p with the authoritative payable.
--   stacked offers additionally (their net / airport are caller supplied, never re-stamped):
--     * airport_missing      trip / quote airport > 0 but the snapshot carries no airport
--     * airport_mismatch     snapshot airport disagrees > 1p with the authoritative airport
--     * airport_double_counted  base = payable + airport, or net = expected net + airport
--     * fabricated_earnings  offered net (or snapshot net) above what the stored wave commission
--                            allows, or above the customer payable
--     * wrong_commission     offered net below the expected split (e.g. airport commissioned)
--       expected net = offer_driver_net_split(payable, airport, other, effective_commission_percent)
--       (airport + other pass-through are non-commissionable; same SQL helper as the stamp).
--   FO002  pending INSERT on a trip whose authority is 'none'.
--
-- Unchanged behaviour
--   * pending INSERT / pending UPDATE that CHANGES a guarded value -> RAISE (fail closed).
--   * accepted -> RAISE WARNING only (acceptance is never blocked by a monitoring guard).
--   * Any other status, closed / historical offers: untouched, never re-validated.
--   * Any unexpected error while evaluating -> fail OPEN (RAISE LOG), same as 160000.
--   * Stacked eligibility / workflow, presets lock, negotiation, timers, payments: not touched.
--
-- Recovery (no new retry machinery): a rejected insert aborts commit_dispatch_wave's transaction,
-- so nothing is half-written. auto-dispatch classifies the error (isFinancialOfferInvariantError)
-- and takes the SAME transient path as a unique-round collision: stamp a resumable round,
-- keep broadcasting; expire-offers resumes it while searching_expires_at and the round budget
-- remain, then expire_trip_when_search_exhausted ends the search through the normal path.
-- This migration releases no payment hold.
--
-- Requires 20270222150000 (trip_negotiation_base_fare_pence, offer_* helpers) and 20270222160000.
-- Rollback: supabase/migrations/rollback/rollback_20270222170000_financial_offer_invariant_guard_stacked_and_recovery.sql

CREATE OR REPLACE FUNCTION public.offer_trip_financial_authority(
  p_trip public.trips,
  OUT authority text,
  OUT payable integer
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_probe public.trips;
  v_has_discount boolean;
BEGIN
  IF GREATEST(0, COALESCE(p_trip.locked_base_fare_pence, 0)) > 0
     OR GREATEST(0, COALESCE(p_trip.final_customer_fare_pence, 0)) > 0
     OR GREATEST(0, COALESCE(p_trip.final_fare_pence, 0)) > 0
     OR GREATEST(0, COALESCE(p_trip.estimated_total_pence, 0)) > 0
     OR GREATEST(0, COALESCE(p_trip.authorised_amount_pence, 0)) > 0 THEN
    payable := public.trip_negotiation_base_fare_pence(p_trip);
    authority := CASE WHEN COALESCE(payable, 0) > 0 THEN 'committed' ELSE 'none' END;
    RETURN;
  END IF;

  -- Breakdown-only legacy trip: drop the unverifiable fallbacks, keep snapshot / session.
  v_probe := p_trip;
  v_probe.fare_breakdown := NULL;
  v_probe.fare := NULL;
  v_probe.estimated_fare := NULL;
  v_probe.base_fare_pence := NULL;
  v_has_discount := GREATEST(0, COALESCE(p_trip.discount_pence, 0)) > 0
    OR GREATEST(0, COALESCE(p_trip.offer_discount_pence, 0)) > 0
    OR GREATEST(0, COALESCE(p_trip.voucher_discount_pence, 0)) > 0;
  IF NOT v_has_discount THEN
    v_probe.gross_fare_pence := NULL;
  END IF;

  payable := public.trip_negotiation_base_fare_pence(v_probe);
  authority := CASE WHEN COALESCE(payable, 0) > 0 THEN 'recovered' ELSE 'none' END;
END;
$function$;

REVOKE ALL ON FUNCTION public.offer_trip_financial_authority(public.trips) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offer_trip_financial_authority(public.trips) TO service_role;

CREATE OR REPLACE FUNCTION public.tr_ride_offer_financial_invariant_guard_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_stacked boolean := COALESCE(NEW.is_stacked, false);
  v_authority text;
  v_payable integer;
  v_base integer := 0;
  v_old_base integer := 0;
  v_net integer := GREATEST(0, COALESCE(NEW.offered_driver_net_pence, 0));
  v_old_net integer := 0;
  v_snap_airport integer;
  v_old_snap_airport integer;
  v_trip_airport integer;
  v_airport integer;
  v_other integer;
  v_pct numeric;
  v_split jsonb;
  v_exp_net integer;
  v_exp_net_alt integer;
  v_exp_display integer;
  v_snap_net integer;
  v_reason text := NULL;
  v_unverifiable boolean := false;
BEGIN
  IF NEW.trip_id IS NULL THEN RETURN NEW; END IF;

  BEGIN
    IF NEW.offer_snapshot IS NOT NULL THEN
      v_base := COALESCE(NULLIF(public.offer_jsonb_pence(NEW.offer_snapshot, 'baseFarePence'), 0),
                         NULLIF(public.offer_jsonb_pence(NEW.offer_snapshot, 'base_fare_pence'), 0),
                         NULLIF(public.offer_jsonb_pence(NEW.offer_snapshot, 'final_trip_fare_pence'), 0),
                         0);
    END IF;
    v_snap_airport := COALESCE(NULLIF(public.offer_jsonb_pence(NEW.offer_snapshot, 'airport_charge_pence'), 0),
                               NULLIF(public.offer_jsonb_pence(NEW.offer_snapshot, 'airportChargePence'), 0));

    IF TG_OP = 'UPDATE' THEN
      v_old_base := COALESCE(NULLIF(public.offer_jsonb_pence(OLD.offer_snapshot, 'baseFarePence'), 0),
                             NULLIF(public.offer_jsonb_pence(OLD.offer_snapshot, 'base_fare_pence'), 0),
                             NULLIF(public.offer_jsonb_pence(OLD.offer_snapshot, 'final_trip_fare_pence'), 0),
                             0);
      v_old_net := GREATEST(0, COALESCE(OLD.offered_driver_net_pence, 0));
      v_old_snap_airport := COALESCE(NULLIF(public.offer_jsonb_pence(OLD.offer_snapshot, 'airport_charge_pence'), 0),
                                     NULLIF(public.offer_jsonb_pence(OLD.offer_snapshot, 'airportChargePence'), 0));
      IF NOT v_stacked THEN
        -- Non-stacked: net/airport are re-derived by tr_stamp_offer_presets / restamp; only a
        -- CHANGED base is guarded on UPDATE (160000 behaviour).
        IF v_base <= 0 OR v_old_base = v_base THEN RETURN NEW; END IF;
      ELSE
        IF v_old_base = v_base AND v_old_net = v_net
           AND v_old_snap_airport IS NOT DISTINCT FROM v_snap_airport THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;

    SELECT * INTO v_trip FROM public.trips WHERE id = NEW.trip_id;
    IF NOT FOUND THEN RETURN NEW; END IF;

    SELECT a.authority, a.payable INTO v_authority, v_payable
    FROM public.offer_trip_financial_authority(v_trip) a;

    IF v_authority = 'none' OR COALESCE(v_payable, 0) <= 0 THEN
      -- Nothing verifiable. Only a NEW actionable offer is refused.
      IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
        v_unverifiable := true;
      ELSE
        RETURN NEW;
      END IF;
    ELSE
      -- 1. Stale quote / base disagreement (stacked and non-stacked).
      IF v_base > 0 AND abs(v_base - v_payable) > 1 THEN
        v_trip_airport := public.offer_resolve_airport_pence(v_trip);
        IF v_trip_airport > 0 AND abs(v_base - (v_payable + v_trip_airport)) <= 1 THEN
          v_reason := format('airport_double_counted: snapshot base %s = committed payable %s + airport %s',
                             v_base, v_payable, v_trip_airport);
        ELSIF v_base > v_payable THEN
          v_reason := format('stale_quote_over_committed: snapshot base %s disagrees with committed payable %s',
                             v_base, v_payable);
        ELSE
          v_reason := format('snapshot base %s disagrees with committed payable %s', v_base, v_payable);
        END IF;
      END IF;

      -- 2. Stacked offers: caller-supplied airport / earnings / commission.
      IF v_reason IS NULL AND v_stacked THEN
        v_trip_airport := public.offer_resolve_airport_pence(v_trip);   -- NULL unknown / 0 zero / >0
        v_other := GREATEST(0, COALESCE(v_trip.other_pass_through_charges_pence, 0));
        v_pct := NEW.effective_commission_percent;

        IF COALESCE(v_trip_airport, 0) > 0 AND COALESCE(v_snap_airport, 0) = 0 THEN
          v_reason := format('airport_missing: trip/quote airport %s but offer snapshot carries none', v_trip_airport);
        ELSIF COALESCE(v_snap_airport, 0) > 0 AND v_trip_airport IS NOT NULL
              AND abs(v_snap_airport - v_trip_airport) > 1 THEN
          v_reason := format('airport_mismatch: snapshot airport %s vs authoritative airport %s',
                             v_snap_airport, v_trip_airport);
        END IF;

        IF v_reason IS NULL THEN
          v_airport := LEAST(COALESCE(v_trip_airport, v_snap_airport, 0), v_payable);
          v_snap_net := COALESCE(
            NULLIF(public.offer_jsonb_pence(NEW.offer_snapshot, 'driver_net_preview_pence'), 0),
            NULLIF(public.offer_jsonb_pence(NEW.offer_snapshot, 'driver_earnings_pence'), 0),
            NULLIF(public.offer_jsonb_pence(NEW.offer_snapshot, 'driver_net_fare_pence'), 0),
            0);

          IF v_pct IS NOT NULL AND v_pct >= 0 AND v_pct <= 100 THEN
            v_split := public.offer_driver_net_split(
              v_payable, v_airport, v_other, v_pct, NEW.base_commission_percent);
            v_exp_net := (v_split ->> 'net_pence')::int;
            v_exp_display := (v_split ->> 'display_net_pence')::int;
            -- auto-dispatch builds the stacked net from the SNAPSHOT's other_pass_through (never carried
            -- there), so a trip with other pass-through > 0 is also valid when netted with other = 0.
            -- Netting without it can only LOWER the driver's net, so this never admits inflated earnings.
            v_exp_net_alt := v_exp_net;
            IF v_other > 0 THEN
              v_exp_net_alt := (public.offer_driver_net_split(
                v_payable, v_airport, 0, v_pct, NEW.base_commission_percent) ->> 'net_pence')::int;
            END IF;

            IF v_net > 0 AND abs(v_net - v_exp_net) > 1 AND abs(v_net - v_exp_net_alt) > 1 THEN
              IF v_airport > 0 AND abs(v_net - (v_exp_net + v_airport)) <= 1 THEN
                v_reason := format('airport_double_counted: offered net %s = expected %s + airport %s',
                                   v_net, v_exp_net, v_airport);
              ELSIF v_net > v_exp_net THEN
                v_reason := format('fabricated_earnings: offered net %s exceeds expected %s (payable %s, airport %s, commission %s%%)',
                                   v_net, v_exp_net, v_payable, v_airport, v_pct);
              ELSE
                v_reason := format('wrong_commission: offered net %s below expected %s (payable %s, airport %s, commission %s%%)',
                                   v_net, v_exp_net, v_payable, v_airport, v_pct);
              END IF;
            ELSIF v_snap_net > 0
                  AND abs(v_snap_net - v_exp_net) > 1 AND abs(v_snap_net - v_exp_display) > 1
                  AND abs(v_snap_net - v_exp_net_alt) > 1 THEN
              IF v_airport > 0 AND abs(v_snap_net - (v_exp_net + v_airport)) <= 1 THEN
                v_reason := format('airport_double_counted: snapshot net %s = expected %s + airport %s',
                                   v_snap_net, v_exp_net, v_airport);
              ELSIF v_snap_net > v_exp_net THEN
                v_reason := format('fabricated_earnings: snapshot net %s exceeds expected %s', v_snap_net, v_exp_net);
              ELSE
                v_reason := format('wrong_commission: snapshot net %s below expected %s', v_snap_net, v_exp_net);
              END IF;
            END IF;
          ELSE
            -- No stored commission to recompute with: earnings can still never exceed the payable.
            IF v_net > v_payable + 1 OR v_snap_net > v_payable + 1 THEN
              v_reason := format('fabricated_earnings: net %s exceeds customer payable %s',
                                 GREATEST(v_net, v_snap_net), v_payable);
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Monitoring guard: never break offer writes because the check itself failed.
    RAISE LOG '[ride_offer_financial_invariant_guard] check skipped offer_id=% trip_id=% err=%',
      NEW.id, NEW.trip_id, SQLERRM;
    RETURN NEW;
  END;

  IF v_unverifiable THEN
    RAISE EXCEPTION
      'FINANCIAL_OFFER_INVARIANT: no verifiable financial snapshot (committed payable, fare snapshot or authorised payment) for trip %',
      NEW.trip_id
      USING ERRCODE = 'FO002',
            HINT = 'Recover the fare from the payment session / fare snapshot or hold the trip; do not dispatch an unverifiable offer.';
  END IF;

  IF v_reason IS NULL THEN RETURN NEW; END IF;

  IF NEW.status = 'pending' THEN
    RAISE EXCEPTION 'FINANCIAL_OFFER_INVARIANT: % (trip %, stacked %)', v_reason, NEW.trip_id, v_stacked
      USING ERRCODE = 'FO001',
            HINT = 'Re-stamp / rebuild the offer from the committed fare (restamp_pending_offer_financials_for_trip) instead of writing a stale or fabricated quote.';
  END IF;

  RAISE WARNING 'FINANCIAL_OFFER_INVARIANT (accepted, not blocked): % (trip %, stacked %)',
    v_reason, NEW.trip_id, v_stacked;
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
