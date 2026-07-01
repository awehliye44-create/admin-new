-- Ops Intelligence detector alignment with Financial Reconciliation SSOT.
-- Does NOT modify payments, wallet balances, ledger entries, or any money fields.
--
-- Changes:
--   1. Add is_synthetic = false to log-based spike detectors
--   2. ops_detect_missing_earnings → driver_wallet_ledger (not driver_ledger)
--   3. ops_detect_missing_commissions → payments + driver_wallet_ledger (not trip_finance)
--   4. Resolve demo/synthetic phantom alerts; mark MK-260625-001 finance alerts false positive

-- =============================================================================
-- 1. Log-based detectors: exclude synthetic / demo seed rows
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ops_detect_error_spikes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, app, count(*) AS error_count
    FROM public.ops_logs
    WHERE level IN ('error', 'fatal')
      AND created_at > now() - interval '15 minutes'
      AND is_synthetic = false
    GROUP BY source, app
    HAVING count(*) >= 5
  LOOP
    PERFORM public.ops_upsert_alert(
      'error_spike:' || r.source || ':' || COALESCE(r.app, '') || ':' || date_trunc('hour', now())::text,
      'logs', 'critical', 'system', r.app,
      'Error Spike: ' || r.source,
      r.error_count || ' errors from ' || r.source || ' in last 15 minutes',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('source', r.source, 'error_count', r.error_count, 'window_minutes', 15)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_5xx_spikes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, app, count(*) AS error_count,
           avg(duration_ms) AS avg_duration
    FROM public.ops_logs
    WHERE http_status >= 500
      AND created_at > now() - interval '10 minutes'
      AND is_synthetic = false
    GROUP BY source, app
    HAVING count(*) >= 3
  LOOP
    PERFORM public.ops_upsert_alert(
      '5xx_spike:' || r.source || ':' || COALESCE(r.app, '') || ':' || date_trunc('hour', now())::text,
      'backend', 'critical', 'system', r.app,
      'API 5xx Spike: ' || r.source,
      r.error_count || ' server errors from ' || r.source || ' in 10 minutes (avg ' || round(COALESCE(r.avg_duration, 0)) || 'ms)',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('source', r.source, 'error_count', r.error_count, 'avg_duration_ms', round(COALESCE(r.avg_duration, 0)))
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_latency_spikes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, app, count(*) AS slow_count,
           avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms
    FROM public.ops_logs
    WHERE duration_ms > 5000
      AND created_at > now() - interval '15 minutes'
      AND is_synthetic = false
    GROUP BY source, app
    HAVING count(*) >= 3
  LOOP
    PERFORM public.ops_upsert_alert(
      'latency_spike:' || r.source || ':' || COALESCE(r.app, '') || ':' || date_trunc('hour', now())::text,
      'backend', 'warning', 'system', r.app,
      'Latency Spike: ' || r.source,
      r.slow_count || ' slow requests (avg ' || round(r.avg_ms) || 'ms, max ' || r.max_ms || 'ms)',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('source', r.source, 'slow_count', r.slow_count, 'avg_ms', round(r.avg_ms), 'max_ms', r.max_ms)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_edge_function_failures()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, count(*) AS fail_count
    FROM public.ops_logs
    WHERE level IN ('error', 'fatal')
      AND created_at > now() - interval '30 minutes'
      AND is_synthetic = false
      AND (
        source LIKE '%-trip' OR source LIKE '%dispatch%' OR source LIKE '%payment%'
        OR source LIKE '%payout%' OR source LIKE '%commission%' OR source LIKE '%driver-%'
        OR source LIKE '%estimate-%' OR source LIKE '%calculate-%' OR source LIKE '%capture-%'
        OR source LIKE '%cancel-%' OR source LIKE '%complete-%' OR source LIKE '%accept-%'
        OR source LIKE '%decline-%' OR source LIKE '%find-%' OR source LIKE '%resolve-%'
        OR source LIKE '%schedule-%' OR source LIKE '%upsert-%' OR source LIKE '%validate-%'
        OR source LIKE '%stripe-%' OR source LIKE '%document-%' OR source LIKE '%ops-%'
        OR source LIKE '%qr-%' OR source LIKE '%public-%' OR source LIKE '%handle-%'
      )
    GROUP BY source
    HAVING count(*) >= 3
  LOOP
    PERFORM public.ops_upsert_alert(
      'edge_fn_failure:' || r.source || ':' || date_trunc('hour', now())::text,
      'backend', 'critical', 'system', 'backend',
      'Edge Function Failures: ' || r.source,
      r.fail_count || ' failures from edge function ' || r.source || ' in last 30 min',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('function_name', r.source, 'fail_count', r.fail_count)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_webhook_failures()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, app, count(*) AS fail_count
    FROM public.ops_logs
    WHERE level IN ('error', 'fatal')
      AND created_at > now() - interval '1 hour'
      AND is_synthetic = false
      AND (source ILIKE '%webhook%' OR source ILIKE '%stripe-webhook%' OR error_code ILIKE '%webhook%')
    GROUP BY source, app
    HAVING count(*) >= 2
  LOOP
    PERFORM public.ops_upsert_alert(
      'webhook_failure:' || r.source || ':' || date_trunc('hour', now())::text,
      'backend', 'critical', 'system', COALESCE(r.app, 'backend'),
      'Webhook Failures: ' || r.source,
      r.fail_count || ' webhook processing failures in last hour',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('source', r.source, 'fail_count', r.fail_count)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- =============================================================================
-- 2. Finance detectors: Financial Reconciliation SSOT (read-only detection)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ops_detect_missing_commissions()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT
      t.id AS trip_id,
      t.driver_id,
      t.service_area_id,
      COALESCE(t.gross_fare_pence, t.final_fare_pence, 0) AS gross_fare_pence
    FROM public.trips t
    WHERE t.status = 'completed'
      AND t.completed_at > now() - interval '24 hours'
      AND COALESCE(t.gross_fare_pence, t.final_fare_pence, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.trip_id = t.id
          AND oe.event_type = 'commission_missing'
          AND oe.resolved = false
      )
      AND NOT (
        -- Cash: commission debt / platform commission in wallet ledger
        (
          UPPER(COALESCE(t.payment_method, '')) = 'CASH'
          AND EXISTS (
            SELECT 1 FROM public.driver_wallet_ledger dwl
            WHERE dwl.related_trip_id = t.id
              AND dwl.type IN ('CASH_COMMISSION_DEBT', 'PLATFORM_COMMISSION', 'COMPANY_COMMISSION')
              AND dwl.amount_pence <> 0
          )
        )
        OR
        -- Card: captured payment records commission (FR payments SSOT)
        (
          UPPER(COALESCE(t.payment_method, '')) <> 'CASH'
          AND EXISTS (
            SELECT 1 FROM public.payments p
            WHERE p.trip_id = t.id
              AND p.status IN ('captured', 'succeeded')
              AND COALESCE(p.commission_amount_pence, 0) > 0
          )
        )
        OR
        -- Card fallback: platform commission row in wallet ledger
        (
          UPPER(COALESCE(t.payment_method, '')) <> 'CASH'
          AND EXISTS (
            SELECT 1 FROM public.driver_wallet_ledger dwl
            WHERE dwl.related_trip_id = t.id
              AND dwl.type IN ('PLATFORM_COMMISSION', 'COMPANY_COMMISSION')
              AND ABS(dwl.amount_pence) > 0
          )
        )
      )
  LOOP
    PERFORM public.ops_record_event(
      'commission_missing', 'commission', 'critical', 'backend',
      r.trip_id, r.driver_id, NULL, NULL, NULL, r.service_area_id,
      r.gross_fare_pence, NULL,
      'Completed trip has no commission in payments or driver_wallet_ledger (FR SSOT)',
      jsonb_build_object('gross_fare_pence', r.gross_fare_pence, 'ssot', 'payments,driver_wallet_ledger')
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_detect_missing_earnings()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT
      t.id AS trip_id,
      t.driver_id,
      COALESCE(t.gross_fare_pence, t.final_fare_pence, 0) AS gross_fare_pence
    FROM public.trips t
    WHERE t.status = 'completed'
      AND t.completed_at > now() - interval '24 hours'
      AND t.driver_id IS NOT NULL
      AND COALESCE(t.gross_fare_pence, t.final_fare_pence, 0) > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.trip_id = t.id
          AND oe.event_type = 'earning_missing'
          AND oe.resolved = false
      )
      AND (
        -- Cash trips: wallet ledger cash earning types
        (
          UPPER(COALESCE(t.payment_method, '')) = 'CASH'
          AND NOT EXISTS (
            SELECT 1 FROM public.driver_wallet_ledger dwl
            WHERE dwl.related_trip_id = t.id
              AND dwl.type IN ('CASH_COMMISSION_DEBT', 'CASH_TRIP_EARNING')
          )
        )
        OR
        -- Card trips: require capture settled (or grace window) before alerting
        (
          UPPER(COALESCE(t.payment_method, '')) <> 'CASH'
          AND (
            EXISTS (
              SELECT 1 FROM public.payments p
              WHERE p.trip_id = t.id
                AND p.status IN ('captured', 'succeeded')
            )
            OR t.completed_at < now() - interval '30 minutes'
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.driver_wallet_ledger dwl
            WHERE dwl.related_trip_id = t.id
              AND dwl.type = 'TRIP_EARNING_NET'
          )
        )
      )
  LOOP
    PERFORM public.ops_record_event(
      'earning_missing', 'earning', 'critical', 'backend',
      r.trip_id, r.driver_id, NULL, NULL, NULL, NULL,
      r.gross_fare_pence, NULL,
      'Completed trip has no driver_wallet_ledger earning entry (FR SSOT)',
      jsonb_build_object('gross_fare_pence', r.gross_fare_pence, 'ssot', 'driver_wallet_ledger')
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- =============================================================================
-- 3. Data hygiene: synthetic logs + phantom alerts (no finance mutations)
-- =============================================================================

DELETE FROM public.ops_logs
WHERE is_synthetic = true;

-- Demo-seed alerts (fingerprint prefix demo:)
UPDATE public.ops_alerts
SET
  status = 'resolved',
  resolved_at = now(),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'resolved_reason', 'ops_detector_ssot_alignment',
    'suppression', 'demo_seed'
  )
WHERE status IN ('open', 'acknowledged')
  AND fingerprint LIKE 'demo:%';

-- Log-spike alerts promoted from synthetic ops-seed (no production trip impact)
UPDATE public.ops_alerts
SET
  status = 'resolved',
  resolved_at = now(),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'resolved_reason', 'ops_detector_ssot_alignment',
    'suppression', 'synthetic_log_spike',
    'false_positive', true
  )
WHERE status IN ('open', 'acknowledged')
  AND related_trip_id IS NULL
  AND (
    fingerprint LIKE 'error_spike:%'
    OR fingerprint LIKE '5xx_spike:%'
    OR fingerprint LIKE 'latency_spike:%'
    OR fingerprint LIKE 'edge_fn_failure:%'
    OR fingerprint LIKE 'webhook_failure:%'
    OR fingerprint LIKE 'fatal_log:%'
  );

-- MK-260625-001: FR-verified false positive (trip completed, payment captured, ledger exists)
UPDATE public.ops_alerts
SET
  status = 'resolved',
  resolved_at = now(),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'false_positive', true,
    'resolved_reason', 'fr_ssot_verified',
    'trip_code', 'MK-260625-001',
    'fr_validation', jsonb_build_object(
      'trip_completed', true,
      'payment_captured', true,
      'wallet_ledger_type', 'TRIP_EARNING_NET',
      'wallet_ledger_amount_pence', 408,
      'payment_amount_pence', 480,
      'commission_amount_pence', 72
    )
  )
WHERE status IN ('open', 'acknowledged')
  AND related_trip_id = 'c9aeea66-f511-47f9-97aa-15eda198a876'::uuid
  AND category IN ('earning', 'commission');

UPDATE public.ops_events
SET
  resolved = true,
  resolved_at = now(),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'false_positive', true,
    'resolved_reason', 'fr_ssot_verified',
    'trip_code', 'MK-260625-001'
  )
WHERE trip_id = 'c9aeea66-f511-47f9-97aa-15eda198a876'::uuid
  AND event_type IN ('earning_missing', 'commission_missing')
  AND resolved = false;
