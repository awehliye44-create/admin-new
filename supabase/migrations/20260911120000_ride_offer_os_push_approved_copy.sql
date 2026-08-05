-- Driver NEW_RIDE_OFFER killed-state OS heads-up copy.
-- Title/body must not include fare, pickup, destination, or passenger details.
-- Data payload identifiers (offerId, tripId, expires_at, channel, sound) unchanged.

CREATE OR REPLACE FUNCTION public.ride_offer_build_send_notification_body(p_offer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
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
$fn$;

COMMENT ON FUNCTION public.ride_offer_build_send_notification_body(uuid) IS
  'Driver ride-offer push — approved OS title/body (no fare). Data retains net + IDs + SSOT channel/sound.';
