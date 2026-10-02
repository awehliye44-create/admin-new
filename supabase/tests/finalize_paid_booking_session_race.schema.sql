-- LOCAL-ONLY fixture for finalize_paid_booking_session_race.sh. Never run against production.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SET search_path = public;

CREATE TABLE payment_sessions (
  id uuid PRIMARY KEY,
  client_action_id text UNIQUE,
  customer_id uuid,
  service_area_id uuid,
  payment_provider text,
  provider_order_id text,
  status text,
  authorised_amount_pence integer,
  estimated_total_pence integer,
  buffer_pence integer,
  fare_snapshot jsonb DEFAULT '{}'::jsonb,
  booking_snapshot jsonb DEFAULT '{}'::jsonb,
  trip_id uuid,
  payment_method text,
  failure_reason text,
  metadata jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz,
  currency text,
  provider_state text
);

CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  passenger_id uuid, passenger_name text, passenger_phone text,
  pickup_address text, pickup_latitude numeric, pickup_longitude numeric,
  dropoff_address text, dropoff_latitude numeric, dropoff_longitude numeric,
  stops jsonb, total_stops int,
  vehicle_type_id uuid, estimated_fare numeric, estimated_total_pence int, final_customer_fare_pence int,
  gross_fare_pence int, offer_discount_pence int, discount_pence int,
  locked_base_fare_pence int, authorised_amount_pence int, preauth_buffer_pence int,
  estimated_distance_km numeric, estimated_duration_minutes int,
  special_instructions text, is_scheduled boolean, scheduled_at timestamptz,
  payment_method text, payment_type text, trip_type text, status text,
  currency_code text, service_area_id uuid, booking_source text,
  payment_session_id uuid, payment_provider text, provider_order_id text, payment_status text, payment_state text,
  client_action_id text,
  driver_id uuid
);

-- Production unique indexes (verbatim from pg_indexes).
CREATE UNIQUE INDEX trips_client_action_id_key ON trips USING btree (client_action_id);
CREATE UNIQUE INDEX trips_provider_order_uidx ON trips USING btree (payment_provider, provider_order_id)
  WHERE ((payment_provider IS NOT NULL) AND (provider_order_id IS NOT NULL));
CREATE UNIQUE INDEX trips_one_live_immediate_per_passenger_uidx ON trips USING btree (passenger_id)
  WHERE ((COALESCE(is_scheduled, false) = false) AND (lower(COALESCE(trip_type, 'instant'::text)) <> 'scheduled'::text)
    AND (lower(btrim(COALESCE(status, ''::text))) <> ALL (ARRAY['scheduled'::text, 'scheduled_committed'::text, 'completed'::text,
      'cancelled'::text, 'canceled'::text, 'customer_cancelled'::text, 'customer_canceled'::text, 'passenger_cancelled'::text,
      'passenger_canceled'::text, 'expired'::text, 'expired_no_driver'::text, 'no_driver'::text, 'no_show'::text, 'no-show'::text,
      'failed'::text, 'declined'::text, 'refunded'::text, 'released'::text])));

-- Dispatch observer: same WHEN clause as tr_trips_dispatch_after_insert.
CREATE TABLE dispatch_log (trip_id uuid, at timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION log_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO dispatch_log(trip_id) VALUES (NEW.id); RETURN NEW; END $$;
CREATE TRIGGER tr_trips_dispatch_after_insert AFTER INSERT ON trips FOR EACH ROW
  WHEN (((new.driver_id IS NULL) AND (new.status = ANY (ARRAY['pending'::text, 'searching'::text]))))
  EXECUTE FUNCTION log_dispatch();

CREATE FUNCTION ensure_trip_stops_for_assignment(p uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;

-- Fare authority stub: fare 500, buffer 250 -> authorised 750 (matches MK-261002-016).
CREATE FUNCTION resolve_booking_customer_payable_pence(b jsonb, f jsonb, e int, a int)
RETURNS TABLE(gross_fare_pence integer, discount_pence integer, customer_payable_pence integer)
LANGUAGE sql AS $$ SELECT COALESCE((b->>'fare_pence')::int, 500), 0, COALESCE((b->>'fare_pence')::int, 500) $$;

-- Verbatim production passenger_has_live_immediate_trip.
CREATE OR REPLACE FUNCTION public.passenger_has_live_immediate_trip(p_passenger_id uuid, p_exclude_trip_id uuid DEFAULT NULL::uuid)
 RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_trip_id uuid;
BEGIN
  IF p_passenger_id IS NULL THEN RETURN NULL; END IF;
  SELECT t.id INTO v_trip_id FROM public.trips t
  WHERE t.passenger_id = p_passenger_id
    AND (p_exclude_trip_id IS NULL OR t.id <> p_exclude_trip_id)
    AND COALESCE(t.is_scheduled, false) = false
    AND lower(COALESCE(t.trip_type, 'instant')) NOT IN ('scheduled')
    AND lower(btrim(COALESCE(t.status, ''))) NOT IN ('scheduled','scheduled_committed','completed','cancelled','canceled',
      'customer_cancelled','customer_canceled','passenger_cancelled','passenger_canceled','expired','expired_no_driver',
      'no_driver','no_show','no-show','failed','declined','refunded','released')
  ORDER BY t.created_at DESC NULLS LAST LIMIT 1;
  RETURN v_trip_id;
END;
$function$;

-- Fixture: one AUTHORISED saved-card session per scenario.
CREATE FUNCTION mk_session(p_id uuid, p_cai text, p_order text, p_customer uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO payment_sessions (id, client_action_id, customer_id, service_area_id, payment_provider, provider_order_id,
    status, authorised_amount_pence, estimated_total_pence, buffer_pence, booking_snapshot, payment_method, currency,
    provider_state, metadata, updated_at)
  VALUES (p_id, p_cai, p_customer, '00000000-0000-0000-0000-00000000a5a5', 'revolut', p_order,
    'authorised', 750, 500, 250,
    jsonb_build_object('passenger_id', p_customer, 'fare_pence', 500, 'buffer_pence', 250,
      'pickup', jsonb_build_object('address','A','lat',52.0,'lng',-0.7),
      'dropoff', jsonb_build_object('address','B','lat',52.1,'lng',-0.8), 'payment_method','CARD'),
    'card', 'GBP', 'AUTHORISED', '{}'::jsonb, now());
$$;

-- CTAP-shaped direct insert (buildMinimalTripInsertRow identifiers).
CREATE FUNCTION ctap_insert(p_session uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE s payment_sessions; v uuid;
BEGIN
  SELECT * INTO s FROM payment_sessions WHERE id = p_session;
  INSERT INTO trips (passenger_id, status, trip_type, is_scheduled, client_action_id, payment_session_id,
    payment_provider, provider_order_id, authorised_amount_pence, preauth_buffer_pence, final_customer_fare_pence,
    payment_status, payment_state)
  VALUES (s.customer_id, 'searching', 'instant', false, s.client_action_id, s.id, 'revolut', s.provider_order_id,
    750, 250, 500, 'preauth_authorized', 'booking_created')
  RETURNING id INTO v;
  RETURN v;
END $$;
