-- Index for ops_alerts status + last_detected_at (health summary & alert list queries)
CREATE INDEX IF NOT EXISTS idx_ops_alerts_status_last_detected
  ON public.ops_alerts (status, last_detected_at DESC);

-- Index for ops_alerts category filtering
CREATE INDEX IF NOT EXISTS idx_ops_alerts_category_status
  ON public.ops_alerts (category, status);

-- Index for ops_logs level + created_at (log anomaly detection & explorer)
CREATE INDEX IF NOT EXISTS idx_ops_logs_level_created
  ON public.ops_logs (level, created_at DESC)
  WHERE level IN ('error', 'fatal', 'warn');

-- Index for ops_logs source + created_at (source filter & anomaly detection)  
CREATE INDEX IF NOT EXISTS idx_ops_logs_source_created
  ON public.ops_logs (source, created_at DESC);

-- Index for app_performance_events detection queries
CREATE INDEX IF NOT EXISTS idx_perf_events_app_created_nonsynthetic
  ON public.app_performance_events (app_name, created_at DESC)
  WHERE is_synthetic = false;

-- Index for ops_alert_summaries lookup
CREATE INDEX IF NOT EXISTS idx_ops_alert_summaries_alert
  ON public.ops_alert_summaries (alert_id);

-- Index for ops_fix_actions lookup
CREATE INDEX IF NOT EXISTS idx_ops_fix_actions_alert
  ON public.ops_fix_actions (alert_id);