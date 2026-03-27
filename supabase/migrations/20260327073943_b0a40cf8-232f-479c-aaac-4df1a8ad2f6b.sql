-- Sync trip commission_pence with the authoritative driver_wallet_ledger entries.

UPDATE trips t
SET 
  commission_pence = ABS(wl.amount_pence),
  driver_net_pence = t.gross_fare_pence - ABS(wl.amount_pence),
  updated_at = now()
FROM driver_wallet_ledger wl
WHERE wl.related_trip_id = t.id 
  AND wl.type = 'CASH_COMMISSION_DEBT'
  AND t.commission_pence != ABS(wl.amount_pence);

-- Sync driver_ledger entries to match the wallet ledger
UPDATE driver_ledger dl
SET 
  amount_pence = wl.amount_pence,
  description = REPLACE(dl.description, '(repaired)', '(synced with wallet ledger)')
FROM driver_wallet_ledger wl
WHERE wl.related_trip_id = dl.trip_id
  AND wl.type = 'CASH_COMMISSION_DEBT'
  AND dl.entry_type = 'CASH_COMMISSION_DEBT'
  AND dl.amount_pence != wl.amount_pence;

-- Sync trip_finance records
UPDATE trip_finance tf
SET 
  platform_commission_pence = ABS(wl.amount_pence),
  driver_net_before_tip_pence = t.gross_fare_pence - ABS(wl.amount_pence),
  driver_total_earnings_pence = t.gross_fare_pence - ABS(wl.amount_pence)
FROM driver_wallet_ledger wl
JOIN trips t ON t.id = wl.related_trip_id
WHERE wl.related_trip_id = tf.trip_id
  AND wl.type = 'CASH_COMMISSION_DEBT'
  AND tf.platform_commission_pence != ABS(wl.amount_pence);