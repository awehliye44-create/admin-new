-- ============================================================
-- DRAFT / REVIEW ONLY — DO NOT APPLY
-- Historical backfill preview: MK-260923-012 (30p) + MK-260923-017 (6p)
-- Same customer; definitive declined waiting; no later recovery;
-- no existing receivables; expected prepared total 36p.
--
-- Requires customer_receivables SSOT migration applied first.
-- Uses customer_receivable_record_declined_increment for GUC + idempotency.
-- ============================================================

-- Preview identity (read-only checks — run before any insert):
-- SELECT trip_code, passenger_id, final_fare_pence, capture_amount_pence,
--        pickup_waiting_charge_pence, outstanding_balance_pence
-- FROM public.trips
-- WHERE trip_code IN ('MK-260923-012', 'MK-260923-017');
--
-- Expected:
--   MK-260923-012 → shortfall 30p (579 − 549)
--   MK-260923-017 → shortfall 6p  (506 − 500)
--   same passenger_id
--   no rows in customer_receivables for these trips

BEGIN;

-- Guard: abort if receivables already exist for these trip codes.
DO $$
DECLARE
  v_existing integer;
BEGIN
  SELECT count(*) INTO v_existing
  FROM public.customer_receivables r
  JOIN public.trips t ON t.id = r.source_trip_id
  WHERE t.trip_code IN ('MK-260923-012', 'MK-260923-017');
  IF v_existing > 0 THEN
    RAISE EXCEPTION 'backfill_aborted_receivables_already_exist count=%', v_existing;
  END IF;
END $$;

-- MK-260923-012 → 30p
SELECT public.customer_receivable_record_declined_increment(
  t.passenger_id,
  t.id,
  NULL,
  NULL,
  'DECLINED_INCREMENTAL_AUTHORISATION',
  'PICKUP_WAITING_DECLINED',
  30,
  lower(coalesce(t.currency_code, 'gbp')),
  'receivable:trip:' || t.id::text || ':declined_waiting_v1',
  jsonb_build_object(
    'trip_code', t.trip_code,
    'final_fare_pence', t.final_fare_pence,
    'captured_pence', t.capture_amount_pence,
    'shortfall_pence', 30,
    'backfill_preview', true,
    'ten_repair_forbidden', true,
    'standalone_revolut_charge_forbidden', true
  )
)
FROM public.trips t
WHERE t.trip_code = 'MK-260923-012'
  AND t.passenger_id IS NOT NULL
  AND coalesce(t.final_fare_pence, 0) - coalesce(t.capture_amount_pence, 0) = 30;

-- MK-260923-017 → 6p
SELECT public.customer_receivable_record_declined_increment(
  t.passenger_id,
  t.id,
  NULL,
  NULL,
  'DECLINED_INCREMENTAL_AUTHORISATION',
  'PICKUP_WAITING_DECLINED',
  6,
  lower(coalesce(t.currency_code, 'gbp')),
  'receivable:trip:' || t.id::text || ':declined_waiting_v1',
  jsonb_build_object(
    'trip_code', t.trip_code,
    'final_fare_pence', t.final_fare_pence,
    'captured_pence', t.capture_amount_pence,
    'shortfall_pence', 6,
    'backfill_preview', true,
    'ten_repair_forbidden', true,
    'standalone_revolut_charge_forbidden', true
  )
)
FROM public.trips t
WHERE t.trip_code = 'MK-260923-017'
  AND t.passenger_id IS NOT NULL
  AND coalesce(t.final_fare_pence, 0) - coalesce(t.capture_amount_pence, 0) = 6;

-- Verify prepared total 36p for the customer of MK-012
-- SELECT customer_id, sum(outstanding_amount_pence) AS total_pence, count(*) AS trips
-- FROM public.customer_receivables
-- WHERE status = 'OPEN'
--   AND source_trip_id IN (
--     SELECT id FROM public.trips WHERE trip_code IN ('MK-260923-012','MK-260923-017')
--   )
-- GROUP BY customer_id;
-- Expected: total_pence = 36, trips = 2

ROLLBACK; -- preview transaction — never commit in this draft
