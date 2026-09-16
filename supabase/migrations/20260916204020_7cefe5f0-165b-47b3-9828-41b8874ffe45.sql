CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type_prefix_created
  ON public.audit_logs (event_type text_pattern_ops, created_at DESC);