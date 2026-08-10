WITH captured AS (
  SELECT ps.trip_id,
         SUM(GREATEST(COALESCE(ps.captured_amount_pence,0),0)) - SUM(GREATEST(COALESCE(ps.refunded_amount_pence,0),0)) AS paid_pence
  FROM public.payment_sessions ps
  WHERE ps.trip_id IS NOT NULL
    AND COALESCE(ps.captured_amount_pence,0) > 0
    AND (lower(ps.status::text) IN ('captured','paid','succeeded','recovery_completed')
         OR lower(COALESCE(ps.provider_state,'')) IN ('completed','captured'))
  GROUP BY ps.trip_id
)
UPDATE public.trips t
SET capture_amount_pence = c.paid_pence,
    outstanding_balance_pence = 0,
    payment_status = 'captured',
    payment_coverage_status = 'captured',
    updated_at = now()
FROM captured c
WHERE t.id = c.trip_id
  AND t.status = 'completed'
  AND c.paid_pence >= COALESCE(t.final_customer_fare_pence, t.final_fare_pence, t.estimated_total_pence, 0)
  AND COALESCE(t.final_customer_fare_pence, t.final_fare_pence, t.estimated_total_pence, 0) > 0
  AND (COALESCE(t.capture_amount_pence,0) <> c.paid_pence OR t.payment_status IS DISTINCT FROM 'captured');