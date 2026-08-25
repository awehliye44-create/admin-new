-- Step 8.3 read-only production integrity (no mutations)

-- 1) RIDE_BOOKING session cardinality per PLATFORM_COLLECTED completed trip
SELECT 'booking_session_cardinality' AS check_name,
  count(*) FILTER (WHERE booking_cnt = 0) AS zero_booking,
  count(*) FILTER (WHERE booking_cnt = 1) AS exactly_one,
  count(*) FILTER (WHERE booking_cnt > 1) AS ambiguous
FROM (
  SELECT t.id,
    (SELECT count(*) FROM payment_sessions ps
     WHERE ps.trip_id = t.id AND ps.purpose = 'RIDE_BOOKING') AS booking_cnt
  FROM trips t
  WHERE t.financial_model::text = 'PLATFORM_COLLECTED'
    AND lower(t.status) = 'completed'
) x;

SELECT 'ambiguous_booking_trips' AS check_name, id AS trip_id, booking_cnt
FROM (
  SELECT t.id,
    (SELECT count(*) FROM payment_sessions ps
     WHERE ps.trip_id = t.id AND ps.purpose = 'RIDE_BOOKING') AS booking_cnt
  FROM trips t
  WHERE t.financial_model::text = 'PLATFORM_COLLECTED'
    AND lower(t.status) = 'completed'
) y WHERE booking_cnt > 1
ORDER BY id LIMIT 20;

-- 2) Captured trips without canonical PS capture
SELECT 'captured_trip_missing_ps_capture' AS check_name, count(*) AS cnt
FROM trips t
JOIN payment_sessions ps ON ps.trip_id = t.id AND ps.purpose = 'RIDE_BOOKING'
WHERE lower(t.status) = 'completed'
  AND t.financial_model::text = 'PLATFORM_COLLECTED'
  AND lower(coalesce(t.payment_status,'')) = 'captured'
  AND (ps.captured_amount_pence IS NULL OR ps.status::text <> 'captured');

SELECT 'captured_trip_missing_ps_capture_ids' AS check_name, t.id AS trip_id, ps.id AS payment_session_id
FROM trips t
JOIN payment_sessions ps ON ps.trip_id = t.id AND ps.purpose = 'RIDE_BOOKING'
WHERE lower(t.status) = 'completed'
  AND t.financial_model::text = 'PLATFORM_COLLECTED'
  AND lower(coalesce(t.payment_status,'')) = 'captured'
  AND (ps.captured_amount_pence IS NULL OR ps.status::text <> 'captured')
ORDER BY t.completed_at DESC NULLS LAST LIMIT 20;

-- 3) TEN without canonical capture / duplicate TEN
SELECT 'ten_without_capture' AS check_name, count(DISTINCT dwl.related_trip_id) AS cnt
FROM driver_wallet_ledger dwl
LEFT JOIN payment_sessions ps ON ps.trip_id = dwl.related_trip_id AND ps.purpose = 'RIDE_BOOKING'
  AND ps.captured_amount_pence IS NOT NULL AND ps.status::text = 'captured'
WHERE dwl.type = 'TRIP_EARNING_NET'
  AND ps.id IS NULL;

SELECT 'duplicate_ten' AS check_name, related_trip_id AS trip_id, count(*) AS cnt
FROM driver_wallet_ledger
WHERE type = 'TRIP_EARNING_NET' AND related_trip_id IS NOT NULL
GROUP BY related_trip_id HAVING count(*) > 1
ORDER BY cnt DESC LIMIT 20;

SELECT 'capture_without_ten' AS check_name, count(*) AS cnt
FROM payment_sessions ps
JOIN trips t ON t.id = ps.trip_id
WHERE ps.purpose = 'RIDE_BOOKING'
  AND ps.captured_amount_pence IS NOT NULL
  AND ps.status::text = 'captured'
  AND lower(t.status) = 'completed'
  AND t.financial_model::text = 'PLATFORM_COLLECTED'
  AND NOT EXISTS (
    SELECT 1 FROM driver_wallet_ledger dwl
    WHERE dwl.related_trip_id = ps.trip_id AND dwl.type = 'TRIP_EARNING_NET'
  );

-- 4) REFUND_DEBIT lineage
SELECT 'refund_debit_null_lineage' AS check_name, count(*) AS cnt,
  count(*) FILTER (WHERE created_at >= '2026-08-19'::timestamptz) AS post_b1_cnt
FROM driver_wallet_ledger
WHERE type = 'REFUND_DEBIT'
  AND (provider_refund_id IS NULL OR btrim(provider_refund_id) = '');

SELECT 'duplicate_refund_lineage' AS check_name, provider_refund_id, count(*) AS cnt
FROM driver_wallet_ledger
WHERE type = 'REFUND_DEBIT' AND provider_refund_id IS NOT NULL
GROUP BY provider_refund_id HAVING count(*) > 1
ORDER BY cnt DESC LIMIT 20;

-- 5) Financial reconciliation repairs
SELECT 'financial_ssot_repairs' AS check_name, count(*) AS cnt FROM financial_ssot_repairs;
SELECT 'financial_ssot_mismatches' AS check_name, count(*) AS cnt,
  count(*) FILTER (WHERE status = 'OPEN') AS open_cnt
FROM financial_ssot_mismatches;

-- 6) Payout integrity
SELECT 'completed_payout_unapplied' AS check_name, count(*) AS cnt
FROM payout_items pi
WHERE lower(coalesce(pi.status,'')) = 'completed'
  AND NOT EXISTS (
    SELECT 1 FROM payout_item_ledger_allocations a
    JOIN driver_wallet_ledger dwl ON dwl.id = a.ledger_entry_id
    WHERE a.payout_item_id = pi.id
      AND dwl.type IN ('PAYOUT_DEBIT','EARLY_CASHOUT_NET_DEBIT')
  );

SELECT 'submitted_payout_stale' AS check_name, count(*) AS cnt
FROM payout_items pi
WHERE lower(coalesce(pi.status,'')) IN ('submitted','processing','provider_pending')
  AND pi.updated_at < now() - interval '2 hours';

SELECT 'active_reservation_terminal_payout' AS check_name, count(*) AS cnt
FROM driver_payout_reservations r
JOIN payout_items pi ON pi.id = r.payout_item_id
WHERE r.released_at IS NULL
  AND lower(coalesce(pi.status,'')) IN ('completed','failed','cancelled');

SELECT 'duplicate_payout_net_debits' AS check_name, a.payout_item_id, count(*) AS cnt
FROM payout_item_ledger_allocations a
JOIN driver_wallet_ledger dwl ON dwl.id = a.ledger_entry_id
WHERE dwl.type IN ('PAYOUT_DEBIT','EARLY_CASHOUT_NET_DEBIT')
GROUP BY a.payout_item_id HAVING count(*) > 1
ORDER BY cnt DESC LIMIT 20;

SELECT 'reused_provider_payment_id' AS check_name, provider_payment_id, count(*) AS cnt
FROM driver_payout_payment_intents
WHERE provider_payment_id IS NOT NULL AND btrim(provider_payment_id) <> ''
GROUP BY provider_payment_id HAVING count(*) > 1
ORDER BY cnt DESC LIMIT 20;

-- 7) Cross-model contamination
SELECT 'platform_ten_on_driver_collected' AS check_name, count(*) AS cnt
FROM driver_wallet_ledger dwl
JOIN trips t ON t.id = dwl.related_trip_id
WHERE dwl.type = 'TRIP_EARNING_NET'
  AND t.financial_model::text = 'DRIVER_COLLECTED_COMMISSION_WALLET';

SELECT 'commission_wallet_platform_ten' AS check_name, count(*) AS cnt
FROM driver_commission_wallet_ledger
WHERE type ILIKE '%TRIP_EARNING%' OR type ILIKE '%TEN%';
