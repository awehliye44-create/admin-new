
-- Add thresholds for corporate_web screens
INSERT INTO public.app_performance_thresholds (app_name, screen_name, metric_name, warning_threshold, critical_threshold, is_active)
VALUES
  ('corporate_web', 'LoginPage', 'screen_load_time', 1500, 4000, true),
  ('corporate_web', 'LoginPage', 'api_latency', 1000, 3000, true),
  ('corporate_web', 'AccountDashboard', 'screen_load_time', 2000, 5000, true),
  ('corporate_web', 'AccountDashboard', 'api_latency', 1500, 4000, true),
  ('corporate_web', 'QuoteFlow', 'screen_load_time', 2000, 5000, true),
  ('corporate_web', 'QuoteFlow', 'api_latency', 1500, 4000, true),
  ('corporate_web', 'BookingFlow', 'screen_load_time', 2000, 5000, true),
  ('corporate_web', 'BookingFlow', 'api_latency', 1500, 4000, true),
  ('corporate_web', 'PaymentFlow', 'screen_load_time', 2500, 6000, true),
  ('corporate_web', 'PaymentFlow', 'transaction_time', 3000, 8000, true),
  ('corporate_web', 'BookingConfirmation', 'screen_load_time', 1500, 4000, true),
  ('corporate_web', 'InvoicePage', 'screen_load_time', 2000, 5000, true),
  ('corporate_web', 'InvoicePage', 'api_latency', 1500, 4000, true),
  ('corporate_web', 'TripHistory', 'screen_load_time', 2000, 5000, true),
  ('corporate_web', 'TripHistory', 'api_latency', 2000, 5000, true),
  ('corporate_web', 'EmployeeManagement', 'screen_load_time', 2000, 5000, true),
  ('corporate_web', 'ReportsPage', 'screen_load_time', 2500, 6000, true),
  ('corporate_web', 'ReportsPage', 'api_latency', 2000, 5000, true),
  -- Add more guest_web thresholds
  ('guest_web', 'QuotePage', 'api_latency', 1500, 4000, true),
  ('guest_web', 'BookingConfirmation', 'screen_load_time', 1500, 4000, true),
  ('guest_web', 'PaymentPage', 'screen_load_time', 2000, 5000, true),
  ('guest_web', 'PaymentPage', 'api_latency', 1500, 4000, true),
  ('guest_web', 'LandingPage', 'screen_load_time', 1500, 4000, true),
  ('guest_web', 'LandingPage', 'ttfb', 500, 1500, true),
  ('guest_web', 'CheckoutPage', 'transaction_time', 3000, 8000, true)
ON CONFLICT DO NOTHING;

-- Create detection function for corporate_web
CREATE OR REPLACE FUNCTION public.ops_detect_corporate_web_issues()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
  v_rec record;
BEGIN
  FOR v_rec IN
    SELECT
      e.screen_name,
      e.metric_name,
      round(avg(e.metric_value))::int AS avg_ms,
      count(*) AS cnt,
      t.warning_threshold,
      t.critical_threshold
    FROM app_performance_events e
    JOIN app_performance_thresholds t
      ON t.app_name = 'corporate_web'
      AND t.metric_name = e.metric_name
      AND (t.screen_name IS NULL OR t.screen_name = e.screen_name)
      AND t.is_active = true
    WHERE e.app_name = 'corporate_web'
      AND e.created_at >= now() - interval '1 hour'
    GROUP BY e.screen_name, e.metric_name, t.warning_threshold, t.critical_threshold
    HAVING avg(e.metric_value) > t.warning_threshold
  LOOP
    PERFORM ops_upsert_alert(
      'auto:corporate_web_slow:' || v_rec.screen_name || ':' || v_rec.metric_name,
      'corporate_booking',
      CASE WHEN v_rec.avg_ms >= v_rec.critical_threshold THEN 'critical' ELSE 'warning' END,
      'detection',
      'corporate_web',
      'Corporate Web Slow: ' || v_rec.screen_name,
      v_rec.screen_name || ' ' || v_rec.metric_name || ' avg ' || v_rec.avg_ms || 'ms (threshold: ' || v_rec.warning_threshold || 'ms) over ' || v_rec.cnt || ' events.',
      jsonb_build_object('screen', v_rec.screen_name, 'metric', v_rec.metric_name, 'avg_ms', v_rec.avg_ms, 'event_count', v_rec.cnt)
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('corporate_web_issues', v_count);
END;
$$;

-- Update orchestrator to include corporate_web detection
CREATE OR REPLACE FUNCTION public.ops_run_all_detections()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_results jsonb := '{}'::jsonb;
  v_partial jsonb;
BEGIN
  BEGIN v_partial := ops_detect_payment_gaps(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('payment_gaps_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_commission_gaps(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('commission_gaps_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_earning_gaps(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('earning_gaps_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_payout_failures(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('payout_failures_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_stuck_dispatch(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('stuck_dispatch_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_guest_booking_failures(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('guest_booking_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_log_anomalies(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('log_anomalies_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_duplicate_payments(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_payments_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_duplicate_bookings(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_bookings_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_duplicate_payouts(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_payouts_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_duplicate_dispatch(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_dispatch_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_corporate_booking_issues(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('corporate_booking_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_customer_app_issues(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('customer_app_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_driver_app_issues(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('driver_app_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_admin_panel_issues(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('admin_panel_error', SQLERRM); END;
  BEGIN v_partial := ops_detect_corporate_web_issues(); v_results := v_results || v_partial; EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('corporate_web_error', SQLERRM); END;

  RETURN v_results;
END;
$$;
