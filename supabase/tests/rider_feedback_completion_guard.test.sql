-- Executable assertions for validate_rider_feedback_completion.
-- Prerequisites: disposable DB with harness schema + migration
--   20260803233000_rider_feedback_require_completed_trip.sql applied.
-- Run: psql ... -v ON_ERROR_STOP=1 -f this file
-- Expect: each case prints PASS / final SUMMARY all passed.

\set ON_ERROR_STOP on
\pset pager off

CREATE TEMP TABLE _rf_results (
  case_id text PRIMARY KEY,
  ok boolean NOT NULL,
  detail text NOT NULL
);

CREATE OR REPLACE FUNCTION pg_temp.expect_reject(p_case text, p_sql text, p_needle text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO _rf_results(case_id, ok, detail)
    VALUES (p_case, false, 'expected reject but INSERT succeeded');
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%' || p_needle || '%' THEN
      INSERT INTO _rf_results(case_id, ok, detail)
      VALUES (p_case, true, SQLERRM);
    ELSE
      INSERT INTO _rf_results(case_id, ok, detail)
      VALUES (p_case, false, 'unexpected error: ' || SQLERRM);
    END IF;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_accept(p_case text, p_sql text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    INSERT INTO _rf_results(case_id, ok, detail)
    VALUES (p_case, true, 'insert accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _rf_results(case_id, ok, detail)
    VALUES (p_case, false, 'expected accept but got: ' || SQLERRM);
  END;
END;
$$;

-- Bind fixture ids from harness seed
DO $$
DECLARE
  v_customer uuid := '11111111-1111-1111-1111-111111111111';
  v_other    uuid := '22222222-2222-2222-2222-222222222222';
  v_driver   uuid := '33333333-3333-3333-3333-333333333333';
  v_uid      uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  trip_id uuid;
  statuses text[] := ARRAY[
    'searching',
    'offered',
    'driver_assigned',
    'en_route_to_pickup',
    'arrived_at_pickup',
    'waiting',
    'in_progress',
    'searching_new_driver'
  ];
  st text;
  sql text;
BEGIN
  -- Authenticate as owning customer for reject/accept cases
  PERFORM harness.set_auth(v_uid, 'authenticated');

  FOREACH st IN ARRAY statuses LOOP
    SELECT id INTO trip_id FROM public.trips WHERE status = st AND passenger_id = v_customer LIMIT 1;
    sql := format(
      $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
         VALUES (%L::uuid, %L::uuid, %L::uuid, 5, 'trip', 'pending')$q$,
      trip_id, v_customer, v_driver
    );
    PERFORM pg_temp.expect_reject(st || ' trip rating rejected', sql, 'RATING_REJECTED');
  END LOOP;

  -- cancelled
  SELECT id INTO trip_id FROM public.trips WHERE status = 'cancelled' AND final_fare_pence IS NULL AND passenger_id = v_customer LIMIT 1;
  sql := format(
    $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 5, 'trip', 'pending')$q$,
    trip_id, v_customer, v_driver
  );
  PERFORM pg_temp.expect_reject('cancelled trip rating rejected', sql, 'RATING_REJECTED');

  -- cancelled with final_fare_pence
  SELECT id INTO trip_id FROM public.trips WHERE status = 'cancelled' AND final_fare_pence IS NOT NULL AND passenger_id = v_customer LIMIT 1;
  sql := format(
    $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 5, 'trip', 'pending')$q$,
    trip_id, v_customer, v_driver
  );
  PERFORM pg_temp.expect_reject('cancelled trip with final_fare_pence rating rejected', sql, 'RATING_REJECTED');

  -- completed without completed_at
  SELECT id INTO trip_id FROM public.trips WHERE status = 'completed' AND completed_at IS NULL AND passenger_id = v_customer LIMIT 1;
  sql := format(
    $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 5, 'trip', 'pending')$q$,
    trip_id, v_customer, v_driver
  );
  PERFORM pg_temp.expect_reject('completed without completed_at rejected', sql, 'RATING_REJECTED');

  -- completed with completed_at + correct customer
  SELECT id INTO trip_id FROM public.trips WHERE status = 'completed' AND completed_at IS NOT NULL AND passenger_id = v_customer LIMIT 1;
  sql := format(
    $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 5, 'trip', 'pending')$q$,
    trip_id, v_customer, v_driver
  );
  PERFORM pg_temp.expect_accept('completed with completed_at and correct customer accepted', sql);

  -- wrong customer (authenticated as other customer)
  PERFORM harness.set_auth('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'authenticated');
  sql := format(
    $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 4, 'trip', 'pending')$q$,
    trip_id, v_other, v_driver
  );
  PERFORM pg_temp.expect_reject('wrong customer rejected', sql, 'RATING_REJECTED');

  -- duplicate rating (same customer again)
  PERFORM harness.set_auth(v_uid, 'authenticated');
  sql := format(
    $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 3, 'trip', 'pending')$q$,
    trip_id, v_customer, v_driver
  );
  PERFORM pg_temp.expect_reject('duplicate rating rejected', sql, 'RATING_REJECTED');

  -- service_role: may insert even if customer_id does not match auth customer path
  -- (auth.role = service_role skips ownership checks)
  PERFORM harness.set_auth(NULL, 'service_role');
  SELECT id INTO trip_id FROM public.trips
  WHERE status = 'completed' AND completed_at IS NOT NULL AND passenger_id = v_other
  LIMIT 1;
  sql := format(
    $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 5, 'trip', 'pending')$q$,
    trip_id, v_other, v_driver
  );
  PERFORM pg_temp.expect_accept('service-role behaviour explicitly verified', sql);

  -- service_role still requires completed + completed_at
  SELECT id INTO trip_id FROM public.trips WHERE status = 'in_progress' LIMIT 1;
  sql := format(
    $q$INSERT INTO public.rider_feedback (trip_id, customer_id, driver_id, rating, feedback_type, status)
       VALUES (%L::uuid, %L::uuid, %L::uuid, 5, 'trip', 'pending')$q$,
    trip_id, v_customer, v_driver
  );
  PERFORM pg_temp.expect_reject('service-role non-completed still rejected', sql, 'RATING_REJECTED');
END;
$$;

\echo '=== rider_feedback_completion_guard results ==='
SELECT case_id, ok, detail FROM _rf_results ORDER BY case_id;

\echo '=== SUMMARY ==='
SELECT
  count(*) FILTER (WHERE ok) AS passed,
  count(*) FILTER (WHERE NOT ok) AS failed,
  count(*) AS total
FROM _rf_results;

DO $$
DECLARE
  v_failed int;
BEGIN
  SELECT count(*) INTO v_failed FROM _rf_results WHERE NOT ok;
  IF v_failed > 0 THEN
    RAISE EXCEPTION 'rider_feedback_completion_guard FAILED: % case(s)', v_failed;
  END IF;
  RAISE NOTICE 'rider_feedback_completion_guard ALL PASSED';
END;
$$;
