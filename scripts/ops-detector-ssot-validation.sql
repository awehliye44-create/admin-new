-- Ops detector SSOT alignment — validation queries (read-only)
-- Run before and after applying 20260827120000_ops_detector_ssot_alignment.sql

-- =============================================================================
-- A. Alert inventory
-- =============================================================================

SELECT 'open_alerts_total' AS metric, count(*)::bigint AS value
FROM ops_alerts WHERE status IN ('open', 'acknowledged')
UNION ALL
SELECT 'open_demo', count(*) FROM ops_alerts
WHERE status IN ('open', 'acknowledged') AND fingerprint LIKE 'demo:%'
UNION ALL
SELECT 'open_real', count(*) FROM ops_alerts
WHERE status IN ('open', 'acknowledged') AND fingerprint NOT LIKE 'demo:%'
UNION ALL
SELECT 'open_backend_spike', count(*) FROM ops_alerts
WHERE status IN ('open', 'acknowledged')
  AND (title ILIKE '%Spike%' OR title ILIKE '%Edge Function%' OR title ILIKE '%Webhook Fail%')
UNION ALL
SELECT 'open_earning', count(*) FROM ops_alerts
WHERE status IN ('open', 'acknowledged') AND category = 'earning'
UNION ALL
SELECT 'open_commission', count(*) FROM ops_alerts
WHERE status IN ('open', 'acknowledged') AND category = 'commission'
UNION ALL
SELECT 'synthetic_logs', count(*) FROM ops_logs WHERE is_synthetic = true;

-- =============================================================================
-- B. MK-260625-001 Financial Reconciliation proof (must pass before resolve)
-- =============================================================================

SELECT
  t.id AS trip_id,
  t.trip_code,
  t.status,
  t.payment_method,
  t.completed_at,
  p.status AS payment_status,
  p.captured_amount_pence,
  p.commission_amount_pence,
  p.driver_amount_pence,
  dwl.type AS ledger_type,
  dwl.amount_pence AS ledger_amount_pence,
  dwl.created_at AS ledger_created_at
FROM trips t
LEFT JOIN payments p ON p.trip_id = t.id
LEFT JOIN driver_wallet_ledger dwl ON dwl.related_trip_id = t.id AND dwl.type = 'TRIP_EARNING_NET'
WHERE t.id = 'c9aeea66-f511-47f9-97aa-15eda198a876';

-- Expected: status=completed, payment_status=captured, ledger_type=TRIP_EARNING_NET, amount=408

-- =============================================================================
-- C. SSOT missing-earnings scan (wallet ledger, last 24h) — expect 0 rows
-- =============================================================================

SELECT t.id AS trip_id, t.trip_code, t.payment_method, t.completed_at
FROM trips t
WHERE t.status = 'completed'
  AND t.completed_at > now() - interval '24 hours'
  AND t.driver_id IS NOT NULL
  AND COALESCE(t.gross_fare_pence, t.final_fare_pence, 0) > 0
  AND (
    (UPPER(COALESCE(t.payment_method, '')) = 'CASH' AND NOT EXISTS (
      SELECT 1 FROM driver_wallet_ledger dwl
      WHERE dwl.related_trip_id = t.id
        AND dwl.type IN ('CASH_COMMISSION_DEBT', 'CASH_TRIP_EARNING')
    ))
    OR
    (UPPER(COALESCE(t.payment_method, '')) <> 'CASH' AND NOT EXISTS (
      SELECT 1 FROM driver_wallet_ledger dwl
      WHERE dwl.related_trip_id = t.id AND dwl.type = 'TRIP_EARNING_NET'
    ))
  );

-- =============================================================================
-- D. SSOT missing-commission scan (payments + wallet, last 24h) — expect 0 rows
-- =============================================================================

SELECT t.id AS trip_id, t.trip_code, t.payment_method, t.completed_at
FROM trips t
WHERE t.status = 'completed'
  AND t.completed_at > now() - interval '24 hours'
  AND COALESCE(t.gross_fare_pence, t.final_fare_pence, 0) > 0
  AND NOT (
    (
      UPPER(COALESCE(t.payment_method, '')) = 'CASH'
      AND EXISTS (
        SELECT 1 FROM driver_wallet_ledger dwl
        WHERE dwl.related_trip_id = t.id
          AND dwl.type IN ('CASH_COMMISSION_DEBT', 'PLATFORM_COMMISSION', 'COMPANY_COMMISSION')
          AND dwl.amount_pence <> 0
      )
    )
    OR
    (
      UPPER(COALESCE(t.payment_method, '')) <> 'CASH'
      AND EXISTS (
        SELECT 1 FROM payments p
        WHERE p.trip_id = t.id
          AND p.status IN ('captured', 'succeeded')
          AND COALESCE(p.commission_amount_pence, 0) > 0
      )
    )
  );

-- =============================================================================
-- E. Synthetic log contamination check — expect 0 rows after migration
-- =============================================================================

SELECT source, level, count(*) AS cnt
FROM ops_logs
WHERE is_synthetic = true
GROUP BY source, level
ORDER BY cnt DESC;

-- =============================================================================
-- F. Spike detector dry-run (non-synthetic only) — expect 0 groups above threshold
-- =============================================================================

SELECT 'error_spike' AS detector, source, app, count(*) AS cnt
FROM ops_logs
WHERE level IN ('error', 'fatal')
  AND created_at > now() - interval '15 minutes'
  AND is_synthetic = false
GROUP BY source, app
HAVING count(*) >= 5
UNION ALL
SELECT '5xx_spike', source, app, count(*)
FROM ops_logs
WHERE http_status >= 500
  AND created_at > now() - interval '10 minutes'
  AND is_synthetic = false
GROUP BY source, app
HAVING count(*) >= 3
UNION ALL
SELECT 'latency_spike', source, app, count(*)
FROM ops_logs
WHERE duration_ms > 5000
  AND created_at > now() - interval '15 minutes'
  AND is_synthetic = false
GROUP BY source, app
HAVING count(*) >= 3;

-- =============================================================================
-- G. Alerts that migration will resolve (projection, read-only)
-- =============================================================================

SELECT id, title, category, fingerprint, related_trip_id
FROM ops_alerts
WHERE status IN ('open', 'acknowledged')
  AND (
    fingerprint LIKE 'demo:%'
    OR (
      related_trip_id IS NULL
      AND (
        fingerprint LIKE 'error_spike:%'
        OR fingerprint LIKE '5xx_spike:%'
        OR fingerprint LIKE 'latency_spike:%'
        OR fingerprint LIKE 'edge_fn_failure:%'
        OR fingerprint LIKE 'webhook_failure:%'
        OR fingerprint LIKE 'fatal_log:%'
      )
    )
    OR (
      related_trip_id = 'c9aeea66-f511-47f9-97aa-15eda198a876'
      AND category IN ('earning', 'commission')
    )
  )
ORDER BY category, title;

-- =============================================================================
-- H. Post-migration: re-run detectors (safe — should not recreate phantom alerts)
-- =============================================================================

-- SELECT ops_run_all_detections();

-- Then re-run sections A, E, F and confirm open_backend_spike = 0.
