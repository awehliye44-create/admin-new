-- Phase 1: Add is_synthetic column to ops_logs
ALTER TABLE public.ops_logs ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;

-- Mark existing seed data as synthetic using known patterns
UPDATE public.ops_logs 
SET is_synthetic = true 
WHERE message LIKE '%attempt %' 
   OR message LIKE '%instance %' 
   OR message LIKE '%Guest%' 
   OR message LIKE '%Webhook handler failed%'
   OR message LIKE '%Edge function crashed%'
   OR message LIKE '%Slow screen render%'
   OR message LIKE '%connection reset%'
   OR message LIKE '%demo%';

-- Phase 2: Update detection functions to exclude synthetic data
CREATE OR REPLACE FUNCTION public.ops_detect_log_anomalies()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT source, count(*) as error_count
    FROM ops_logs
    WHERE level IN ('error', 'fatal') 
      AND created_at >= now() - interval '1 hour'
      AND is_synthetic = false
    GROUP BY source
    HAVING count(*) >= 3
  LOOP
    PERFORM ops_upsert_alert(
      ('log_anomaly:' || rec.source)::text,
      'backend'::text,
      (CASE WHEN rec.error_count >= 10 THEN 'critical' ELSE 'warning' END)::text,
      'detection'::text, 'backend'::text,
      ('Error spike: ' || rec.source)::text,
      (rec.error_count || ' errors from ' || rec.source || ' in last hour.')::text,
      p_metadata := jsonb_build_object('source', rec.source, 'error_count', rec.error_count));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('log_anomalies', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('log_anomalies', 0, 'note', 'table not found');
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_fatal_logs()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT id, source, app, message, error_code, trip_id, driver_id, created_at
    FROM public.ops_logs
    WHERE level = 'fatal'
      AND created_at > now() - interval '30 minutes'
      AND is_synthetic = false
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_alerts oa
        WHERE oa.fingerprint = 'fatal_log:' || r.source || ':' || COALESCE(r.error_code, 'none')
          AND oa.status IN ('open', 'acknowledged')
          AND oa.last_detected_at > now() - interval '30 minutes'
      )
  LOOP
    PERFORM public.ops_upsert_alert(
      'fatal_log:' || r.source || ':' || COALESCE(r.error_code, 'none'),
      'logs', 'fatal', 'system', r.app,
      'Fatal Error: ' || r.source,
      r.message,
      r.trip_id, r.driver_id, NULL, NULL,
      'ops_log', r.id::text,
      jsonb_build_object('error_code', r.error_code, 'log_id', r.id)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- Phase 3: Auto-resolve the phantom alerts caused by synthetic data
UPDATE public.ops_alerts 
SET status = 'resolved', resolved_at = now()
WHERE fingerprint IN (
  'log_anomaly:stripe-webhook',
  'log_anomaly:create-payment-intent', 
  'log_anomaly:complete-trip',
  'log_anomaly:dispatch-drivers',
  'log_anomaly:estimate-fare',
  'log_anomaly:admin-payout-batches',
  'admin_panel_slow:dashboard',
  'admin_panel_slow:opsintelligence'
)
AND status IN ('open', 'acknowledged');