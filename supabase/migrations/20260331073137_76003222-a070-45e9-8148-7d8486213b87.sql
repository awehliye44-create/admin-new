-- Fix commission_gaps detector to use correct column name
CREATE OR REPLACE FUNCTION ops_detect_commission_gaps() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT t.id as trip_id, tf.final_trip_total_pence as fare FROM trips t
    JOIN trip_finance tf ON tf.trip_id = t.id
    WHERE t.status = 'completed' AND t.updated_at >= now() - interval '24 hours'
      AND (tf.platform_commission_pence IS NULL OR tf.platform_commission_pence = 0)
      AND tf.final_trip_total_pence > 0
    LIMIT 50
  LOOP
    PERFORM ops_upsert_alert(
      ('commission_gap:' || rec.trip_id)::text,
      'commission'::text, 'critical'::text, 'detection'::text, 'backend'::text,
      'Commission Zero in trip_finance'::text,
      ('Trip ' || rec.trip_id || ' has trip_finance but commission is 0. Fare: ' || rec.fare || 'p')::text,
      p_metadata := jsonb_build_object('trip_id', rec.trip_id, 'fare_pence', rec.fare));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('commission_gaps', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('commission_gaps', 0, 'note', 'table not found');
END;
$$;

-- Also fix duplicate_payouts to handle missing table gracefully
CREATE OR REPLACE FUNCTION ops_detect_duplicate_payouts() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT driver_id, period_start, count(*) as batch_count
    FROM payout_items
    WHERE created_at >= now() - interval '7 days'
    GROUP BY driver_id, period_start
    HAVING count(*) > 1
    LIMIT 20
  LOOP
    PERFORM ops_upsert_alert(
      ('dup_payout:' || rec.driver_id || ':' || rec.period_start)::text,
      'duplication'::text, 'critical'::text, 'detection'::text, 'backend'::text,
      'Duplicate Payout Detected'::text,
      ('Driver ' || rec.driver_id || ' has ' || rec.batch_count || ' payouts for period ' || rec.period_start)::text,
      p_metadata := jsonb_build_object('driver_id', rec.driver_id, 'period_start', rec.period_start, 'batch_count', rec.batch_count));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('duplicate_payouts', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('duplicate_payouts', 0, 'note', 'table not found');
          WHEN undefined_column THEN RETURN jsonb_build_object('duplicate_payouts', 0, 'note', 'column mismatch');
END;
$$;

-- Fix duplicate_payments similarly  
CREATE OR REPLACE FUNCTION ops_detect_duplicate_payments() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT trip_id, count(*) as pay_count, sum(final_trip_total_pence) as total_pence
    FROM trip_finance
    WHERE created_at >= now() - interval '24 hours'
    GROUP BY trip_id
    HAVING count(*) > 1
    LIMIT 20
  LOOP
    PERFORM ops_upsert_alert(
      ('dup_payment:' || rec.trip_id)::text,
      'duplication'::text, 'critical'::text, 'detection'::text, 'backend'::text,
      'Duplicate Payment Detected'::text,
      ('Trip ' || rec.trip_id || ' has ' || rec.pay_count || ' finance records totaling ' || rec.total_pence || 'p')::text,
      p_metadata := jsonb_build_object('trip_id', rec.trip_id, 'payment_count', rec.pay_count, 'total_pence', rec.total_pence));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('duplicate_payments', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('duplicate_payments', 0, 'note', 'table not found');
END;
$$;