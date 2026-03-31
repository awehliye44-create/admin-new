
-- ============================================================
-- APP PERFORMANCE EVENTS TABLE
-- Stores telemetry from customer app, driver app, guest web
-- ============================================================
CREATE TABLE public.app_performance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name text NOT NULL CHECK (app_name IN ('customer_app', 'driver_app', 'guest_web', 'admin_web')),
  screen_name text NOT NULL,
  metric_name text NOT NULL,
  metric_value numeric NOT NULL,
  unit text NOT NULL DEFAULT 'ms',
  app_version text,
  platform text,
  device_model text,
  os_version text,
  user_id uuid,
  session_id text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for query patterns
CREATE INDEX idx_ape_app_screen ON public.app_performance_events(app_name, screen_name);
CREATE INDEX idx_ape_created ON public.app_performance_events(created_at DESC);
CREATE INDEX idx_ape_metric ON public.app_performance_events(metric_name);
CREATE INDEX idx_ape_app_version ON public.app_performance_events(app_name, app_version);

-- RLS
ALTER TABLE public.app_performance_events ENABLE ROW LEVEL SECURITY;

-- Allow edge function (service role) to insert
CREATE POLICY "Service role can manage performance events"
  ON public.app_performance_events FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Allow authenticated admins to read
CREATE POLICY "Authenticated users can read performance events"
  ON public.app_performance_events FOR SELECT
  TO authenticated USING (true);

-- Allow anon to insert (for guest_web telemetry)
CREATE POLICY "Anon can insert performance events"
  ON public.app_performance_events FOR INSERT
  TO anon WITH CHECK (true);

-- ============================================================
-- APP PERFORMANCE THRESHOLDS TABLE
-- Configurable thresholds for alerting
-- ============================================================
CREATE TABLE public.app_performance_thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name text NOT NULL,
  screen_name text,
  metric_name text NOT NULL,
  warning_threshold numeric NOT NULL,
  critical_threshold numeric NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_performance_thresholds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage thresholds"
  ON public.app_performance_thresholds FOR ALL
  TO authenticated USING (true) WITH CHECK (true);

-- Seed default thresholds
INSERT INTO public.app_performance_thresholds (app_name, screen_name, metric_name, warning_threshold, critical_threshold) VALUES
  ('customer_app', 'PaymentScreen', 'screen_load_time', 3000, 8000),
  ('customer_app', 'BookingFlow', 'screen_load_time', 2000, 5000),
  ('customer_app', 'HomeScreen', 'screen_load_time', 1500, 4000),
  ('customer_app', NULL, 'api_latency', 2000, 5000),
  ('driver_app', 'EarningsScreen', 'screen_load_time', 3000, 8000),
  ('driver_app', 'PayoutScreen', 'screen_load_time', 3000, 8000),
  ('driver_app', 'HomeScreen', 'screen_load_time', 1500, 4000),
  ('driver_app', NULL, 'api_latency', 2000, 5000),
  ('guest_web', 'CheckoutPage', 'screen_load_time', 3000, 8000),
  ('guest_web', 'QuotePage', 'screen_load_time', 2000, 5000);

-- ============================================================
-- DETECTION FUNCTION: Slow screens
-- ============================================================
CREATE OR REPLACE FUNCTION public.ops_detect_slow_screens()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT
      e.app_name,
      e.screen_name,
      e.metric_name,
      round(avg(e.metric_value)) as avg_value,
      count(*) as sample_count,
      max(e.metric_value) as max_value,
      t.warning_threshold,
      t.critical_threshold,
      CASE
        WHEN avg(e.metric_value) >= t.critical_threshold THEN 'critical'
        WHEN avg(e.metric_value) >= t.warning_threshold THEN 'warning'
      END as severity_level
    FROM app_performance_events e
    JOIN app_performance_thresholds t
      ON t.app_name = e.app_name
      AND t.metric_name = e.metric_name
      AND (t.screen_name IS NULL OR t.screen_name = e.screen_name)
      AND t.is_active = true
    WHERE e.created_at >= now() - interval '1 hour'
    GROUP BY e.app_name, e.screen_name, e.metric_name,
             t.warning_threshold, t.critical_threshold
    HAVING avg(e.metric_value) >= t.warning_threshold
  LOOP
    PERFORM ops_upsert_alert(
      'slow_screen_' || rec.app_name || '_' || lower(replace(rec.screen_name, ' ', '_')) || '_' || rec.metric_name,
      CASE WHEN rec.app_name = 'customer_app' THEN 'customer_app'
           WHEN rec.app_name = 'driver_app' THEN 'driver_app'
           ELSE 'backend' END,
      rec.severity_level,
      'detection',
      rec.app_name,
      'Slow ' || rec.screen_name || ' (' || rec.app_name || ')',
      rec.metric_name || ' avg ' || rec.avg_value || 'ms (threshold: ' || rec.warning_threshold || 'ms) over ' || rec.sample_count || ' events in last hour. Max: ' || rec.max_value || 'ms',
      jsonb_build_object(
        'avg_ms', rec.avg_value,
        'max_ms', rec.max_value,
        'sample_count', rec.sample_count,
        'threshold_warning', rec.warning_threshold,
        'threshold_critical', rec.critical_threshold
      )
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('slow_screens_detected', v_count);
END;
$$;

-- ============================================================
-- DETECTION FUNCTION: Payment/money screen delays
-- ============================================================
CREATE OR REPLACE FUNCTION public.ops_detect_money_screen_delays()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT
      e.app_name,
      e.screen_name,
      round(avg(e.metric_value)) as avg_ms,
      count(*) as sample_count,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY e.metric_value)) as p95_ms,
      round(max(e.metric_value)) as max_ms
    FROM app_performance_events e
    WHERE e.created_at >= now() - interval '1 hour'
      AND e.screen_name IN (
        'PaymentScreen', 'PayoutScreen', 'EarningsScreen',
        'CommissionScreen', 'WalletScreen', 'CheckoutPage',
        'BookingPayment', 'DriverSettlement', 'InvoiceScreen'
      )
      AND e.metric_name IN ('screen_load_time', 'api_latency', 'transaction_time')
    GROUP BY e.app_name, e.screen_name
    HAVING avg(e.metric_value) > 3000
  LOOP
    PERFORM ops_upsert_alert(
      'money_delay_' || rec.app_name || '_' || lower(replace(rec.screen_name, ' ', '_')),
      CASE WHEN rec.app_name = 'customer_app' THEN 'payment'
           WHEN rec.app_name = 'driver_app' THEN 'earning'
           ELSE 'payment' END,
      CASE WHEN rec.p95_ms > 8000 THEN 'critical'
           WHEN rec.p95_ms > 5000 THEN 'warning'
           ELSE 'info' END,
      'detection',
      rec.app_name,
      'Money screen delay: ' || rec.screen_name || ' (' || rec.app_name || ')',
      'Avg load ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms, Max ' || rec.max_ms || 'ms over ' || rec.sample_count || ' events',
      jsonb_build_object(
        'avg_ms', rec.avg_ms,
        'p95_ms', rec.p95_ms,
        'max_ms', rec.max_ms,
        'sample_count', rec.sample_count
      )
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('money_delays_detected', v_count);
END;
$$;

-- ============================================================
-- DETECTION FUNCTION: API latency spikes by app
-- ============================================================
CREATE OR REPLACE FUNCTION public.ops_detect_api_latency_spikes()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int := 0;
  rec record;
BEGIN
  FOR rec IN
    SELECT
      e.app_name,
      e.screen_name as endpoint,
      round(avg(e.metric_value)) as avg_ms,
      count(*) as sample_count,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY e.metric_value)) as p95_ms
    FROM app_performance_events e
    WHERE e.created_at >= now() - interval '30 minutes'
      AND e.metric_name = 'api_latency'
    GROUP BY e.app_name, e.screen_name
    HAVING avg(e.metric_value) > 2000
  LOOP
    PERFORM ops_upsert_alert(
      'api_latency_' || rec.app_name || '_' || lower(replace(rec.endpoint, '/', '_')),
      CASE WHEN rec.app_name IN ('customer_app', 'driver_app') THEN rec.app_name ELSE 'backend' END,
      CASE WHEN rec.p95_ms > 5000 THEN 'critical' ELSE 'warning' END,
      'detection',
      rec.app_name,
      'API latency spike: ' || rec.endpoint || ' (' || rec.app_name || ')',
      'Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.sample_count || ' calls in last 30min',
      jsonb_build_object('avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'sample_count', rec.sample_count)
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('api_latency_spikes_detected', v_count);
END;
$$;

-- ============================================================
-- DETECTION FUNCTION: Version-specific performance issues
-- ============================================================
CREATE OR REPLACE FUNCTION public.ops_detect_version_issues()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int := 0;
  rec record;
BEGIN
  FOR rec IN
    WITH version_stats AS (
      SELECT
        app_name, app_version,
        round(avg(metric_value)) as avg_ms,
        count(*) as sample_count
      FROM app_performance_events
      WHERE created_at >= now() - interval '6 hours'
        AND metric_name = 'screen_load_time'
        AND app_version IS NOT NULL
      GROUP BY app_name, app_version
      HAVING count(*) >= 5
    ),
    app_baseline AS (
      SELECT app_name, round(avg(avg_ms)) as baseline_ms
      FROM version_stats
      GROUP BY app_name
    )
    SELECT
      vs.app_name, vs.app_version, vs.avg_ms, vs.sample_count,
      ab.baseline_ms,
      round(((vs.avg_ms - ab.baseline_ms) / NULLIF(ab.baseline_ms, 0)) * 100) as pct_slower
    FROM version_stats vs
    JOIN app_baseline ab ON ab.app_name = vs.app_name
    WHERE vs.avg_ms > ab.baseline_ms * 1.5
      AND vs.avg_ms > 3000
  LOOP
    PERFORM ops_upsert_alert(
      'version_perf_' || rec.app_name || '_' || replace(rec.app_version, '.', '_'),
      CASE WHEN rec.app_name IN ('customer_app', 'driver_app') THEN rec.app_name ELSE 'backend' END,
      CASE WHEN rec.pct_slower > 100 THEN 'critical' ELSE 'warning' END,
      'detection',
      rec.app_name,
      'Version ' || rec.app_version || ' is ' || rec.pct_slower || '% slower (' || rec.app_name || ')',
      'Avg screen load ' || rec.avg_ms || 'ms vs baseline ' || rec.baseline_ms || 'ms over ' || rec.sample_count || ' events',
      jsonb_build_object(
        'app_version', rec.app_version,
        'avg_ms', rec.avg_ms,
        'baseline_ms', rec.baseline_ms,
        'pct_slower', rec.pct_slower,
        'sample_count', rec.sample_count
      )
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('version_issues_detected', v_count);
END;
$$;

-- ============================================================
-- Update master detection orchestrator
-- ============================================================
CREATE OR REPLACE FUNCTION public.ops_run_all_detections()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  results jsonb := '{}'::jsonb;
  part jsonb;
BEGIN
  -- Existing detections
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
  -- NEW: App performance detections
  BEGIN SELECT ops_detect_slow_screens() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('slow_screens_error', SQLERRM); END;
  BEGIN SELECT ops_detect_money_screen_delays() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('money_delays_error', SQLERRM); END;
  BEGIN SELECT ops_detect_api_latency_spikes() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('api_latency_error', SQLERRM); END;
  BEGIN SELECT ops_detect_version_issues() INTO part; results := results || part; EXCEPTION WHEN OTHERS THEN results := results || jsonb_build_object('version_issues_error', SQLERRM); END;

  RETURN results;
END;
$$;

-- ============================================================
-- Materialized view for app health summary (fast dashboard queries)
-- ============================================================
CREATE OR REPLACE VIEW public.app_health_summary AS
SELECT
  app_name,
  screen_name,
  metric_name,
  count(*) as event_count,
  round(avg(metric_value)) as avg_ms,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY metric_value)) as median_ms,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms,
  round(percentile_cont(0.99) WITHIN GROUP (ORDER BY metric_value)) as p99_ms,
  round(min(metric_value)) as min_ms,
  round(max(metric_value)) as max_ms,
  max(created_at) as last_event_at
FROM app_performance_events
WHERE created_at >= now() - interval '1 hour'
GROUP BY app_name, screen_name, metric_name;
