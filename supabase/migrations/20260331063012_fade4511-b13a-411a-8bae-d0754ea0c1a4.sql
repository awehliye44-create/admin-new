
-- Corporate booking detection function
CREATE OR REPLACE FUNCTION public.ops_detect_corporate_booking_issues()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  -- Detect failed corporate invoices
  FOR rec IN
    SELECT ci.id, ci.corporate_account_id, ci.status, ca.company_name
    FROM corporate_invoices ci
    JOIN corporate_accounts ca ON ca.id = ci.corporate_account_id
    WHERE ci.status = 'overdue' AND ci.updated_at >= now() - interval '24 hours'
    LIMIT 20
  LOOP
    PERFORM ops_upsert_alert('corporate_overdue:' || rec.id, 'corporate_booking', 'warning', 'detection', 'backend',
      'Overdue corporate invoice: ' || coalesce(rec.company_name, 'Unknown'),
      'Invoice ' || rec.id || ' for ' || coalesce(rec.company_name, 'Unknown') || ' is overdue.',
      jsonb_build_object('invoice_id', rec.id, 'company', rec.company_name));
    v_count := v_count + 1;
  END LOOP;
  -- Detect suspended corporate accounts
  FOR rec IN
    SELECT id, company_name FROM corporate_accounts
    WHERE status = 'suspended' AND updated_at >= now() - interval '24 hours'
    LIMIT 10
  LOOP
    PERFORM ops_upsert_alert('corporate_suspended:' || rec.id, 'corporate_booking', 'critical', 'detection', 'backend',
      'Corporate account suspended: ' || coalesce(rec.company_name, 'Unknown'),
      'Account ' || coalesce(rec.company_name, 'Unknown') || ' has been suspended.',
      jsonb_build_object('account_id', rec.id, 'company', rec.company_name));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('corporate_booking_issues', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('corporate_booking_issues', 0, 'note', 'table not found');
END; $$;

-- Customer app detection (from app_performance_events)
CREATE OR REPLACE FUNCTION public.ops_detect_customer_app_issues()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'customer_app' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
    GROUP BY screen_name
    HAVING avg(metric_value) > 3000
  LOOP
    PERFORM ops_upsert_alert('customer_app_slow:' || lower(replace(rec.screen_name, ' ', '_')),
      'customer_app',
      CASE WHEN rec.p95_ms > 8000 THEN 'critical' ELSE 'warning' END,
      'detection', 'customer_app',
      'Slow customer screen: ' || rec.screen_name,
      'Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.cnt || ' events in last hour.',
      jsonb_build_object('screen', rec.screen_name, 'avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('customer_app_issues', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('customer_app_issues', 0, 'note', 'table not found');
END; $$;

-- Driver app detection (from app_performance_events)
CREATE OR REPLACE FUNCTION public.ops_detect_driver_app_issues()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'driver_app' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
    GROUP BY screen_name
    HAVING avg(metric_value) > 3000
  LOOP
    PERFORM ops_upsert_alert('driver_app_slow:' || lower(replace(rec.screen_name, ' ', '_')),
      'driver_app',
      CASE WHEN rec.p95_ms > 8000 THEN 'critical' ELSE 'warning' END,
      'detection', 'driver_app',
      'Slow driver screen: ' || rec.screen_name,
      'Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.cnt || ' events in last hour.',
      jsonb_build_object('screen', rec.screen_name, 'avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('driver_app_issues', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('driver_app_issues', 0, 'note', 'table not found');
END; $$;

-- Update master orchestrator to include new detections
CREATE OR REPLACE FUNCTION public.ops_run_all_detections()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE results jsonb := '{}'::jsonb; part jsonb;
BEGIN
  BEGIN SELECT ops_detect_payment_gaps() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('payment_gaps_error', SQLERRM); END;
  BEGIN SELECT ops_detect_commission_gaps() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('commission_gaps_error', SQLERRM); END;
  BEGIN SELECT ops_detect_earning_gaps() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('earning_gaps_error', SQLERRM); END;
  BEGIN SELECT ops_detect_payout_failures() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('payout_failures_error', SQLERRM); END;
  BEGIN SELECT ops_detect_stuck_dispatch() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('stuck_dispatch_error', SQLERRM); END;
  BEGIN SELECT ops_detect_guest_booking_failures() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('guest_booking_error', SQLERRM); END;
  BEGIN SELECT ops_detect_log_anomalies() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('log_anomalies_error', SQLERRM); END;
  BEGIN SELECT ops_detect_duplicate_payments() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('dup_payments_error', SQLERRM); END;
  BEGIN SELECT ops_detect_duplicate_bookings() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('dup_bookings_error', SQLERRM); END;
  BEGIN SELECT ops_detect_duplicate_payouts() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('dup_payouts_error', SQLERRM); END;
  BEGIN SELECT ops_detect_duplicate_dispatch() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('dup_dispatch_error', SQLERRM); END;
  BEGIN SELECT ops_detect_slow_screens() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('slow_screens_error', SQLERRM); END;
  BEGIN SELECT ops_detect_money_screen_delays() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('money_delays_error', SQLERRM); END;
  BEGIN SELECT ops_detect_api_latency_spikes() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('api_latency_error', SQLERRM); END;
  BEGIN SELECT ops_detect_version_issues() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('version_issues_error', SQLERRM); END;
  -- NEW: Corporate, Customer App, Driver App
  BEGIN SELECT ops_detect_corporate_booking_issues() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('corporate_error', SQLERRM); END;
  BEGIN SELECT ops_detect_customer_app_issues() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('customer_app_error', SQLERRM); END;
  BEGIN SELECT ops_detect_driver_app_issues() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('driver_app_error', SQLERRM); END;
  RETURN results;
END; $$;
