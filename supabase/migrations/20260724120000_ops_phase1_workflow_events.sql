-- =============================================================================
-- OPS INTELLIGENCE PHASE 1 — Workflow event ingestion + detector restoration
-- =============================================================================

-- 1. Workflow events table (client + edge production telemetry)
CREATE TABLE IF NOT EXISTS public.ops_workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  app_name text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  trip_id uuid,
  driver_id uuid,
  customer_id uuid,
  error_code text,
  duration_ms int,
  app_version text,
  platform text,
  device_model text,
  os_version text,
  session_id text,
  message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  alert_id uuid REFERENCES public.ops_alerts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_workflow_events_type_created
  ON public.ops_workflow_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_workflow_events_trip
  ON public.ops_workflow_events (trip_id, created_at DESC)
  WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ops_workflow_events_app_created
  ON public.ops_workflow_events (app_name, created_at DESC);

ALTER TABLE public.ops_workflow_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read ops_workflow_events" ON public.ops_workflow_events;
CREATE POLICY "Admins can read ops_workflow_events"
  ON public.ops_workflow_events FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'moderator'::app_role)
  );

DROP POLICY IF EXISTS "Service role manages ops_workflow_events" ON public.ops_workflow_events;
CREATE POLICY "Service role manages ops_workflow_events"
  ON public.ops_workflow_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 2. Map event_type → ops category / app
CREATE OR REPLACE FUNCTION public.ops_workflow_event_category(p_event_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_event_type LIKE 'driver_%' THEN 'driver_app'
    WHEN p_event_type LIKE 'customer_%' THEN 'customer_app'
    ELSE 'backend'
  END;
$$;

CREATE OR REPLACE FUNCTION public.ops_workflow_event_app(p_event_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_event_type LIKE 'driver_%' THEN 'driver_app'
    WHEN p_event_type LIKE 'customer_%' THEN 'customer_app'
    ELSE 'backend'
  END;
$$;

-- 3. Ingest RPC — called by ingest-ops-event edge function
CREATE OR REPLACE FUNCTION public.ops_ingest_workflow_event(
  p_event_type text,
  p_app_name text,
  p_severity text DEFAULT 'warning',
  p_trip_id uuid DEFAULT NULL,
  p_driver_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_duration_ms int DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_device_model text DEFAULT NULL,
  p_os_version text DEFAULT NULL,
  p_session_id text DEFAULT NULL,
  p_message text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_create_alert boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id uuid;
  v_alert_id uuid;
  v_category text;
  v_app text;
  v_fingerprint text;
  v_title text;
  v_description text;
  v_log_level text;
BEGIN
  v_category := ops_workflow_event_category(p_event_type);
  v_app := COALESCE(NULLIF(p_app_name, ''), ops_workflow_event_app(p_event_type));

  INSERT INTO public.ops_workflow_events (
    event_type, app_name, severity, trip_id, driver_id, customer_id,
    error_code, duration_ms, app_version, platform, device_model, os_version,
    session_id, message, metadata
  ) VALUES (
    p_event_type, v_app, COALESCE(p_severity, 'warning'), p_trip_id, p_driver_id, p_customer_id,
    p_error_code, p_duration_ms, p_app_version, p_platform, p_device_model, p_os_version,
    p_session_id, p_message, p_metadata
  )
  RETURNING id INTO v_event_id;

  v_log_level := CASE
    WHEN p_severity IN ('fatal', 'critical') THEN 'error'
    WHEN p_severity = 'warning' THEN 'warn'
    ELSE 'info'
  END;

  INSERT INTO public.ops_logs (
    level, source, app, message, error_code, trip_id, driver_id,
    duration_ms, metadata, is_synthetic
  ) VALUES (
    v_log_level,
    'ingest-ops-event',
    v_app,
    COALESCE(p_message, p_event_type),
    p_error_code,
    p_trip_id,
    p_driver_id,
    p_duration_ms,
    p_metadata || jsonb_build_object('event_type', p_event_type, 'workflow_event_id', v_event_id),
    false
  );

  IF p_create_alert THEN
    v_fingerprint := p_event_type || ':' || COALESCE(p_trip_id::text, p_driver_id::text, p_customer_id::text, p_session_id, 'global');
    v_title := INITCAP(REPLACE(p_event_type, '_', ' '));
    v_description := COALESCE(
      p_message,
      p_event_type || COALESCE(' — trip ' || p_trip_id::text, '')
    );

    v_alert_id := public.ops_upsert_alert(
      p_fingerprint := v_fingerprint,
      p_category := v_category,
      p_severity := COALESCE(p_severity, 'warning'),
      p_source := 'workflow',
      p_app := v_app,
      p_title := v_title,
      p_description := v_description,
      p_related_trip_id := p_trip_id,
      p_related_driver_id := p_driver_id,
      p_metadata := p_metadata || jsonb_build_object(
        'event_type', p_event_type,
        'error_code', p_error_code,
        'duration_ms', p_duration_ms,
        'app_version', p_app_version,
        'platform', p_platform,
        'device_model', p_device_model,
        'workflow_event_id', v_event_id
      )
    );

    UPDATE public.ops_workflow_events SET alert_id = v_alert_id WHERE id = v_event_id;

    INSERT INTO public.ops_events (
      event_type, category, severity, app, trip_id, driver_id, customer_id,
      description, metadata, alert_id
    ) VALUES (
      p_event_type, v_category, COALESCE(p_severity, 'warning'), v_app,
      p_trip_id, p_driver_id, p_customer_id, v_description,
      p_metadata, v_alert_id
    );
  END IF;

  RETURN v_event_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ops_ingest_workflow_event TO service_role;

-- 4. Backend SQL detectors (Phase 1 taxonomy)
CREATE OR REPLACE FUNCTION public.ops_detect_contradictory_trip_state()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT t.id AS trip_id, t.status, t.dispatch_status, t.driver_id
    FROM public.trips t
    WHERE t.updated_at > now() - interval '24 hours'
      AND (
        (t.status = 'cancelled' AND t.dispatch_status = 'assigned')
        OR (t.status IN ('completed', 'cancelled') AND t.dispatch_status = 'assigned' AND t.driver_id IS NOT NULL)
      )
    LIMIT 30
  LOOP
    PERFORM public.ops_ingest_workflow_event(
      'contradictory_trip_state', 'backend', 'critical',
      rec.trip_id, rec.driver_id, NULL,
      'trip_dispatch_mismatch', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'status=' || rec.status || ' dispatch_status=' || rec.dispatch_status,
      jsonb_build_object('status', rec.status, 'dispatch_status', rec.dispatch_status),
      true
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('contradictory_trip_state', v_count);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('contradictory_trip_state', 0, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_rematch_assignment_failed()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT b.booking_id AS trip_id, b.driver_id, b.detail, b.created_at
    FROM public.booking_delivery_log b
    WHERE b.phase IN ('reassigned', 'reassigned_auto_dispatch', 'rematch_failed', 'negotiation_rematch_failed')
      AND b.created_at > now() - interval '2 hours'
      AND (b.detail->>'success')::text IS DISTINCT FROM 'true'
    LIMIT 30
  LOOP
    PERFORM public.ops_ingest_workflow_event(
      'rematch_assignment_failed', 'backend', 'warning',
      rec.trip_id, rec.driver_id, NULL,
      'rematch_failed', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'Rematch/assignment issue on booking delivery log',
      jsonb_build_object('phase_detail', rec.detail, 'logged_at', rec.created_at),
      true
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('rematch_assignment_failed', v_count);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('rematch_assignment_failed', 0, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_offer_presets_missing()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT ro.id AS offer_id, ro.trip_id, ro.driver_id, ro.created_at
    FROM public.ride_offers ro
    WHERE ro.status = 'pending'
      AND ro.created_at > now() - interval '1 hour'
      AND ro.created_at < now() - interval '30 seconds'
      AND (
        ro.offer_snapshot IS NULL
        OR jsonb_array_length(COALESCE(ro.offer_snapshot->'preset_options', '[]'::jsonb)) < 1
      )
    LIMIT 30
  LOOP
    PERFORM public.ops_ingest_workflow_event(
      'offer_presets_missing', 'backend', 'warning',
      rec.trip_id, rec.driver_id, NULL,
      'presets_missing', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'Ride offer pending without preset chips in snapshot',
      jsonb_build_object('offer_id', rec.offer_id),
      true
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('offer_presets_missing', v_count);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('offer_presets_missing', 0, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_dispatch_timeout_exceeded()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT t.id AS trip_id, t.status, t.dispatch_status, t.updated_at
    FROM public.trips t
    WHERE t.dispatch_status IN ('expired', 'search_timeout')
      AND t.updated_at > now() - interval '2 hours'
    LIMIT 30
  LOOP
    PERFORM public.ops_ingest_workflow_event(
      'dispatch_timeout_exceeded', 'backend', 'warning',
      rec.trip_id, NULL, NULL,
      rec.dispatch_status, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'Dispatch search timed out — dispatch_status=' || rec.dispatch_status,
      jsonb_build_object('status', rec.status, 'dispatch_status', rec.dispatch_status),
      true
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatch_timeout_exceeded', v_count);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('dispatch_timeout_exceeded', 0, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_notification_failures()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT b.booking_id AS trip_id, b.driver_id, count(*) AS fail_count
    FROM public.booking_delivery_log b
    WHERE b.phase = 'push_failed'
      AND b.created_at > now() - interval '1 hour'
    GROUP BY b.booking_id, b.driver_id
    HAVING count(*) >= 1
    LIMIT 30
  LOOP
    PERFORM public.ops_upsert_alert(
      'notification_failure:' || rec.trip_id::text || ':' || COALESCE(rec.driver_id::text, 'none'),
      'dispatch', 'warning', 'detection', 'backend',
      'Driver Notification Failed',
      rec.fail_count || ' push_failed events for trip in last hour',
      rec.trip_id, rec.driver_id, NULL, NULL, NULL, NULL,
      jsonb_build_object('fail_count', rec.fail_count, 'phase', 'push_failed')
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('notification_failures', v_count);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('notification_failures', 0, 'error', SQLERRM);
END;
$$;

-- 5. Workflow event rollup (recent unalerted spikes)
CREATE OR REPLACE FUNCTION public.ops_detect_workflow_event_spikes()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT event_type, app_name, count(*) AS cnt
    FROM public.ops_workflow_events
    WHERE created_at > now() - interval '15 minutes'
      AND severity IN ('warning', 'critical', 'fatal')
    GROUP BY event_type, app_name
    HAVING count(*) >= 3
  LOOP
    PERFORM public.ops_upsert_alert(
      'workflow_spike:' || rec.event_type || ':' || date_trunc('hour', now())::text,
      public.ops_workflow_event_category(rec.event_type),
      CASE WHEN rec.cnt >= 10 THEN 'critical' ELSE 'warning' END,
      'detection', rec.app_name,
      'Workflow spike: ' || rec.event_type,
      rec.cnt || ' events in 15 minutes',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('event_type', rec.event_type, 'count', rec.cnt)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('workflow_spikes', v_count);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('workflow_spikes', 0, 'error', SQLERRM);
END;
$$;

-- 6. Restore full detection orchestrator (53245 + 73051 + perf + Phase 1)
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
  -- Money integrity
  BEGIN SELECT ops_detect_missing_commissions() INTO v_partial;
    v_results := v_results || jsonb_build_object('missing_commissions', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('missing_commissions_error', SQLERRM); END;

  BEGIN SELECT ops_detect_missing_earnings() INTO v_partial;
    v_results := v_results || jsonb_build_object('missing_earnings', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('missing_earnings_error', SQLERRM); END;

  BEGIN SELECT ops_detect_failed_payments() INTO v_partial;
    v_results := v_results || jsonb_build_object('failed_payments', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('failed_payments_error', SQLERRM); END;

  BEGIN SELECT ops_detect_failed_payouts() INTO v_partial;
    v_results := v_results || jsonb_build_object('failed_payouts', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('failed_payouts_error', SQLERRM); END;

  BEGIN SELECT ops_detect_payment_gaps() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('payment_gaps_error', SQLERRM); END;

  BEGIN SELECT ops_detect_commission_gaps()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('commission_gaps_error', SQLERRM); END;

  BEGIN SELECT ops_detect_earning_gaps() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('earning_gaps_error', SQLERRM); END;

  BEGIN SELECT ops_detect_payout_failures() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('payout_failures_error', SQLERRM); END;

  -- Dispatch
  BEGIN SELECT ops_detect_stuck_dispatch() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('stuck_dispatch_error', SQLERRM); END;

  BEGIN SELECT ops_detect_dispatch_timeout_exceeded() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dispatch_timeout_error', SQLERRM); END;

  BEGIN SELECT ops_detect_notification_failures() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('notification_failures_error', SQLERRM); END;

  -- Duplication (53245 + 73051)
  BEGIN SELECT ops_detect_duplicate_payments()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_payments_error', SQLERRM); END;

  BEGIN SELECT ops_detect_duplicate_commissions() INTO v_partial;
    v_results := v_results || jsonb_build_object('duplicate_commissions', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_commissions_error', SQLERRM); END;

  BEGIN SELECT ops_detect_duplicate_bookings() INTO v_partial;
    v_results := v_results || jsonb_build_object('duplicate_bookings', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_bookings_error', SQLERRM); END;

  BEGIN SELECT ops_detect_duplicate_payouts()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_payouts_error', SQLERRM); END;

  BEGIN SELECT ops_detect_duplicate_earnings() INTO v_partial;
    v_results := v_results || jsonb_build_object('duplicate_earnings', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_earnings_error', SQLERRM); END;

  BEGIN SELECT ops_detect_duplicate_dispatches() INTO v_partial;
    v_results := v_results || jsonb_build_object('duplicate_dispatches', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('dup_dispatch_error', SQLERRM); END;

  BEGIN SELECT ops_detect_repeated_webhooks() INTO v_partial;
    v_results := v_results || jsonb_build_object('repeated_webhooks', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('repeated_webhooks_error', SQLERRM); END;

  BEGIN SELECT ops_detect_repeated_guest_submissions() INTO v_partial;
    v_results := v_results || jsonb_build_object('repeated_guest_submissions', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('repeated_guest_error', SQLERRM); END;

  -- Guest booking (53245)
  BEGIN SELECT ops_detect_guest_quote_failures() INTO v_partial;
    v_results := v_results || jsonb_build_object('guest_quote_failures', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('guest_quote_error', SQLERRM); END;

  BEGIN SELECT ops_detect_guest_checkout_failures() INTO v_partial;
    v_results := v_results || jsonb_build_object('guest_checkout_failures', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('guest_checkout_error', SQLERRM); END;

  BEGIN SELECT ops_detect_guest_booking_not_confirmed() INTO v_partial;
    v_results := v_results || jsonb_build_object('guest_booking_not_confirmed', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('guest_not_confirmed_error', SQLERRM); END;

  BEGIN SELECT ops_detect_guest_dropoffs() INTO v_partial;
    v_results := v_results || jsonb_build_object('guest_dropoffs', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('guest_dropoffs_error', SQLERRM); END;

  BEGIN SELECT ops_detect_guest_latency() INTO v_partial;
    v_results := v_results || jsonb_build_object('guest_latency', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('guest_latency_error', SQLERRM); END;

  BEGIN SELECT ops_detect_guest_booking_failures()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('guest_booking_error', SQLERRM); END;

  -- Log-based (53245) — requires ops_logs production writer
  BEGIN SELECT ops_detect_error_spikes() INTO v_partial;
    v_results := v_results || jsonb_build_object('error_spikes', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('error_spikes_error', SQLERRM); END;

  BEGIN SELECT ops_detect_fatal_logs() INTO v_partial;
    v_results := v_results || jsonb_build_object('fatal_logs', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('fatal_logs_error', SQLERRM); END;

  BEGIN SELECT ops_detect_5xx_spikes() INTO v_partial;
    v_results := v_results || jsonb_build_object('5xx_spikes', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('5xx_spikes_error', SQLERRM); END;

  BEGIN SELECT ops_detect_latency_spikes() INTO v_partial;
    v_results := v_results || jsonb_build_object('latency_spikes', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('latency_spikes_error', SQLERRM); END;

  BEGIN SELECT ops_detect_edge_function_failures() INTO v_partial;
    v_results := v_results || jsonb_build_object('edge_function_failures', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('edge_fn_error', SQLERRM); END;

  BEGIN SELECT ops_detect_webhook_failures() INTO v_partial;
    v_results := v_results || jsonb_build_object('webhook_failures', v_partial);
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('webhook_failures_error', SQLERRM); END;

  BEGIN SELECT ops_detect_log_anomalies()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('log_anomalies_error', SQLERRM); END;

  -- App performance
  BEGIN SELECT ops_detect_customer_app_issues()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('customer_app_error', SQLERRM); END;

  BEGIN SELECT ops_detect_driver_app_issues()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('driver_app_error', SQLERRM); END;

  BEGIN SELECT ops_detect_admin_panel_issues()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('admin_panel_error', SQLERRM); END;

  BEGIN SELECT ops_detect_corporate_web_issues()::jsonb INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('corporate_web_error', SQLERRM); END;

  BEGIN SELECT ops_detect_corporate_booking_issues() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('corporate_booking_error', SQLERRM); END;

  BEGIN SELECT ops_detect_slow_screens() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('slow_screens_error', SQLERRM); END;

  BEGIN SELECT ops_detect_money_screen_delays() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('money_delays_error', SQLERRM); END;

  BEGIN SELECT ops_detect_api_latency_spikes() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('api_latency_error', SQLERRM); END;

  BEGIN SELECT ops_detect_version_issues() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('version_issues_error', SQLERRM); END;

  -- Phase 1 backend workflow detectors
  BEGIN SELECT ops_detect_contradictory_trip_state() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('contradictory_state_error', SQLERRM); END;

  BEGIN SELECT ops_detect_rematch_assignment_failed() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('rematch_error', SQLERRM); END;

  BEGIN SELECT ops_detect_offer_presets_missing() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('presets_missing_error', SQLERRM); END;

  BEGIN SELECT ops_detect_workflow_event_spikes() INTO v_partial; v_results := v_results || v_partial;
  EXCEPTION WHEN OTHERS THEN v_results := v_results || jsonb_build_object('workflow_spikes_error', SQLERRM); END;

  RETURN v_results;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM, 'partial_results', v_results);
END;
$$;
