-- Rollback for 20270222150000_committed_offer_fare_sql_ssot.sql
-- Restores the three function bodies exactly as found live on 2026-11-13 and drops the additions.

DROP TRIGGER IF EXISTS tr_restamp_pending_offers_on_airport_stamp ON public.trips;
DROP FUNCTION IF EXISTS public.tr_restamp_pending_offers_on_airport_stamp_fn();
DROP FUNCTION IF EXISTS public.restamp_pending_offer_financials_for_trip(uuid);

CREATE OR REPLACE FUNCTION public.trip_negotiation_base_fare_pence(p_trip trips)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fb jsonb;
  v_pricing_mode text;
  v_visible_pence integer;
  v_trip_fare numeric;
  v_airport numeric;
  v_estimated_pence integer;
  v_stored integer;
  v_gross_pence integer;
  v_discount_pence integer;
  v_booking_net integer;
  v_fare_pence integer;
BEGIN
  v_discount_pence := COALESCE(
    NULLIF(p_trip.discount_pence, 0),
    NULLIF(p_trip.offer_discount_pence, 0),
    0
  );
  v_gross_pence := NULLIF(p_trip.gross_fare_pence, 0);
  v_booking_net := COALESCE(
    NULLIF(p_trip.final_customer_fare_pence, 0),
    NULLIF(p_trip.final_fare_pence, 0)
  );

  IF v_booking_net IS NOT NULL
     AND v_booking_net > 0
     AND (v_gross_pence IS NULL OR v_booking_net < v_gross_pence) THEN
    RETURN v_booking_net;
  END IF;

  v_fb := COALESCE(p_trip.fare_breakdown, '{}'::jsonb);
  v_visible_pence := NULL;

  IF COALESCE((v_fb->>'finalFare')::numeric, 0) > 0 THEN
    v_visible_pence := ROUND((v_fb->>'finalFare')::numeric * 100)::integer;
  ELSIF COALESCE((v_fb->>'final_fare')::numeric, 0) > 0 THEN
    v_visible_pence := ROUND((v_fb->>'final_fare')::numeric * 100)::integer;
  ELSIF COALESCE((v_fb->>'totalFare')::numeric, 0) > 0 THEN
    v_visible_pence := ROUND((v_fb->>'totalFare')::numeric * 100)::integer;
  ELSIF COALESCE((v_fb->>'total_fare')::numeric, 0) > 0 THEN
    v_visible_pence := ROUND((v_fb->>'total_fare')::numeric * 100)::integer;
  ELSE
    v_pricing_mode := COALESCE(
      v_fb->>'pricing_mode',
      v_fb->>'pricingMode',
      v_fb->>'tripPricingMode'
    );

    v_trip_fare := COALESCE(
      NULLIF((v_fb->>'tripFare')::numeric, 0),
      NULLIF((v_fb->>'trip_fare')::numeric, 0)
    );

    IF v_trip_fare IS NOT NULL AND v_trip_fare > 0 THEN
      IF v_pricing_mode = 'ROUTE_PRICING'
         OR (v_fb->>'fixedFareApplied')::boolean IS TRUE THEN
        v_airport := COALESCE(
          NULLIF((v_fb->>'airportCharge')::numeric, 0),
          NULLIF((v_fb->>'airport_charge')::numeric, 0),
          0
        );
        v_visible_pence := ROUND((v_trip_fare + v_airport) * 100)::integer;
      ELSE
        v_visible_pence := ROUND(v_trip_fare * 100)::integer;
      END IF;
    END IF;
  END IF;

  v_estimated_pence := ROUND(COALESCE(p_trip.estimated_fare, p_trip.fare, 0) * 100)::integer;
  v_stored := NULLIF(p_trip.base_fare_pence, 0);
  v_fare_pence := v_estimated_pence;

  IF v_visible_pence IS NOT NULL AND v_visible_pence > 0 AND v_estimated_pence > 0 THEN
    IF v_estimated_pence > (v_visible_pence * 1.05)::integer THEN
      v_visible_pence := v_estimated_pence;
    END IF;
  ELSIF v_visible_pence IS NULL OR v_visible_pence <= 0 THEN
    IF v_estimated_pence > 0 THEN
      IF v_stored IS NOT NULL AND v_stored >= (v_estimated_pence * 85 / 100) THEN
        v_visible_pence := v_stored;
      ELSE
        v_visible_pence := v_estimated_pence;
      END IF;
    ELSE
      v_visible_pence := COALESCE(v_stored, 0);
    END IF;
  END IF;

  IF v_fare_pence > 0
     AND v_gross_pence IS NOT NULL
     AND v_discount_pence > 0
     AND v_fare_pence + v_discount_pence = v_gross_pence THEN
    RETURN v_fare_pence;
  END IF;

  IF v_discount_pence > 0
     AND v_gross_pence IS NOT NULL
     AND v_gross_pence > v_discount_pence
     AND v_visible_pence >= v_gross_pence THEN
    RETURN v_gross_pence - v_discount_pence;
  END IF;

  IF v_discount_pence > 0
     AND v_gross_pence IS NOT NULL
     AND v_visible_pence = v_gross_pence THEN
    RETURN GREATEST(0, v_gross_pence - v_discount_pence);
  END IF;

  RETURN GREATEST(0, COALESCE(v_visible_pence, 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.tr_stamp_offer_presets_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_result jsonb;
  v_base_pence integer;
  v_net_pence integer;
  v_display_net integer;
  v_airport_pence integer;
  v_other_pence integer;
  v_commissionable integer;
  v_commission_pence integer;
  v_display_commission integer;
  v_wave integer;
  v_base_pct numeric;
  v_reduction_pct numeric;
  v_effective_pct numeric;
  v_net_fields jsonb := '{}'::jsonb;
  v_airport_fields jsonb := '{}'::jsonb;
  v_raw numeric;
  v_annotated jsonb;
  v_item jsonb;
  v_gross integer;
  v_item_commissionable integer;
  v_item_commission integer;
  v_item_net integer;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.is_stacked, false) THEN RETURN NEW; END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = NEW.trip_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  BEGIN
    v_result := public.compute_ride_offer_preset_options(v_trip);
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[tr_stamp_offer_presets] compute failed trip_id=% offer_id=% err=%',
      NEW.trip_id, NEW.id, SQLERRM;
    v_result := jsonb_build_object('ok', false, 'reason', 'preset_compute_failed');
  END;

  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
     AND jsonb_typeof(v_result->'preset_options') = 'array'
     AND jsonb_array_length(v_result->'preset_options') >= 3 THEN
    v_base_pence := (v_result->>'base_pence')::int;
  ELSE
    v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);
  END IF;

  v_wave := COALESCE(
    NEW.dispatch_wave,
    CASE
      WHEN NEW.broadcast_round IS NOT NULL AND NEW.broadcast_round > 0
        THEN ((NEW.broadcast_round - 1) % 3) + 1
      ELSE 1
    END
  );
  IF v_wave < 1 OR v_wave > 3 THEN
    v_wave := 1;
  END IF;

  -- Admin per-wave table only. Pass floor 0 so W1 cannot pin later waves.
  SELECT wc.base_percent, wc.reduction_percent, wc.effective_percent
    INTO v_base_pct, v_reduction_pct, v_effective_pct
  FROM public.resolve_wave_commission_percent(v_wave, 0) AS wc;

  NEW.dispatch_wave := v_wave;
  NEW.base_commission_percent := v_base_pct;
  NEW.wave_commission_reduction_percent := v_reduction_pct;
  NEW.effective_commission_percent := v_effective_pct;

  v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
  IF v_airport_pence <= 0 AND v_trip.fare_breakdown IS NOT NULL THEN
    v_raw := NULLIF(v_trip.fare_breakdown->>'airport_charge_pence', '')::numeric;
    IF v_raw IS NULL OR v_raw <= 0 THEN
      v_raw := COALESCE(
        NULLIF(v_trip.fare_breakdown->>'airportCharge', '')::numeric,
        NULLIF(v_trip.fare_breakdown->>'airport_charge', '')::numeric,
        0
      );
      -- Quote JSON stores airportCharge in major units (pounds). Always convert.
      -- Do not treat a value >= 100 as already pence (£100 would become £1).
      IF v_raw > 0 THEN
        v_raw := round(v_raw * 100);
      END IF;
    END IF;
    v_airport_pence := GREATEST(0, round(COALESCE(v_raw, 0)));
  END IF;

  v_other_pence := GREATEST(0, COALESCE(v_trip.other_pass_through_charges_pence, 0));

  IF v_base_pence IS NOT NULL AND v_base_pence > 0 THEN
    v_commissionable := GREATEST(0, v_base_pence - v_airport_pence - v_other_pence);
    v_commission_pence := ROUND((v_commissionable::numeric * COALESCE(v_effective_pct, 0)) / 100.0);
    v_net_pence := GREATEST(0, v_commissionable - v_commission_pence) + v_airport_pence + v_other_pence;
    v_display_net := v_net_pence;
    IF v_net_pence = v_base_pence AND COALESCE(v_base_pct, 0) > 0 THEN
      v_display_commission := ROUND((v_commissionable::numeric * v_base_pct) / 100.0);
      v_display_net := GREATEST(0, v_commissionable - v_display_commission) + v_airport_pence + v_other_pence;
    END IF;
    IF v_net_pence IS NOT NULL AND v_net_pence > 0 THEN
      v_net_fields := jsonb_build_object(
        'driver_net_fare_pence', v_display_net,
        'driver_earnings_pence', v_display_net,
        'driver_net_preview_pence', v_display_net,
        'final_trip_fare_pence', v_base_pence,
        'trip_fare_pence', v_base_pence,
        'currency', 'gbp',
        'currency_code', 'gbp',
        'commission_percent', v_effective_pct,
        'effective_commission_percent', v_effective_pct,
        'wave_commission_reduction_percent', v_reduction_pct,
        'base_commission_percent', v_base_pct,
        'platform_commission_pence', GREATEST(0, v_base_pence - v_net_pence)
      );
      NEW.offered_driver_net_pence := v_net_pence;
    END IF;
  END IF;

  IF v_airport_pence > 0 THEN
    v_airport_fields := jsonb_build_object(
      'airport_charge_pence', v_airport_pence,
      'route_extra_items', jsonb_build_array(
        jsonb_build_object(
          'type', 'airport',
          'label', 'Airport',
          'amount_pence', v_airport_pence
        )
      )
    );
    IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
       AND jsonb_typeof(v_result->'preset_options') = 'array' THEN
      v_annotated := '[]'::jsonb;
      FOR v_item IN SELECT value FROM jsonb_array_elements(v_result->'preset_options')
      LOOP
        v_gross := COALESCE((v_item->>'grossFarePence')::int, 0);
        IF v_gross > 0 THEN
          v_item_commissionable := GREATEST(0, v_gross - v_airport_pence - v_other_pence);
          v_item_commission := ROUND((v_item_commissionable::numeric * COALESCE(v_effective_pct, 0)) / 100.0);
          v_item_net := GREATEST(0, v_item_commissionable - v_item_commission) + v_airport_pence + v_other_pence;
          v_item := v_item || jsonb_build_object(
            'driverNetPence', v_item_net,
            'driver_net_pence', v_item_net
          );
        END IF;
        v_annotated := v_annotated || jsonb_build_array(v_item);
      END LOOP;
      v_result := jsonb_set(v_result, '{preset_options}', v_annotated);
    END IF;
  END IF;

  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
     AND jsonb_typeof(v_result->'preset_options') = 'array'
     AND jsonb_array_length(v_result->'preset_options') >= 3 THEN
    NEW.offer_snapshot := COALESCE(NEW.offer_snapshot,'{}'::jsonb)
      || jsonb_build_object(
        'baseFarePence', v_base_pence,
        'preset_options', v_result->'preset_options',
        'presets_enabled', true
      )
      || v_net_fields
      || v_airport_fields;
    IF NEW.offer_options IS NULL
       OR jsonb_typeof(NEW.offer_options) <> 'array'
       OR COALESCE(jsonb_array_length(NEW.offer_options), 0) < 3 THEN
      NEW.offer_options := v_result->'offer_options';
    END IF;
    RETURN NEW;
  END IF;

  IF v_base_pence IS NOT NULL AND v_base_pence > 0 THEN
    NEW.offer_options := NULL;
    NEW.offer_snapshot := (COALESCE(NEW.offer_snapshot,'{}'::jsonb) - 'preset_options' - 'presetFareOffers')
      || jsonb_build_object(
        'baseFarePence', v_base_pence,
        'preset_options', '[]'::jsonb,
        'presets_enabled', false,
        'preset_disabled_reason', COALESCE(v_result->>'reason', 'unavailable')
      )
      || v_net_fields
      || v_airport_fields;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ride_offer_build_send_notification_body(p_offer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ro public.ride_offers%ROWTYPE;
  v_driver RECORD;
  v_trip RECORD;
  v_pickup_summary TEXT;
  v_ccy TEXT;
  v_symbol TEXT;
  v_net_pence INT;
  v_net_disp TEXT;
  v_notify_title TEXT := 'New ride offer available near you!';
  v_notify_body TEXT := 'Tap to view details';
  v_trip_reference TEXT;
  v_semantic_type TEXT;
  v_preset_count INT := 0;
  v_preset_nets TEXT := '';
  v_android_channel TEXT := 'onecab_new_ride_offers_v1';
  v_ios_sound TEXT := 'onecab_new_ride_offer.wav';
  v_sent_at TEXT;
  v_expires_at TEXT;
BEGIN
  SELECT * INTO ro FROM public.ride_offers WHERE id = p_offer_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF ro.status <> 'pending' THEN RETURN NULL; END IF;

  SELECT id, user_id INTO v_driver FROM public.drivers WHERE id = ro.driver_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT
    id,
    pickup_address,
    dropoff_address,
    currency_code,
    trip_number,
    service_area_id,
    driver_net_pence
  INTO v_trip
  FROM public.trips WHERE id = ro.trip_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Data-only pickup summary (not OS alert body).
  v_pickup_summary := CASE
    WHEN v_trip.pickup_address IS NULL OR btrim(v_trip.pickup_address::text) = '' THEN 'Tap to view details'
    ELSE left(btrim(v_trip.pickup_address::text), 160)
  END;

  v_ccy := COALESCE(NULLIF(upper(trim(v_trip.currency_code::text)), ''), 'GBP');
  v_symbol := CASE v_ccy
    WHEN 'GBP' THEN '£'
    WHEN 'EUR' THEN '€'
    WHEN 'USD' THEN '$'
    ELSE v_ccy || ' '
  END;

  -- Net still computed for data payload / card hydrate — never into OS title/body.
  v_net_pence := COALESCE(
    NULLIF((ro.offer_snapshot ->> 'driver_net_preview_pence')::int, 0),
    NULLIF((ro.offer_snapshot ->> 'driver_earnings_pence')::int, 0),
    NULLIF((ro.offer_snapshot ->> 'driverNetPreviewPence')::int, 0),
    NULLIF((ro.offer_snapshot ->> 'driverEarningsPence')::int, 0),
    NULLIF(v_trip.driver_net_pence, 0),
    CASE
      WHEN ro.driver_id IS NOT NULL AND v_trip.service_area_id IS NOT NULL THEN
        public.compute_driver_net_preview_from_gross(
          COALESCE(
            NULLIF((ro.offer_snapshot ->> 'baseFarePence')::int, 0),
            NULLIF((ro.offer_snapshot ->> 'base_fare_pence')::int, 0)
          ),
          ro.driver_id,
          v_trip.service_area_id,
          COALESCE(
            NULLIF((ro.offer_snapshot ->> 'airport_charge_pence')::int, 0),
            NULLIF((ro.offer_snapshot ->> 'airportChargePence')::int, 0),
            0
          )
        )
      ELSE NULL
    END
  );

  IF v_net_pence IS NOT NULL AND v_net_pence > 0 THEN
    v_net_disp := concat(v_symbol, trim(to_char(round(v_net_pence / 100.0, 2), 'FM999990.00')));
  ELSE
    v_net_disp := '—';
  END IF;

  v_trip_reference :=
    CASE
      WHEN v_trip.trip_number IS NOT NULL AND length(trim(v_trip.trip_number::text)) > 0 THEN trim(v_trip.trip_number::text)
      ELSE substring(v_trip.id::text, 1, 8)
    END;

  v_semantic_type := 'NEW_RIDE_OFFER';

  IF ro.offer_snapshot IS NOT NULL
     AND jsonb_typeof(ro.offer_snapshot -> 'preset_options') = 'array' THEN
    v_preset_count := jsonb_array_length(ro.offer_snapshot -> 'preset_options');
    SELECT string_agg(
      COALESCE(
        NULLIF(trim((elem ->> 'driverNetPence')), ''),
        NULLIF(trim((elem ->> 'driver_net_pence')), '')
      ),
      ','
      ORDER BY ord
    )
    INTO v_preset_nets
    FROM jsonb_array_elements(ro.offer_snapshot -> 'preset_options') WITH ORDINALITY AS t(elem, ord)
    WHERE COALESCE(
      NULLIF(trim((elem ->> 'driverNetPence')), ''),
      NULLIF(trim((elem ->> 'driver_net_pence')), '')
    ) IS NOT NULL;
  END IF;

  v_sent_at := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_expires_at := CASE
    WHEN ro.expires_at IS NULL THEN NULL
    ELSE to_char(timezone('utc', ro.expires_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END;

  RETURN jsonb_build_object(
    'driverId', ro.driver_id::text,
    'type', 'RIDE_OFFER',
    'title', v_notify_title,
    'body', v_notify_body,
    'channel_id', v_android_channel,
    'android_channel_id', v_android_channel,
    'sound', v_ios_sound,
    'data', jsonb_strip_nulls(jsonb_build_object(
      'offer_notification_type', 'new_ride_offer',
      'type', v_semantic_type,
      'notificationType', v_semantic_type,
      'booking_id', ro.trip_id::text,
      'ride_id', ro.trip_id::text,
      'offer_id', ro.id::text,
      'offerId', ro.id::text,
      'trip_id', ro.trip_id::text,
      'tripId', ro.trip_id::text,
      'trip_reference', v_trip_reference,
      'pickup', coalesce(v_trip.pickup_address, ''),
      'dropoff', coalesce(v_trip.dropoff_address, ''),
      'pickup_summary', v_pickup_summary,
      'driver_earnings_pence', CASE WHEN v_net_pence IS NOT NULL AND v_net_pence > 0 THEN v_net_pence::text ELSE NULL END,
      'driver_net_preview_pence', CASE WHEN v_net_pence IS NOT NULL AND v_net_pence > 0 THEN v_net_pence::text ELSE NULL END,
      'event', 'ride_assigned',
      'expires_at', coalesce(ro.expires_at::text, ''),
      'expiresAt', v_expires_at,
      'sentAt', v_sent_at,
      'notificationVersion', '1',
      'negotiation_status', ro.negotiation_status,
      'negotiation_expires_at', coalesce(ro.negotiation_expires_at::text, ro.expires_at::text, ''),
      'customer_counter_fare',
        CASE
          WHEN ro.customer_counter_fare IS NOT NULL AND ro.customer_counter_fare > 0
            THEN ro.customer_counter_fare::text
          ELSE NULL
        END,
      'preset_options_count', CASE WHEN v_preset_count > 0 THEN v_preset_count::text ELSE NULL END,
      'preset_driver_net_pence', NULLIF(v_preset_nets, ''),
      'sound', v_ios_sound,
      'channel_id', v_android_channel,
      'is_stacked', CASE WHEN ro.is_stacked THEN 'true' ELSE 'false' END
    ))
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.offer_resolve_airport_pence(trips);
DROP FUNCTION IF EXISTS public.offer_annotate_preset_nets(jsonb, integer, integer, numeric);
DROP FUNCTION IF EXISTS public.offer_driver_net_split(integer, integer, integer, numeric, numeric);
DROP FUNCTION IF EXISTS public.offer_quote_airport_pence(jsonb);
DROP FUNCTION IF EXISTS public.offer_quote_ride_pence(jsonb);
DROP FUNCTION IF EXISTS public.offer_quote_final_pence(jsonb);
DROP FUNCTION IF EXISTS public.offer_jsonb_major_to_pence(jsonb, text);
DROP FUNCTION IF EXISTS public.offer_jsonb_pence(jsonb, text);
