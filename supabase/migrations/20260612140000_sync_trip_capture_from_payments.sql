-- Sync trips.capture_amount_pence from authoritative payments.captured_amount_pence
-- where they diverge (fixes Financial Reconciliation customer revenue vs trip fields).

UPDATE trips t
SET
  capture_amount_pence = p.captured_amount_pence,
  updated_at = now()
FROM (
  SELECT DISTINCT ON (trip_id)
    trip_id,
    captured_amount_pence
  FROM payments
  WHERE trip_id IS NOT NULL
    AND status IN ('captured', 'paid', 'succeeded')
    AND captured_amount_pence IS NOT NULL
    AND captured_amount_pence > 0
  ORDER BY trip_id, created_at DESC
) p
WHERE t.id = p.trip_id
  AND COALESCE(t.capture_amount_pence, 0) <> p.captured_amount_pence;
