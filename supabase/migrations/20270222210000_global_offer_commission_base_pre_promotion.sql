-- Release candidate. Not applied. NO prod deploy from this change set.
--
-- MK-007: global_offer driver earnings are 6820 (NOT 6640).
--
-- Authoritative settlement SSOT (supabase/functions/_shared/tripSettlement.ts +
-- canonicalSettlementSSOT.ts, calculateTripSettlementFromTripRow):
--   * global_offer is ONECAB-funded from commission. `locked_promotion_pence`
--     (trips.offer_discount_pence, discount_source = 'global_offer') is deducted from ONECAB
--     only. It NEVER reduces the driver entitlement.
--   * The driver entitlement uses the PRE-promotion commissionable fare.
--   MK-007: quote ride 6800 + airport 700, global_offer discount 200 -> customer pays 7300.
--     driver total = 6800 x 0.9 + 700 = 6820 ; ONECAB absorbs 200 of the 680 commission.
--     capture identity: 6120 + 680 + 700 - 200 = 7300.
--
-- Defect (20270222190000 + 20270222150000 offer stamp)
--   190000 taught apply_consumed_server_fare_airport_split_to_trip that a discounted payable
--   shrinks commissionable to payable - airport (7300 - 700 = 6600), and the 150000 offer stamp
--   (tr_stamp_offer_presets_fn / restamp_pending_offer_financials_for_trip) split the COMMITTED
--   PAYABLE (7300) -> 6600 x 0.9 + 700 = 6640. That is right for a non-subsidised discount but
--   WRONG for global_offer, which would take the 200 out of the driver's pocket instead of out of
--   ONECAB's commission.
--
-- Fix (NEW stamps / NEW offers only; 190000 and 150000 stay as pushed history, superseded here)
--   1. public.offer_global_offer_promotion_pence(trips)
--        SQL twin of tripSettlement.resolveLockedPromotionPence: the ONECAB-funded global_offer
--        promotion on the trip. 0 for voucher / unknown source / negotiated (superseded). While
--        the trip row is still unstamped (finalize_paid_booking_session inserts the trip BEFORE
--        bookingPostCommit stamps discount_source) the consumed payment session's
--        booking/fare snapshot is the evidence. Never invented.
--   2. public.offer_driver_net_split_for_trip(trips, payable, airport, other, eff%, base%)
--        offer_driver_net_split() applied to payable + promotion (the pre-promotion total) so
--        commissionable = payable + promotion - airport - other. Offer gross / baseFarePence stay
--        the customer's committed payable (7300): payment is untouched.
--   3. apply_consumed_server_fare_airport_split_to_trip (patched from the LIVE definition):
--        commissionable = quote ride whenever payable + promotion >= ride + airport.
--        payable - airport (190000) remains ONLY for undershoots that no global_offer explains.
--   4. tr_stamp_offer_presets_fn + restamp_pending_offer_financials_for_trip (patched from the LIVE
--        definitions) split via offer_driver_net_split_for_trip. platform_commission_pence on a
--        promoted offer is the GROSS commission (680), like the settlement SSOT.
--
-- Not changed: Revolut / capture / authorisation amounts, trips payable columns, presets (negotiated
-- fares supersede the promotion), ledgers, settlement code, any historical row (no backfill).
--
-- Requires 20270222150000 (offer helpers), 20270222190000 (v_commissionable in the airport split).
-- Rollback: supabase/migrations/rollback/rollback_20270222210000_global_offer_commission_base_pre_promotion.sql

-- ---------------------------------------------------------------------------
-- 1. ONECAB-funded global_offer promotion on a trip
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.offer_global_offer_promotion_pence(p_trip public.trips)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_src text := COALESCE(NULLIF(btrim(p_trip.discount_source), ''), '');
  v_promo integer := GREATEST(0, COALESCE(p_trip.offer_discount_pence, 0));
  v_snap jsonb := CASE WHEN jsonb_typeof(p_trip.fare_snapshot_json) = 'object' THEN p_trip.fare_snapshot_json ELSE NULL END;
  v_book jsonb;
  v_fare jsonb;
  v_fare_source text;
BEGIN
  -- A negotiated fare supersedes the promotion (tripSettlement.isPromotionSupersededByNegotiation).
  IF p_trip.locked_offer_type = 'negotiated_offer' THEN RETURN 0; END IF;
  IF v_snap IS NOT NULL THEN
    IF v_snap ->> 'promotion_application_status' = 'SUPERSEDED_BY_NEGOTIATION' THEN RETURN 0; END IF;
    v_fare_source := v_snap ->> 'fare_source';
    IF v_fare_source IN ('negotiated', 'negotiated_offer') THEN RETURN 0; END IF;
  END IF;

  -- Trip row not yet stamped (finalize_paid_booking_session runs before bookingPostCommit):
  -- the consumed payment session snapshot is the evidence.
  IF v_src = '' AND p_trip.payment_session_id IS NOT NULL THEN
    SELECT ps.booking_snapshot, ps.fare_snapshot INTO v_book, v_fare
    FROM public.payment_sessions ps
    WHERE ps.id = p_trip.payment_session_id;
    v_src := COALESCE(
      NULLIF(btrim(CASE WHEN jsonb_typeof(v_book) = 'object' THEN v_book ->> 'discount_source' END), ''),
      NULLIF(btrim(CASE WHEN jsonb_typeof(v_fare) = 'object' THEN v_fare ->> 'discount_source' END), ''),
      ''
    );
    IF v_src = 'global_offer' AND v_promo = 0 THEN
      v_promo := GREATEST(
        public.offer_jsonb_pence(v_fare, 'offer_discount_pence'),
        public.offer_jsonb_pence(v_book, 'offer_discount_pence')
      );
    END IF;
  END IF;

  IF v_src <> 'global_offer' THEN RETURN 0; END IF;
  RETURN v_promo;
END;
$function$;

REVOKE ALL ON FUNCTION public.offer_global_offer_promotion_pence(public.trips) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offer_global_offer_promotion_pence(public.trips) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Net split on the PRE-promotion total (payable + ONECAB-funded promotion)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.offer_driver_net_split_for_trip(
  p_trip public.trips,
  p_payable integer,
  p_airport integer,
  p_other integer,
  p_effective_percent numeric,
  p_base_percent numeric
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payable integer := GREATEST(0, COALESCE(p_payable, 0));
  v_promo integer := 0;
BEGIN
  IF v_payable > 0 THEN
    v_promo := public.offer_global_offer_promotion_pence(p_trip);
  END IF;
  RETURN public.offer_driver_net_split(
           v_payable + v_promo, p_airport, p_other, p_effective_percent, p_base_percent)
         || jsonb_build_object('locked_promotion_pence', v_promo, 'payable_pence', v_payable);
END;
$function$;

REVOKE ALL ON FUNCTION public.offer_driver_net_split_for_trip(public.trips, integer, integer, integer, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offer_driver_net_split_for_trip(public.trips, integer, integer, integer, numeric, numeric)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Airport split stamp: global_offer keeps the quote ride as commissionable
--    (patched from the LIVE definition; 190000 already injected v_commissionable)
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_sig constant text :=
    'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)';
  v_decl_marker constant text := E'  v_commissionable int := 0; -- commissionable follows payable (MK-007)\n';
  v_decl_inject constant text :=
    E'  v_commissionable int := 0; -- commissionable follows payable (MK-007)\n  v_promo int := 0; -- ONECAB-funded global_offer promotion (never a driver deduction)\n';
  v_if_marker constant text := E'  IF v_trip_fare > 0 AND (v_payable <= 0 OR v_payable >= v_trip_fare + v_airport) THEN\n';
  v_if_inject constant text :=
$inj$
  -- global_offer is funded from ONECAB commission (tripSettlement SSOT): the commission base is
  -- the PRE-promotion total, so the promotion is added back to the payable before comparing.
  SELECT public.offer_global_offer_promotion_pence(t)
    INTO v_promo
  FROM public.trips t
  WHERE t.id = p_trip_id;
  v_promo := GREATEST(0, COALESCE(v_promo, 0));
  IF v_trip_fare > 0 AND (v_payable <= 0 OR v_payable + v_promo >= v_trip_fare + v_airport) THEN
$inj$;
  v_else_marker constant text := E'    v_commissionable := GREATEST(0, v_payable - v_airport);\n';
  v_else_inject constant text := E'    v_commissionable := GREATEST(0, v_payable + v_promo - v_airport);\n';
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE EXCEPTION '% missing', v_sig;
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(v_sig)) INTO v_def;

  IF position('v_promo' in v_def) > 0 THEN
    RAISE NOTICE 'apply_consumed_server_fare_airport_split_to_trip already global_offer aware';
    RETURN;
  END IF;
  IF position(v_decl_marker in v_def) = 0
     OR position(v_if_marker in v_def) = 0
     OR position(v_else_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'apply_consumed_server_fare_airport_split_to_trip patch marker not found (apply 20270222190000 first) - abort';
  END IF;

  v_def := replace(v_def, v_decl_marker, v_decl_inject);
  v_def := replace(v_def, v_if_marker, v_if_inject);
  v_def := replace(v_def, v_else_marker, v_else_inject);
  EXECUTE v_def;
END
$patch$;

-- ---------------------------------------------------------------------------
-- 4. Offer stamp + defence restamp: split the pre-promotion total
--    (patched from the LIVE definitions - no re-typed offer logic)
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_sig text;
  v_split_old text;
  v_split_new text;
  v_pc_old text;
  v_pc_new text;
BEGIN
  -- 4a. tr_stamp_offer_presets_fn (BEFORE INSERT ride_offers)
  v_sig := 'public.tr_stamp_offer_presets_fn()';
  IF to_regprocedure(v_sig) IS NULL THEN RAISE EXCEPTION '% missing', v_sig; END IF;
  SELECT pg_get_functiondef(to_regprocedure(v_sig)) INTO v_def;
  IF position('offer_driver_net_split_for_trip' in v_def) = 0 THEN
    v_split_old := E'v_split := public.offer_driver_net_split(\n      v_base_pence, v_airport_pence, v_other_pence, v_effective_pct, v_base_pct\n    );';
    v_split_new := E'v_split := public.offer_driver_net_split_for_trip(\n      v_trip, v_base_pence, v_airport_pence, v_other_pence, v_effective_pct, v_base_pct\n    );';
    v_pc_old := '''platform_commission_pence'', GREATEST(0, v_base_pence - v_net_pence)';
    v_pc_new := '''platform_commission_pence'', CASE WHEN COALESCE((v_split->>''locked_promotion_pence'')::int, 0) > 0 THEN (v_split->>''commission_pence'')::int ELSE GREATEST(0, v_base_pence - v_net_pence) END';
    IF position(v_split_old in v_def) = 0 OR position(v_pc_old in v_def) = 0 THEN
      RAISE EXCEPTION 'tr_stamp_offer_presets_fn patch marker not found - abort';
    END IF;
    v_def := replace(v_def, v_split_old, v_split_new);
    v_def := replace(v_def, v_pc_old, v_pc_new);
    EXECUTE v_def;
  END IF;

  -- 4b. restamp_pending_offer_financials_for_trip (airport stamped after the offer exists)
  v_sig := 'public.restamp_pending_offer_financials_for_trip(uuid)';
  IF to_regprocedure(v_sig) IS NULL THEN RAISE EXCEPTION '% missing', v_sig; END IF;
  SELECT pg_get_functiondef(to_regprocedure(v_sig)) INTO v_def;
  IF position('offer_driver_net_split_for_trip' in v_def) = 0 THEN
    v_split_old := E'v_split := public.offer_driver_net_split(\n      v_base, v_airport, v_other,\n      v_offer.effective_commission_percent, v_offer.base_commission_percent\n    );';
    v_split_new := E'v_split := public.offer_driver_net_split_for_trip(\n      v_trip, v_base, v_airport, v_other,\n      v_offer.effective_commission_percent, v_offer.base_commission_percent\n    );';
    v_pc_old := '''platform_commission_pence'', GREATEST(0, v_base - v_net),';
    v_pc_new := '''platform_commission_pence'', CASE WHEN COALESCE((v_split->>''locked_promotion_pence'')::int, 0) > 0 THEN (v_split->>''commission_pence'')::int ELSE GREATEST(0, v_base - v_net) END,';
    IF position(v_split_old in v_def) = 0 OR position(v_pc_old in v_def) = 0 THEN
      RAISE EXCEPTION 'restamp_pending_offer_financials_for_trip patch marker not found - abort';
    END IF;
    v_def := replace(v_def, v_split_old, v_split_new);
    v_def := replace(v_def, v_pc_old, v_pc_new);
    EXECUTE v_def;
  END IF;
END
$patch$;
