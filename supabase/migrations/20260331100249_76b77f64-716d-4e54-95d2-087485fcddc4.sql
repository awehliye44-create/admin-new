
-- 1. Create ops_alert_summaries table
CREATE TABLE IF NOT EXISTS public.ops_alert_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.ops_alerts(id) ON DELETE CASCADE,
  summary text NOT NULL,
  root_cause text NOT NULL,
  recommended_action text NOT NULL,
  confidence_score numeric(3,2) DEFAULT 0.0,
  model_used text NOT NULL DEFAULT 'mock-template-v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ops_alert_summaries_alert_id ON public.ops_alert_summaries(alert_id);

ALTER TABLE public.ops_alert_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read summaries"
  ON public.ops_alert_summaries FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert summaries"
  ON public.ops_alert_summaries FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can delete summaries"
  ON public.ops_alert_summaries FOR DELETE TO authenticated USING (true);

-- 2. Fix 4 detection functions missing is_synthetic = false

CREATE OR REPLACE FUNCTION public.ops_detect_slow_screens()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT e.app_name, e.screen_name, e.metric_name,
      round(avg(e.metric_value)) as avg_value, count(*) as sample_count,
      max(e.metric_value) as max_value, t.warning_threshold, t.critical_threshold,
      CASE WHEN avg(e.metric_value) >= t.critical_threshold THEN 'critical'
           WHEN avg(e.metric_value) >= t.warning_threshold THEN 'warning' END as severity_level
    FROM app_performance_events e
    JOIN app_performance_thresholds t
      ON t.app_name = e.app_name AND t.metric_name = e.metric_name
      AND (t.screen_name IS NULL OR t.screen_name = e.screen_name) AND t.is_active = true
    WHERE e.created_at >= now() - interval '1 hour'
      AND e.is_synthetic = false
    GROUP BY e.app_name, e.screen_name, e.metric_name, t.warning_threshold, t.critical_threshold
    HAVING avg(e.metric_value) >= t.warning_threshold
  LOOP
    PERFORM ops_upsert_alert(
      'slow_screen_' || rec.app_name || '_' || lower(replace(rec.screen_name, ' ', '_')) || '_' || rec.metric_name,
      CASE WHEN rec.app_name = 'customer_app' THEN 'customer_app'
           WHEN rec.app_name = 'driver_app' THEN 'driver_app' ELSE 'backend' END,
      rec.severity_level, 'detection', rec.app_name,
      'Slow ' || rec.screen_name || ' (' || rec.app_name || ')',
      rec.metric_name || ' avg ' || rec.avg_value || 'ms (threshold: ' || rec.warning_threshold || 'ms) over ' || rec.sample_count || ' events in last hour. Max: ' || rec.max_value || 'ms',
      jsonb_build_object('avg_ms', rec.avg_value, 'max_ms', rec.max_value, 'sample_count', rec.sample_count, 'threshold_warning', rec.warning_threshold, 'threshold_critical', rec.critical_threshold)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('slow_screens_detected', v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ops_detect_money_screen_delays()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT e.app_name, e.screen_name, round(avg(e.metric_value)) as avg_ms,
      count(*) as sample_count,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY e.metric_value)) as p95_ms,
      round(max(e.metric_value)) as max_ms
    FROM app_performance_events e
    WHERE e.created_at >= now() - interval '1 hour'
      AND e.is_synthetic = false
      AND e.screen_name IN ('PaymentScreen','PayoutScreen','EarningsScreen','CommissionScreen','WalletScreen','CheckoutPage','BookingPayment','DriverSettlement','InvoiceScreen')
      AND e.metric_name IN ('screen_load_time','api_latency','transaction_time')
    GROUP BY e.app_name, e.screen_name
    HAVING avg(e.metric_value) > 3000
  LOOP
    PERFORM ops_upsert_alert(
      'money_delay_' || rec.app_name || '_' || lower(replace(rec.screen_name, ' ', '_')),
      CASE WHEN rec.app_name = 'customer_app' THEN 'payment' WHEN rec.app_name = 'driver_app' THEN 'earning' ELSE 'payment' END,
      CASE WHEN rec.p95_ms > 8000 THEN 'critical' WHEN rec.p95_ms > 5000 THEN 'warning' ELSE 'info' END,
      'detection', rec.app_name,
      'Money screen delay: ' || rec.screen_name || ' (' || rec.app_name || ')',
      'Avg load ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms, Max ' || rec.max_ms || 'ms over ' || rec.sample_count || ' events',
      jsonb_build_object('avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'max_ms', rec.max_ms, 'sample_count', rec.sample_count)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('money_delays_detected', v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ops_detect_api_latency_spikes()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT e.app_name, e.screen_name as endpoint,
      round(avg(e.metric_value)) as avg_ms, count(*) as sample_count,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY e.metric_value)) as p95_ms
    FROM app_performance_events e
    WHERE e.created_at >= now() - interval '30 minutes'
      AND e.metric_name = 'api_latency'
      AND e.is_synthetic = false
    GROUP BY e.app_name, e.screen_name
    HAVING avg(e.metric_value) > 2000
  LOOP
    PERFORM ops_upsert_alert(
      'api_latency_' || rec.app_name || '_' || lower(replace(rec.endpoint, '/', '_')),
      CASE WHEN rec.app_name IN ('customer_app','driver_app') THEN rec.app_name ELSE 'backend' END,
      CASE WHEN rec.p95_ms > 5000 THEN 'critical' ELSE 'warning' END,
      'detection', rec.app_name,
      'API latency spike: ' || rec.endpoint || ' (' || rec.app_name || ')',
      'Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.sample_count || ' calls in last 30min',
      jsonb_build_object('avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'sample_count', rec.sample_count)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('api_latency_spikes_detected', v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ops_detect_version_issues()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    WITH version_stats AS (
      SELECT app_name, app_version, round(avg(metric_value)) as avg_ms, count(*) as sample_count
      FROM app_performance_events
      WHERE created_at >= now() - interval '6 hours'
        AND metric_name = 'screen_load_time' AND app_version IS NOT NULL
        AND is_synthetic = false
      GROUP BY app_name, app_version HAVING count(*) >= 5
    ),
    app_baseline AS (
      SELECT app_name, round(avg(avg_ms)) as baseline_ms FROM version_stats GROUP BY app_name
    )
    SELECT vs.app_name, vs.app_version, vs.avg_ms, vs.sample_count, ab.baseline_ms,
      round(((vs.avg_ms - ab.baseline_ms) / NULLIF(ab.baseline_ms, 0)) * 100) as pct_slower
    FROM version_stats vs JOIN app_baseline ab ON ab.app_name = vs.app_name
    WHERE vs.avg_ms > ab.baseline_ms * 1.5 AND vs.avg_ms > 3000
  LOOP
    PERFORM ops_upsert_alert(
      'version_perf_' || rec.app_name || '_' || replace(rec.app_version, '.', '_'),
      CASE WHEN rec.app_name IN ('customer_app','driver_app') THEN rec.app_name ELSE 'backend' END,
      CASE WHEN rec.pct_slower > 100 THEN 'critical' ELSE 'warning' END,
      'detection', rec.app_name,
      'Version ' || rec.app_version || ' is ' || rec.pct_slower || '% slower (' || rec.app_name || ')',
      'Avg screen load ' || rec.avg_ms || 'ms vs baseline ' || rec.baseline_ms || 'ms over ' || rec.sample_count || ' events',
      jsonb_build_object('app_version', rec.app_version, 'avg_ms', rec.avg_ms, 'baseline_ms', rec.baseline_ms, 'pct_slower', rec.pct_slower, 'sample_count', rec.sample_count)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('version_issues_detected', v_count);
END;
$function$;

-- 3. Enable pg_cron and pg_net for scheduled detection
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
