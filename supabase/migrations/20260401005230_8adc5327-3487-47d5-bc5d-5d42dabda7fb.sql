
-- =====================================================
-- COST OPTIMIZATION MIGRATION
-- =====================================================

-- 1. DATA RETENTION: Auto-delete old performance events (>14 days) and logs (>7 days)
-- Using pg_cron for scheduled cleanup

-- Create cleanup function
CREATE OR REPLACE FUNCTION public.ops_cleanup_old_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  perf_deleted int;
  logs_deleted int;
  summaries_deleted int;
  resolved_deleted int;
BEGIN
  -- Delete performance events older than 14 days
  DELETE FROM app_performance_events
  WHERE created_at < now() - interval '14 days';
  GET DIAGNOSTICS perf_deleted = ROW_COUNT;

  -- Delete ops_logs older than 7 days
  DELETE FROM ops_logs
  WHERE created_at < now() - interval '7 days';
  GET DIAGNOSTICS logs_deleted = ROW_COUNT;

  -- Delete AI summaries for resolved alerts older than 30 days
  DELETE FROM ops_alert_summaries
  WHERE created_at < now() - interval '30 days';
  GET DIAGNOSTICS summaries_deleted = ROW_COUNT;

  -- Delete resolved alerts older than 30 days
  DELETE FROM ops_alerts
  WHERE status = 'resolved'
    AND resolved_at < now() - interval '30 days';
  GET DIAGNOSTICS resolved_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'perf_events_deleted', perf_deleted,
    'logs_deleted', logs_deleted,
    'summaries_deleted', summaries_deleted,
    'resolved_alerts_deleted', resolved_deleted,
    'run_at', now()
  );
END;
$$;

-- 2. INDEXES for query optimization
-- Index on app_performance_events for time-range + synthetic filter queries
CREATE INDEX IF NOT EXISTS idx_perf_events_created_synthetic 
  ON app_performance_events (created_at DESC, is_synthetic) 
  WHERE is_synthetic = false;

-- Index for telemetry metric filtering  
CREATE INDEX IF NOT EXISTS idx_perf_events_app_metric
  ON app_performance_events (app_name, metric_name, created_at DESC)
  WHERE is_synthetic = false;

-- Index on ops_logs for time-range queries
CREATE INDEX IF NOT EXISTS idx_ops_logs_created_level
  ON ops_logs (created_at DESC, level);

-- Index on ops_alerts for status filtering (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_ops_alerts_status_detected
  ON ops_alerts (status, last_detected_at DESC)
  WHERE status IN ('open', 'acknowledged');

-- Index on ops_alerts for fingerprint deduplication
CREATE INDEX IF NOT EXISTS idx_ops_alerts_fingerprint_status
  ON ops_alerts (fingerprint, status);

-- Index on ops_alert_summaries for alert lookups
CREATE INDEX IF NOT EXISTS idx_alert_summaries_alert
  ON ops_alert_summaries (alert_id, created_at DESC);
