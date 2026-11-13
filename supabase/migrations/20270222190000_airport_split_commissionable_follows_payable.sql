-- Release candidate. Not applied. NO prod deploy from this change set.
--
-- MK-007: commissionable stamp must follow the customer payable when a discount applies.
--
-- Defect
--   apply_consumed_server_fare_airport_split_to_trip (20270219120000) stamped
--     trips.commissionable_fare_pence = quote ride fare (pricing_evidence.trip_fare_pence)
--   even when the customer payable it was handed (p_payable_pence, post-discount) is LOWER
--   than ride + airport. Example (MK-007): quote ride 6800 + airport 700 = 7500, discounted
--   payable 7300  =>  stamped commissionable 6800, but the customer only pays 7300 - 700 = 6600.
--   The TypeScript twin (airportChargeFareSplitSSOT.bookingFareSplitFromQuote) already
--   handles this; the SQL write path did not.
--
-- Fix (NEW stamps only)
--   rideCoveredByPayable := ride > 0 AND (payable <= 0 OR payable >= ride + airport)
--   commissionable       := rideCoveredByPayable ? ride : GREATEST(0, payable - airport)
--   i.e. commissionable = payable - airport whenever the payable undershoots ride + airport.
--   Driver total under the existing policy: (7300 - 700) x 0.9 + 700 = 6640.
--   Same rule as the SQL offer stamp (offer_driver_net_split: commissionable = gross - airport).
--
-- Scope
--   * Write path for NEW trips only (finalize_paid_booking_session -> this function). The
--     function already returns early when airport_charge_pence is stamped; nothing here
--     selects, updates or backfills an existing trip, snapshot, ledger or settlement.
--   * fare_breakdown keeps the QUOTE's tripFare / trip_fare_pence (it is the quote, not the
--     payable). Only commissionable_fare_pence (column + fare_snapshot_json + return value) change.
--   * No historical rewrite. No payment / Revolut / capture / settlement change.
--
-- Patched from the LIVE pg_get_functiondef (same pattern as 20270222130000): the binding checks,
-- hold semantics and read-back are not re-typed.
--
-- Rollback: supabase/migrations/rollback/rollback_20270222190000_airport_split_commissionable_follows_payable.sql

DO $patch$
DECLARE
  v_def text;
  v_sig constant text :=
    'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)';
  v_decl_marker constant text := E'  v_existing int;\nBEGIN\n';
  v_decl_inject constant text :=
    E'  v_existing int;\n  v_commissionable int := 0; -- commissionable follows payable (MK-007)\nBEGIN\n';
  v_calc_marker constant text := E'  v_breakdown := jsonb_build_object(\n';
  v_calc_inject constant text :=
$inj$
  -- commissionable = quote ride fare only while the payable covers ride + airport;
  -- otherwise payable - airport (a discounted payable can never be commissioned above itself).
  IF v_trip_fare > 0 AND (v_payable <= 0 OR v_payable >= v_trip_fare + v_airport) THEN
    v_commissionable := v_trip_fare;
  ELSE
    v_commissionable := GREATEST(0, v_payable - v_airport);
  END IF;

$inj$;
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION '% missing', v_sig;
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(v_sig)) INTO v_def;

  IF position('v_commissionable' in v_def) > 0 THEN
    RAISE NOTICE 'apply_consumed_server_fare_airport_split_to_trip already follows payable';
    RETURN;
  END IF;
  IF position(v_decl_marker in v_def) = 0
     OR position(v_calc_marker in v_def) = 0
     OR position('commissionable_fare_pence = v_trip_fare,' in v_def) = 0
     OR position('''commissionable_fare_pence'', v_trip_fare,' in v_def) = 0 THEN
    RAISE EXCEPTION 'apply_consumed_server_fare_airport_split_to_trip patch marker not found - abort';
  END IF;

  v_def := replace(v_def, v_decl_marker, v_decl_inject);
  v_def := replace(v_def, v_calc_marker, v_calc_inject || v_calc_marker);
  v_def := replace(v_def, 'commissionable_fare_pence = v_trip_fare,', 'commissionable_fare_pence = v_commissionable,');
  v_def := replace(v_def, '''commissionable_fare_pence'', v_trip_fare,', '''commissionable_fare_pence'', v_commissionable,');
  EXECUTE v_def;
END
$patch$;
