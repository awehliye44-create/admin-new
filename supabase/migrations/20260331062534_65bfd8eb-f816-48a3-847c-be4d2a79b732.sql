
-- 1. Payment gaps
CREATE OR REPLACE FUNCTION public.ops_detect_payment_gaps()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT t.id as trip_id FROM trips t
    LEFT JOIN trip_finance tf ON tf.trip_id = t.id
    WHERE t.status = 'completed' AND t.updated_at >= now() - interval '24 hours'
      AND (tf.id IS NULL OR tf.payment_status = 'failed' OR tf.stripe_payment_intent_id IS NULL)
    LIMIT 50
  LOOP
    PERFORM ops_upsert_alert('payment_gap:' || rec.trip_id, 'payment', 'critical', 'detection', 'backend',
      'Payment gap for completed trip', 'Trip ' || rec.trip_id || ' completed but no successful payment.',
      jsonb_build_object('trip_id', rec.trip_id));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('payment_gaps', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('payment_gaps', 0, 'note', 'table not found');
END; $$;

-- 2. Commission gaps
CREATE OR REPLACE FUNCTION public.ops_detect_commission_gaps()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT t.id as trip_id, tf.gross_fare_pence FROM trips t
    JOIN trip_finance tf ON tf.trip_id = t.id
    WHERE t.status = 'completed' AND t.updated_at >= now() - interval '24 hours'
      AND tf.commission_pence IS NULL AND tf.gross_fare_pence > 0
    LIMIT 50
  LOOP
    PERFORM ops_upsert_alert('commission_gap:' || rec.trip_id, 'commission', 'critical', 'detection', 'backend',
      'Missing commission', 'Trip ' || rec.trip_id || ' has fare but no commission.',
      jsonb_build_object('trip_id', rec.trip_id, 'gross_fare_pence', rec.gross_fare_pence));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('commission_gaps', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('commission_gaps', 0, 'note', 'table not found');
END; $$;

-- 3. Earning gaps
CREATE OR REPLACE FUNCTION public.ops_detect_earning_gaps()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT t.id as trip_id, t.driver_id FROM trips t
    JOIN trip_finance tf ON tf.trip_id = t.id
    LEFT JOIN driver_wallet_ledger dwl ON dwl.trip_id = t.id AND dwl.entry_type = 'trip_earning'
    WHERE t.status = 'completed' AND t.updated_at >= now() - interval '24 hours'
      AND tf.gross_fare_pence > 0 AND dwl.id IS NULL
    LIMIT 50
  LOOP
    PERFORM ops_upsert_alert('earning_gap:' || rec.trip_id, 'earning', 'critical', 'detection', 'backend',
      'Missing driver earning', 'Completed trip has no earning entry.',
      jsonb_build_object('trip_id', rec.trip_id, 'driver_id', rec.driver_id));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('earning_gaps', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('earning_gaps', 0, 'note', 'table not found');
END; $$;

-- 4. Payout failures
CREATE OR REPLACE FUNCTION public.ops_detect_payout_failures()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT id, total_amount_pence, driver_count FROM payout_batches
    WHERE status = 'failed' AND updated_at >= now() - interval '24 hours' LIMIT 20
  LOOP
    PERFORM ops_upsert_alert('payout_fail:' || rec.id, 'payout', 'critical', 'detection', 'backend',
      'Payout batch failed', 'Batch failed for ' || coalesce(rec.driver_count, 0) || ' drivers.',
      jsonb_build_object('batch_id', rec.id));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('payout_failures', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('payout_failures', 0, 'note', 'table not found');
END; $$;

-- 5. Stuck dispatch
CREATE OR REPLACE FUNCTION public.ops_detect_stuck_dispatch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT id, status, extract(epoch FROM (now() - created_at))/60 as mins
    FROM trips WHERE status IN ('searching','dispatching') AND created_at <= now() - interval '15 minutes' LIMIT 20
  LOOP
    PERFORM ops_upsert_alert('stuck_dispatch:' || rec.id, 'dispatch', 'warning', 'detection', 'backend',
      'Trip stuck in dispatch', 'Trip in ' || rec.status || ' for ' || round(rec.mins::numeric) || ' min.',
      jsonb_build_object('trip_id', rec.id, 'minutes', round(rec.mins::numeric)));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('stuck_dispatch', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('stuck_dispatch', 0, 'note', 'table not found');
END; $$;

-- 6. Guest booking failures
CREATE OR REPLACE FUNCTION public.ops_detect_guest_booking_failures()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT source, error_code, count(*) as cnt FROM ops_logs
    WHERE app = 'guest' AND level IN ('error','fatal') AND created_at >= now() - interval '1 hour'
    GROUP BY source, error_code HAVING count(*) >= 2
  LOOP
    PERFORM ops_upsert_alert('guest_fail:' || coalesce(rec.source,'x') || ':' || coalesce(rec.error_code,'x'),
      'guest_booking', CASE WHEN rec.cnt >= 5 THEN 'critical' ELSE 'warning' END, 'detection', 'guest',
      'Guest errors: ' || coalesce(rec.source,'unknown'), rec.cnt || ' errors in last hour.',
      jsonb_build_object('error_count', rec.cnt, 'source', rec.source));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('guest_booking_failures', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('guest_booking_failures', 0, 'note', 'table not found');
END; $$;

-- 7. Log anomalies
CREATE OR REPLACE FUNCTION public.ops_detect_log_anomalies()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN SELECT source, count(*) as cnt FROM ops_logs WHERE http_status >= 500 AND created_at >= now() - interval '1 hour' GROUP BY source HAVING count(*) >= 3
  LOOP
    PERFORM ops_upsert_alert('5xx_spike:' || coalesce(rec.source,'x'), 'backend', 'critical', 'detection', 'backend',
      '5xx spike: ' || coalesce(rec.source,'unknown'), rec.cnt || ' server errors in last hour.',
      jsonb_build_object('error_count', rec.cnt, 'source', rec.source));
    v_count := v_count + 1;
  END LOOP;
  FOR rec IN SELECT source, message FROM ops_logs WHERE level = 'fatal' AND created_at >= now() - interval '1 hour' LIMIT 10
  LOOP
    PERFORM ops_upsert_alert('fatal_log:' || coalesce(rec.source,'x'), 'backend', 'fatal', 'detection', 'backend',
      'Fatal: ' || coalesce(rec.source,'unknown'), coalesce(rec.message,'Fatal error'),
      jsonb_build_object('source', rec.source));
    v_count := v_count + 1;
  END LOOP;
  FOR rec IN SELECT source, count(*) as cnt, round(avg(duration_ms)) as avg_ms FROM ops_logs WHERE duration_ms > 5000 AND created_at >= now() - interval '1 hour' GROUP BY source HAVING count(*) >= 3
  LOOP
    PERFORM ops_upsert_alert('latency_spike:' || coalesce(rec.source,'x'), 'backend', 'warning', 'detection', 'backend',
      'Latency spike: ' || coalesce(rec.source,'unknown'), rec.cnt || ' slow requests (avg ' || rec.avg_ms || 'ms).',
      jsonb_build_object('count', rec.cnt, 'avg_ms', rec.avg_ms));
    v_count := v_count + 1;
  END LOOP;
  FOR rec IN SELECT source, count(*) as cnt FROM ops_logs WHERE http_status >= 540 AND created_at >= now() - interval '1 hour' GROUP BY source HAVING count(*) >= 2
  LOOP
    PERFORM ops_upsert_alert('edge_fn_crash:' || coalesce(rec.source,'x'), 'backend', 'critical', 'detection', 'backend',
      'Edge fn crash: ' || coalesce(rec.source,'unknown'), rec.cnt || ' crashes in last hour.',
      jsonb_build_object('crash_count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('log_anomalies', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('log_anomalies', 0, 'note', 'table not found');
END; $$;

-- 8. Duplicate payments
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_payments()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN SELECT trip_id, count(*) as cnt FROM trip_finance WHERE payment_status = 'succeeded' AND created_at >= now() - interval '24 hours' GROUP BY trip_id HAVING count(*) > 1 LIMIT 20
  LOOP
    PERFORM ops_upsert_alert('dup_payment:' || rec.trip_id, 'duplication', 'critical', 'detection', 'backend',
      'Duplicate payment', 'Trip has ' || rec.cnt || ' payments.',
      jsonb_build_object('trip_id', rec.trip_id, 'count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('duplicate_payments', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('duplicate_payments', 0, 'note', 'table not found');
END; $$;

-- 9. Duplicate bookings
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_bookings()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN SELECT customer_id, pickup_address, count(*) as cnt FROM trips WHERE created_at >= now() - interval '1 hour' AND status != 'cancelled' GROUP BY customer_id, pickup_address, dropoff_address HAVING count(*) > 1 LIMIT 20
  LOOP
    PERFORM ops_upsert_alert('dup_booking:' || rec.customer_id, 'duplication', 'warning', 'detection', 'backend',
      'Duplicate booking', rec.cnt || ' identical bookings from same customer.',
      jsonb_build_object('customer_id', rec.customer_id));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('duplicate_bookings', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('duplicate_bookings', 0, 'note', 'table not found');
END; $$;

-- 10. Duplicate payouts
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_payouts()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN SELECT driver_id, count(*) as cnt FROM driver_wallet_ledger WHERE entry_type = 'payout' AND status = 'completed' AND created_at >= now() - interval '24 hours' GROUP BY driver_id HAVING count(*) > 1 LIMIT 20
  LOOP
    PERFORM ops_upsert_alert('dup_payout:' || rec.driver_id, 'duplication', 'critical', 'detection', 'backend',
      'Duplicate payout', 'Driver received ' || rec.cnt || ' payouts.',
      jsonb_build_object('driver_id', rec.driver_id));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('duplicate_payouts', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('duplicate_payouts', 0, 'note', 'table not found');
END; $$;

-- 11. Duplicate dispatch
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_dispatch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN SELECT trip_id, driver_id, count(*) as cnt FROM dispatch_candidates_log WHERE created_at >= now() - interval '1 hour' GROUP BY trip_id, driver_id HAVING count(*) > 2 LIMIT 20
  LOOP
    PERFORM ops_upsert_alert('dup_dispatch:' || rec.trip_id || ':' || rec.driver_id, 'duplication', 'warning', 'detection', 'backend',
      'Duplicate dispatch', 'Trip sent ' || rec.cnt || ' offers to same driver.',
      jsonb_build_object('trip_id', rec.trip_id, 'driver_id', rec.driver_id));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('duplicate_dispatch', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('duplicate_dispatch', 0, 'note', 'table not found');
END; $$;
