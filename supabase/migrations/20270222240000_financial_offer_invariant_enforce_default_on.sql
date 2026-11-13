-- Production follow-up: enforce FO001/FO002 by default after Edge+SQL cutover.
-- ALTER DATABASE SET onecab.enforce_offer_financial_invariant is unavailable on hosted
-- Supabase (42501). This flips the guard default to ON; SET LOCAL ...='off' backs out a session.
-- Requires 20270222230000. Rollback: restore 230000 warn-default function body.

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
  -- Rollout-safe: pending violations only RAISE EXCEPTION when explicitly enforced.
  -- Hosted Supabase cannot ALTER DATABASE SET custom GUCs (postgres not superuser).
  -- Default ENFORCE when unset; session back-out: SET LOCAL ... = 'off'.
  v_enforce boolean := lower(btrim(COALESCE(current_setting('onecab.enforce_offer_financial_invariant', true), 'on')))
                       NOT IN ('off', 'false', '0', 'no');
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
            -- global_offer: expected net is on the PRE-promotion total (MK-007 6820), see 20270222210000.
            v_split := public.offer_driver_net_split_for_trip(
              v_trip, v_payable, v_airport, v_other, v_pct, NEW.base_commission_percent);
            v_exp_net := (v_split ->> 'net_pence')::int;
            v_exp_display := (v_split ->> 'display_net_pence')::int;
            -- auto-dispatch builds the stacked net from the SNAPSHOT's other_pass_through (never carried
            -- there), so a trip with other pass-through > 0 is also valid when netted with other = 0.
            -- Netting without it can only LOWER the driver's net, so this never admits inflated earnings.
            v_exp_net_alt := v_exp_net;
            IF v_other > 0 THEN
              v_exp_net_alt := (public.offer_driver_net_split_for_trip(
                v_trip, v_payable, v_airport, 0, v_pct, NEW.base_commission_percent) ->> 'net_pence')::int;
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
    IF v_enforce THEN
      RAISE EXCEPTION
        'FINANCIAL_OFFER_INVARIANT: no verifiable financial snapshot (committed payable, fare snapshot or authorised payment) for trip %',
        NEW.trip_id
        USING ERRCODE = 'FO002',
              HINT = 'Recover the fare from the payment session / fare snapshot or hold the trip; do not dispatch an unverifiable offer.';
    END IF;
    RAISE WARNING
      'FINANCIAL_OFFER_INVARIANT FO002 (pending, warn-only: onecab.enforce_offer_financial_invariant is not on): no verifiable financial snapshot for trip %',
      NEW.trip_id;
    RETURN NEW;
  END IF;

  IF v_reason IS NULL THEN RETURN NEW; END IF;

  IF NEW.status = 'pending' THEN
    IF v_enforce THEN
      RAISE EXCEPTION 'FINANCIAL_OFFER_INVARIANT: % (trip %, stacked %)', v_reason, NEW.trip_id, v_stacked
        USING ERRCODE = 'FO001',
              HINT = 'Re-stamp / rebuild the offer from the committed fare (restamp_pending_offer_financials_for_trip) instead of writing a stale or fabricated quote.';
    END IF;
    -- Default (rollout): never reject a booking / dispatch because an OLD Edge still writes the
    -- previous commission base. Still logged; financial-ssot-monitor flags the row.
    RAISE WARNING 'FINANCIAL_OFFER_INVARIANT FO001 (pending, warn-only: onecab.enforce_offer_financial_invariant is not on): % (trip %, stacked %)',
      v_reason, NEW.trip_id, v_stacked;
    RETURN NEW;
  END IF;

  RAISE WARNING 'FINANCIAL_OFFER_INVARIANT (accepted, not blocked): % (trip %, stacked %)',
    v_reason, NEW.trip_id, v_stacked;
  RETURN NEW;
END;
$function$


