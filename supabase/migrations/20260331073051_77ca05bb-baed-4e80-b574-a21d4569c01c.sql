-- Phase A: Clean up demo alerts from money integrity categories
-- and standardize detection to avoid duplicates

-- 1. Remove all demo-seeded alerts (fingerprint starts with 'demo:')
DELETE FROM ops_alerts WHERE fingerprint LIKE 'demo:%';

-- 2. Fix ops_detect_commission_gaps to not conflict with ops_detect_missing_commissions
-- The commission_gaps detector looks at trip_finance where commission IS NULL
-- But ops_detect_missing_commissions looks at trips with NO trip_finance row at all
-- They serve different purposes but should use consistent fingerprints

-- Drop the older/redundant commission_gaps detector that uses a different alert path
-- and consolidate into the ops_detect_missing_commissions function which is more thorough
CREATE OR REPLACE FUNCTION ops_detect_commission_gaps() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  -- This now checks for trips WITH trip_finance but where commission is zero/null
  -- (complementary to ops_detect_missing_commissions which checks for NO trip_finance at all)
  FOR rec IN
    SELECT t.id as trip_id, tf.gross_fare_pence FROM trips t
    JOIN trip_finance tf ON tf.trip_id = t.id
    WHERE t.status = 'completed' AND t.updated_at >= now() - interval '24 hours'
      AND (tf.platform_commission_pence IS NULL OR tf.platform_commission_pence = 0)
      AND tf.gross_fare_pence > 0
    LIMIT 50
  LOOP
    PERFORM ops_upsert_alert(
      ('commission_gap:' || rec.trip_id)::text,
      'commission'::text, 'critical'::text, 'detection'::text, 'backend'::text,
      'Commission Zero in trip_finance'::text,
      ('Trip ' || rec.trip_id || ' has trip_finance but commission is 0. Fare: ' || rec.gross_fare_pence || 'p')::text,
      p_metadata := jsonb_build_object('trip_id', rec.trip_id, 'gross_fare_pence', rec.gross_fare_pence));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('commission_gaps', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('commission_gaps', 0, 'note', 'table not found');
END;
$$;

-- 3. Fix duplication detectors — they were only seeded by demo, ensure real detection works
-- Create proper duplicate payment detector
CREATE OR REPLACE FUNCTION ops_detect_duplicate_payments() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT trip_id, count(*) as pay_count, sum(amount_pence) as total_pence
    FROM trip_finance
    WHERE entry_type IN ('CARD_PAYMENT', 'APPLE_PAY_PAYMENT', 'GOOGLE_PAY_PAYMENT')
      AND created_at >= now() - interval '24 hours'
    GROUP BY trip_id
    HAVING count(*) > 1
    LIMIT 20
  LOOP
    PERFORM ops_upsert_alert(
      ('dup_payment:' || rec.trip_id)::text,
      'duplication'::text, 'critical'::text, 'detection'::text, 'backend'::text,
      'Duplicate Payment Detected'::text,
      ('Trip ' || rec.trip_id || ' has ' || rec.pay_count || ' payments totaling ' || rec.total_pence || 'p')::text,
      p_metadata := jsonb_build_object('trip_id', rec.trip_id, 'payment_count', rec.pay_count, 'total_pence', rec.total_pence));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('duplicate_payments', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('duplicate_payments', 0, 'note', 'table not found');
END;
$$;

-- Create proper duplicate payout detector
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
END;
$$;

-- 4. Update ops_run_all_detections to include dedup detectors
CREATE OR REPLACE FUNCTION ops_run_all_detections() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE results jsonb := '{}'::jsonb; part jsonb;
BEGIN
  -- Money integrity
  SELECT ops_detect_missing_commissions() INTO part; results := results || jsonb_build_object('missing_commissions', part);
  SELECT ops_detect_missing_earnings() INTO part; results := results || jsonb_build_object('missing_earnings', part);
  SELECT ops_detect_commission_gaps()::jsonb INTO part; results := results || part;
  SELECT ops_detect_duplicate_payments()::jsonb INTO part; results := results || part;
  SELECT ops_detect_duplicate_payouts()::jsonb INTO part; results := results || part;
  -- App performance
  SELECT ops_detect_customer_app_issues()::jsonb INTO part; results := results || part;
  SELECT ops_detect_driver_app_issues()::jsonb INTO part; results := results || part;
  SELECT ops_detect_guest_booking_failures()::jsonb INTO part; results := results || part;
  SELECT ops_detect_corporate_web_issues()::jsonb INTO part; results := results || part;
  SELECT ops_detect_admin_panel_issues()::jsonb INTO part; results := results || part;
  SELECT ops_detect_log_anomalies()::jsonb INTO part; results := results || part;
  RETURN results;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM, 'partial_results', results);
END;
$$;