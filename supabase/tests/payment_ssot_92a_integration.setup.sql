-- #92A/#92B fixture bootstrap for full CI schema OR isolated stub DB.
-- Uses session_replication_role=replica for synthetic rows (no provider/cash triggers).
-- Ids: 00000000-0000-4000-9200-* / client_action_id TEST-92A-*

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_trip uuid := '00000000-0000-4000-9200-000000000001';
  v_trip_fee uuid := '00000000-0000-4000-9200-000000000002';
  v_sess uuid := '00000000-0000-4000-9200-000000000010';
  v_sess_fee uuid := '00000000-0000-4000-9200-000000000011';
  v_trip_c uuid := '00000000-0000-4000-9200-0000000000c1';
  v_sess_c uuid := '00000000-0000-4000-9200-0000000000c2';
  v_sa uuid;
  v_lat float8;
  v_lng float8;
  v_full boolean;
BEGIN
  -- Detect full schema (service_area_id on trips).
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'service_area_id'
  ) INTO v_full;

  DELETE FROM public.payment_financial_events
    WHERE payment_session_id IN (v_sess, v_sess_fee, v_sess_c)
       OR trip_id IN (v_trip, v_trip_fee, v_trip_c);
  DELETE FROM public.payment_financial_operations
    WHERE payment_session_id IN (v_sess, v_sess_fee, v_sess_c)
       OR trip_id IN (v_trip, v_trip_fee, v_trip_c);
  DELETE FROM public.payment_payable_snapshots
    WHERE trip_id IN (v_trip, v_trip_fee, v_trip_c);
  DELETE FROM public.payment_sessions WHERE id IN (v_sess, v_sess_fee, v_sess_c);
  DELETE FROM public.trips WHERE id IN (v_trip, v_trip_fee, v_trip_c);

  IF v_full THEN
    SELECT t.service_area_id, t.pickup_latitude, t.pickup_longitude
    INTO v_sa, v_lat, v_lng
    FROM public.trips t
    WHERE t.service_area_id IS NOT NULL AND t.pickup_latitude IS NOT NULL
      AND t.id::text NOT LIKE '00000000-0000-4000-9200-%'
    ORDER BY t.created_at
    LIMIT 1;

    IF v_sa IS NULL THEN
      v_sa := 'e8425eef-519b-46f8-82cd-677bb2320655';
      v_lat := 52.0347;
      v_lng := -0.7736;
    END IF;

    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SET LOCAL session_replication_role = replica;

    -- One RIDE_BOOKING session per trip (payment_sessions_ride_trip_unique_idx).
    INSERT INTO public.payment_sessions (
      id, user_id, service_area_id, idempotency_key, client_action_id,
      status, purpose, authorised_amount_pence, provider_state
    ) VALUES
      (v_sess, gen_random_uuid(), v_sa, 'test-92a-ps-1', 'TEST-92A-PS-1',
       'authorised_hold', 'RIDE_BOOKING', 1000, 'AUTHORISED'),
      (v_sess_fee, gen_random_uuid(), v_sa, 'test-92a-ps-fee', 'TEST-92A-PS-FEE',
       'authorised_hold', 'RIDE_BOOKING', 500, 'AUTHORISED'),
      (v_sess_c, gen_random_uuid(), v_sa, 'test-92a-ps-c', 'TEST-92A-PS-C',
       'authorised_hold', 'RIDE_BOOKING', 500, 'AUTHORISED');

    INSERT INTO public.trips (
      id, passenger_id, client_action_id, pickup_address, dropoff_address,
      pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude,
      financial_model, status, payment_method, payment_type, service_area_id,
      payment_session_id, locked_base_fare_pence, final_customer_fare_pence,
      estimated_total_pence, authorised_amount_pence
    ) VALUES
      (v_trip, gen_random_uuid(), 'TEST-92A-1', 'TEST 92A pickup', 'TEST 92A drop',
       v_lat, v_lng, v_lat + 0.01, v_lng + 0.01,
       'PLATFORM_COLLECTED', 'in_progress', 'card', 'CARD', v_sa,
       v_sess, 1000, 1000, 1000, 1000),
      (v_trip_fee, gen_random_uuid(), 'TEST-92A-FEE', 'TEST 92A fee pickup', 'TEST 92A fee drop',
       v_lat, v_lng, v_lat + 0.01, v_lng + 0.01,
       'PLATFORM_COLLECTED', 'cancelled', 'card', 'CARD', v_sa,
       v_sess_fee, 500, 500, 500, 500),
      (v_trip_c, gen_random_uuid(), 'TEST-92A-C', 'TEST 92A race pickup', 'TEST 92A race drop',
       v_lat, v_lng, v_lat + 0.01, v_lng + 0.01,
       'PLATFORM_COLLECTED', 'in_progress', 'card', 'CARD', v_sa,
       v_sess_c, 500, 500, 500, 500);

    UPDATE public.payment_sessions SET trip_id = v_trip WHERE id = v_sess;
    UPDATE public.payment_sessions SET trip_id = v_trip_fee WHERE id = v_sess_fee;
    UPDATE public.payment_sessions SET trip_id = v_trip_c WHERE id = v_sess_c;

    SET LOCAL session_replication_role = origin;
  ELSE
    -- Isolated stub schema (homebrew #92A DB).
    INSERT INTO public.trips (id, final_customer_fare_pence, locked_base_fare_pence, financial_model)
    VALUES
      (v_trip, 1000, 1000, 'PLATFORM_COLLECTED'),
      (v_trip_fee, 500, 500, 'PLATFORM_COLLECTED'),
      (v_trip_c, 500, 500, 'PLATFORM_COLLECTED');
    INSERT INTO public.payment_sessions (id, trip_id, purpose, authorised_amount_pence)
    VALUES
      (v_sess, v_trip, 'TRIP_FARE', 1000),
      (v_sess_fee, v_trip_fee, 'TERMINAL_FEE', 500),
      (v_sess_c, v_trip_c, 'TRIP_FARE', 500);
  END IF;

  RAISE NOTICE '92A_FIXTURE_READY full=%', v_full;
END $$;
