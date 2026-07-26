-- Phase 3: Align ride-offer remote push copy with Driver OS / in-app format.
-- Driver-net only; include driver-to-pickup distance/ETA; never customer gross.

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
  v_miles NUMERIC;
  v_miles_disp TEXT;
  v_eta_mins INT;
  v_eta_disp TEXT;
  v_headline TEXT;
  v_detail TEXT;
  v_notify_body TEXT;
  v_trip_reference TEXT;
  v_semantic_type TEXT;
  v_preset_count INT := 0;
  v_preset_nets TEXT := '';
  v_flags TEXT := '';
  v_offer_kind TEXT;
  v_is_card BOOLEAN := false;
  v_multi_stop BOOLEAN := false;
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
    driver_net_pence,
    total_stops,
    payment_method,
    payment_type,
    is_scheduled,
    scheduled_at,
    vehicle_type
  INTO v_trip
  FROM public.trips WHERE id = ro.trip_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

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

  -- Authoritative driver-net (never customer gross as primary).
  v_net_pence := COALESCE(
    NULLIF((ro.offer_snapshot ->> 'driver_net_fare_pence')::int, 0),
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

  -- Driver-to-pickup distance / ETA from ride_offers.
  IF ro.distance_meters IS NOT NULL AND ro.distance_meters >= 0 THEN
    v_miles := ro.distance_meters::numeric / 1609.344;
    IF v_miles >= 10 THEN
      v_miles_disp := trim(to_char(round(v_miles, 0), 'FM999990')) || ' mi';
    ELSE
      v_miles_disp := trim(to_char(round(v_miles, 1), 'FM999990.0')) || ' mi';
    END IF;
  END IF;

  IF ro.eta_seconds IS NOT NULL AND ro.eta_seconds >= 0 THEN
    v_eta_mins := GREATEST(1, round(ro.eta_seconds / 60.0)::int);
    v_eta_disp := v_eta_mins::text || ' min';
  END IF;

  v_multi_stop := COALESCE(v_trip.total_stops, 0) > 2;
  v_is_card := lower(coalesce(v_trip.payment_method, v_trip.payment_type, '')) LIKE '%card%'
    OR lower(coalesce(v_trip.payment_method, '')) = 'stripe';

  v_offer_kind := CASE WHEN ro.is_stacked THEN 'New ride after current trip' ELSE 'New ride offer' END;

  v_flags := '';
  IF COALESCE(v_trip.is_scheduled, false) OR v_trip.scheduled_at IS NOT NULL THEN
    v_flags := v_flags || ' · Scheduled';
  END IF;
  IF v_multi_stop THEN
    v_flags := v_flags || ' · + multiple stops';
  END IF;
  IF v_is_card THEN
    v_flags := v_flags || ' · Card';
  END IF;
  IF v_trip.vehicle_type IS NOT NULL AND length(trim(v_trip.vehicle_type::text)) > 0 THEN
    v_flags := v_flags || ' · ' || left(trim(v_trip.vehicle_type::text), 40);
  END IF;

  IF v_net_pence IS NOT NULL AND v_net_pence > 0 THEN
    v_headline := concat(v_offer_kind, ' · ', v_net_disp, v_flags);
  ELSE
    v_headline := concat(v_offer_kind, v_flags);
  END IF;

  IF v_miles_disp IS NOT NULL AND v_eta_disp IS NOT NULL THEN
    v_detail := concat(v_miles_disp, ' · ', v_eta_disp, ' to pickup', E'\n', v_pickup_summary);
  ELSIF v_miles_disp IS NOT NULL THEN
    v_detail := concat(v_miles_disp, ' to pickup', E'\n', v_pickup_summary);
  ELSIF v_eta_disp IS NOT NULL THEN
    v_detail := concat(v_eta_disp, ' to pickup', E'\n', v_pickup_summary);
  ELSE
    v_detail := v_pickup_summary;
  END IF;

  v_notify_body := concat(v_headline, E'\n', v_detail);

  v_trip_reference :=
    CASE
      WHEN v_trip.trip_number IS NOT NULL AND length(trim(v_trip.trip_number::text)) > 0 THEN trim(v_trip.trip_number::text)
      ELSE substring(v_trip.id::text, 1, 8)
    END;

  IF ro.is_stacked THEN
    v_semantic_type := 'stacked_ride_offer';
  ELSE
    v_semantic_type := 'NEW_RIDE_OFFER';
  END IF;

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

  RETURN jsonb_build_object(
    'driverId', ro.driver_id::text,
    'type', 'RIDE_OFFER',
    'title', 'ONECAB DRIVER',
    'body', v_notify_body,
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
      'driver_net_fare_pence', CASE WHEN v_net_pence IS NOT NULL AND v_net_pence > 0 THEN v_net_pence::text ELSE NULL END,
      'distance_meters', CASE WHEN ro.distance_meters IS NOT NULL THEN ro.distance_meters::text ELSE NULL END,
      'eta_seconds', CASE WHEN ro.eta_seconds IS NOT NULL THEN ro.eta_seconds::text ELSE NULL END,
      'distance_to_pickup_text', v_miles_disp,
      'eta_to_pickup_text', v_eta_disp,
      'headline', v_headline,
      'event', 'ride_assigned',
      'expires_at', coalesce(ro.expires_at::text, ''),
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
      'sound', 'default',
      'is_stacked', CASE WHEN ro.is_stacked THEN 'true' ELSE 'false' END,
      'is_scheduled', CASE WHEN COALESCE(v_trip.is_scheduled, false) OR v_trip.scheduled_at IS NOT NULL THEN 'true' ELSE 'false' END,
      'has_multiple_stops', CASE WHEN v_multi_stop THEN 'true' ELSE 'false' END,
      'payment_method', CASE WHEN v_is_card THEN 'card' ELSE NULL END
    ))
  );
END;
$function$;

COMMENT ON FUNCTION public.ride_offer_build_send_notification_body(uuid) IS
  'Builds APNs/FCM ride-offer payload: ONECAB DRIVER title + New ride offer · driver-net + distance/ETA/pickup. Driver-net SSOT only.';
