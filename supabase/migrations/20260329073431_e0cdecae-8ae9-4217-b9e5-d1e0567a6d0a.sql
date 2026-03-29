-- Backfill 5 completed cash trips missing from driver_ledger
-- These trips have commission_pence and gross_fare_pence but no ledger entries

INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description)
SELECT 
  t.driver_id,
  t.id,
  'CASH_COMMISSION_DEBT',
  -t.commission_pence,
  COALESCE(t.currency_code, 'inr'),
  'Cash trip commission – backfill'
FROM trips t
WHERE t.status = 'completed'
  AND t.id NOT IN (SELECT DISTINCT trip_id FROM driver_ledger WHERE trip_id IS NOT NULL)
  AND t.commission_pence IS NOT NULL
  AND t.commission_pence > 0
ON CONFLICT DO NOTHING;

INSERT INTO driver_ledger (driver_id, trip_id, entry_type, amount_pence, currency_code, description)
SELECT 
  t.driver_id,
  t.id,
  'COMPANY_COMMISSION',
  t.commission_pence,
  COALESCE(t.currency_code, 'inr'),
  'Platform commission – backfill'
FROM trips t
WHERE t.status = 'completed'
  AND t.id NOT IN (SELECT DISTINCT trip_id FROM driver_ledger WHERE trip_id IS NOT NULL AND entry_type = 'COMPANY_COMMISSION')
  AND t.commission_pence IS NOT NULL
  AND t.commission_pence > 0
ON CONFLICT DO NOTHING;