
-- ============================================================
-- ONECAB Ops Intelligence - Phase 1: Foundation Tables
-- ============================================================

-- 1. SYSTEM ALERTS - Central alert table for all detected issues
CREATE TABLE IF NOT EXISTS public.ops_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL,
  category text NOT NULL, -- payment, commission, earning, payout, dispatch, guest_booking, corporate_booking, customer_app, driver_app, backend, logs, duplication, system
  severity text NOT NULL DEFAULT 'warning', -- info, warning, critical, fatal
  status text NOT NULL DEFAULT 'open', -- open, acknowledged, resolved, suppressed
  source text NOT NULL DEFAULT 'system', -- system, edge_function, cron, manual
  app text, -- admin, driver, customer, guest, corporate, backend
  title text NOT NULL,
  description text,
  fingerprint_count int NOT NULL DEFAULT 1,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  suppressed_until timestamptz,
  related_trip_id uuid,
  related_driver_id uuid,
  related_payment_id uuid,
  related_payout_batch_id uuid,
  related_entity_type text,
  related_entity_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint on fingerprint to enable upsert dedup
CREATE UNIQUE INDEX IF NOT EXISTS ops_alerts_fingerprint_open_idx 
  ON public.ops_alerts (fingerprint) WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS ops_alerts_category_idx ON public.ops_alerts (category);
CREATE INDEX IF NOT EXISTS ops_alerts_severity_idx ON public.ops_alerts (severity);
CREATE INDEX IF NOT EXISTS ops_alerts_status_idx ON public.ops_alerts (status);
CREATE INDEX IF NOT EXISTS ops_alerts_last_detected_idx ON public.ops_alerts (last_detected_at DESC);
CREATE INDEX IF NOT EXISTS ops_alerts_source_idx ON public.ops_alerts (source);
CREATE INDEX IF NOT EXISTS ops_alerts_app_idx ON public.ops_alerts (app);

-- 2. SYSTEM LOGS - Structured operational logs
CREATE TABLE IF NOT EXISTS public.ops_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL DEFAULT 'info', -- debug, info, warn, error, fatal
  source text NOT NULL, -- edge function name, cron job, etc.
  app text, -- admin, driver, customer, guest, corporate, backend
  message text NOT NULL,
  error_code text,
  trip_id uuid,
  driver_id uuid,
  user_id uuid,
  request_id text,
  duration_ms int,
  http_status int,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_logs_level_idx ON public.ops_logs (level);
CREATE INDEX IF NOT EXISTS ops_logs_source_idx ON public.ops_logs (source);
CREATE INDEX IF NOT EXISTS ops_logs_app_idx ON public.ops_logs (app);
CREATE INDEX IF NOT EXISTS ops_logs_created_at_idx ON public.ops_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ops_logs_trip_id_idx ON public.ops_logs (trip_id) WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ops_logs_error_code_idx ON public.ops_logs (error_code) WHERE error_code IS NOT NULL;

-- 3. OPS EVENTS - Unified event stream for financial and operational events
-- Replaces separate payment_events, commission_events, etc. with a single polymorphic table
CREATE TABLE IF NOT EXISTS public.ops_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL, -- payment_failed, commission_missing, earning_missing, payout_failed, dispatch_stuck, booking_dropped, duplicate_detected, webhook_failed, api_error, guest_quote_failed, guest_checkout_failed
  category text NOT NULL, -- payment, commission, earning, payout, dispatch, guest_booking, corporate_booking, duplication, webhook, api
  severity text NOT NULL DEFAULT 'warning',
  app text,
  trip_id uuid,
  driver_id uuid,
  customer_id uuid,
  payment_id uuid,
  payout_batch_id uuid,
  service_area_id uuid,
  amount_pence int,
  currency_code text,
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  alert_id uuid REFERENCES public.ops_alerts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_events_type_idx ON public.ops_events (event_type);
CREATE INDEX IF NOT EXISTS ops_events_category_idx ON public.ops_events (category);
CREATE INDEX IF NOT EXISTS ops_events_severity_idx ON public.ops_events (severity);
CREATE INDEX IF NOT EXISTS ops_events_created_at_idx ON public.ops_events (created_at DESC);
CREATE INDEX IF NOT EXISTS ops_events_trip_id_idx ON public.ops_events (trip_id) WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ops_events_driver_id_idx ON public.ops_events (driver_id) WHERE driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ops_events_alert_id_idx ON public.ops_events (alert_id) WHERE alert_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ops_events_resolved_idx ON public.ops_events (resolved) WHERE resolved = false;

-- 4. ALERT RULES - Configurable rules for alert generation
CREATE TABLE IF NOT EXISTS public.ops_alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  category text NOT NULL,
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  is_active boolean NOT NULL DEFAULT true,
  threshold_count int DEFAULT 1, -- how many events before alerting
  threshold_window_minutes int DEFAULT 60, -- time window for threshold
  cooldown_minutes int DEFAULT 30, -- min time between alerts of same type
  auto_resolve_minutes int, -- auto-resolve after N minutes if no new events
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5. AI INCIDENT SUMMARIES
CREATE TABLE IF NOT EXISTS public.ops_ai_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.ops_alerts(id) ON DELETE CASCADE,
  summary text NOT NULL,
  root_cause text,
  recommended_action text,
  confidence_score numeric(3,2), -- 0.00 to 1.00
  model_used text DEFAULT 'mock',
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_ai_summaries_alert_id_idx ON public.ops_ai_summaries (alert_id);

-- 6. updated_at triggers
CREATE OR REPLACE FUNCTION public.ops_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER ops_alerts_updated_at
  BEFORE UPDATE ON public.ops_alerts
  FOR EACH ROW EXECUTE FUNCTION public.ops_set_updated_at();

CREATE TRIGGER ops_alert_rules_updated_at
  BEFORE UPDATE ON public.ops_alert_rules
  FOR EACH ROW EXECUTE FUNCTION public.ops_set_updated_at();

-- 7. Enable RLS (admin-only access)
ALTER TABLE public.ops_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_ai_summaries ENABLE ROW LEVEL SECURITY;

-- RLS Policies: authenticated users with admin role can access
CREATE POLICY "Admins can manage ops_alerts"
  ON public.ops_alerts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage ops_logs"
  ON public.ops_logs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage ops_events"
  ON public.ops_events FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage ops_alert_rules"
  ON public.ops_alert_rules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage ops_ai_summaries"
  ON public.ops_ai_summaries FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 8. Seed default alert rules
INSERT INTO public.ops_alert_rules (name, category, event_type, severity, threshold_count, threshold_window_minutes, cooldown_minutes) VALUES
  ('Failed Payment Alert', 'payment', 'payment_failed', 'critical', 1, 5, 15),
  ('Missing Commission Alert', 'commission', 'commission_missing', 'critical', 1, 60, 30),
  ('Missing Driver Earnings', 'earning', 'earning_missing', 'critical', 1, 60, 30),
  ('Failed Payout Alert', 'payout', 'payout_failed', 'critical', 1, 5, 15),
  ('Stuck Dispatch Alert', 'dispatch', 'dispatch_stuck', 'warning', 1, 15, 10),
  ('Guest Quote Failure', 'guest_booking', 'guest_quote_failed', 'warning', 3, 15, 30),
  ('Guest Checkout Failure', 'guest_booking', 'guest_checkout_failed', 'critical', 1, 5, 15),
  ('API 5xx Spike', 'api', 'api_error', 'critical', 5, 5, 15),
  ('Edge Function Failure', 'backend', 'edge_function_failed', 'warning', 3, 10, 20),
  ('Webhook Failure', 'webhook', 'webhook_failed', 'warning', 3, 15, 30),
  ('Duplicate Booking Detected', 'duplication', 'duplicate_booking', 'warning', 1, 5, 30),
  ('Duplicate Payment Detected', 'duplication', 'duplicate_payment', 'critical', 1, 5, 15),
  ('Duplicate Payout Detected', 'duplication', 'duplicate_payout', 'critical', 1, 5, 15),
  ('Duplicate Commission Detected', 'duplication', 'duplicate_commission', 'warning', 1, 5, 30),
  ('Duplicate Dispatch Detected', 'duplication', 'duplicate_dispatch', 'warning', 1, 5, 30),
  ('Booking Drop-off', 'dispatch', 'booking_dropped', 'warning', 3, 30, 60),
  ('High Error Log Rate', 'logs', 'error_spike', 'critical', 10, 5, 15),
  ('Latency Spike', 'api', 'latency_spike', 'warning', 5, 10, 20);

-- 9. Enable realtime for ops_alerts
ALTER PUBLICATION supabase_realtime ADD TABLE public.ops_alerts;
