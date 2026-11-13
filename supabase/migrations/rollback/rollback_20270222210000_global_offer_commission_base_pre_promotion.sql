-- Rollback of 20270222210000: back to the 20270222190000 / 20270222150000 behaviour
-- (commissionable follows the discounted payable; offer net split on the committed payable).
-- LOCAL / release-candidate only. No row is rewritten; offers / trips already stamped keep their values.
-- NOTE: rolling this back re-introduces the MK-007 global_offer driver under-payment (6640 instead of 6820).
-- Run rollback_20270222230000 FIRST (the 230000 guard calls offer_driver_net_split_for_trip).
DO $rb$
DECLARE
  v_def text;
  v_sig text;
  v_new text;
  v_old text;
BEGIN
  -- 3. airport split stamp
  v_sig := 'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)';
  SELECT pg_get_functiondef(to_regprocedure(v_sig)) INTO v_def;
  IF v_def IS NOT NULL AND position('v_promo' in v_def) > 0 THEN
    v_new := $n$
  -- global_offer is funded from ONECAB commission (tripSettlement SSOT): the commission base is
  -- the PRE-promotion total, so the promotion is added back to the payable before comparing.
  SELECT public.offer_global_offer_promotion_pence(t)
    INTO v_promo
  FROM public.trips t
  WHERE t.id = p_trip_id;
  v_promo := GREATEST(0, COALESCE(v_promo, 0));
  IF v_trip_fare > 0 AND (v_payable <= 0 OR v_payable + v_promo >= v_trip_fare + v_airport) THEN
$n$;
    v_old := E'  IF v_trip_fare > 0 AND (v_payable <= 0 OR v_payable >= v_trip_fare + v_airport) THEN\n';
    v_def := replace(v_def, v_new, v_old);
    v_def := replace(v_def, E'  v_promo int := 0; -- ONECAB-funded global_offer promotion (never a driver deduction)\n', '');
    v_def := replace(v_def, E'    v_commissionable := GREATEST(0, v_payable + v_promo - v_airport);\n',
                            E'    v_commissionable := GREATEST(0, v_payable - v_airport);\n');
    EXECUTE v_def;
  END IF;

  -- 4a. offer stamp
  v_sig := 'public.tr_stamp_offer_presets_fn()';
  SELECT pg_get_functiondef(to_regprocedure(v_sig)) INTO v_def;
  IF v_def IS NOT NULL AND position('offer_driver_net_split_for_trip' in v_def) > 0 THEN
    v_def := replace(v_def,
      E'v_split := public.offer_driver_net_split_for_trip(\n      v_trip, v_base_pence, v_airport_pence, v_other_pence, v_effective_pct, v_base_pct\n    );',
      E'v_split := public.offer_driver_net_split(\n      v_base_pence, v_airport_pence, v_other_pence, v_effective_pct, v_base_pct\n    );');
    v_def := replace(v_def,
      '''platform_commission_pence'', CASE WHEN COALESCE((v_split->>''locked_promotion_pence'')::int, 0) > 0 THEN (v_split->>''commission_pence'')::int ELSE GREATEST(0, v_base_pence - v_net_pence) END',
      '''platform_commission_pence'', GREATEST(0, v_base_pence - v_net_pence)');
    EXECUTE v_def;
  END IF;

  -- 4b. defence restamp
  v_sig := 'public.restamp_pending_offer_financials_for_trip(uuid)';
  SELECT pg_get_functiondef(to_regprocedure(v_sig)) INTO v_def;
  IF v_def IS NOT NULL AND position('offer_driver_net_split_for_trip' in v_def) > 0 THEN
    v_def := replace(v_def,
      E'v_split := public.offer_driver_net_split_for_trip(\n      v_trip, v_base, v_airport, v_other,\n      v_offer.effective_commission_percent, v_offer.base_commission_percent\n    );',
      E'v_split := public.offer_driver_net_split(\n      v_base, v_airport, v_other,\n      v_offer.effective_commission_percent, v_offer.base_commission_percent\n    );');
    v_def := replace(v_def,
      '''platform_commission_pence'', CASE WHEN COALESCE((v_split->>''locked_promotion_pence'')::int, 0) > 0 THEN (v_split->>''commission_pence'')::int ELSE GREATEST(0, v_base - v_net) END,',
      '''platform_commission_pence'', GREATEST(0, v_base - v_net),');
    EXECUTE v_def;
  END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.offer_driver_net_split_for_trip(public.trips, integer, integer, integer, numeric, numeric);
DROP FUNCTION IF EXISTS public.offer_global_offer_promotion_pence(public.trips);
