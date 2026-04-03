
-- 1. Expand the check constraint to support all needed types
ALTER TABLE driver_wallet_ledger DROP CONSTRAINT driver_wallet_ledger_type_check;
ALTER TABLE driver_wallet_ledger ADD CONSTRAINT driver_wallet_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET', 'CASH_TRIP_EARNING', 'CASH_COMMISSION_DEBT',
    'DRIVER_TIP_CREDIT', 'TIP_CREDIT', 'PLATFORM_COMMISSION', 'COMPANY_COMMISSION',
    'WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'CASHOUT_FEE',
    'ADJUSTMENT', 'REFUND_DEBIT', 'PAYOUT', 'MANUAL_PAYOUT',
    'BONUS', 'DEBT_RECOVERY'
  ]));

-- 2. Backfill from driver_ledger → driver_wallet_ledger
--    Map COMPANY_COMMISSION → PLATFORM_COMMISSION since they're equivalent
INSERT INTO driver_wallet_ledger (driver_id, type, amount_pence, currency, related_trip_id, description, created_at)
SELECT
  dl.driver_id,
  CASE WHEN dl.entry_type = 'COMPANY_COMMISSION' THEN 'PLATFORM_COMMISSION' ELSE dl.entry_type END,
  dl.amount_pence,
  dl.currency_code,
  dl.trip_id,
  dl.description,
  dl.created_at
FROM driver_ledger dl
WHERE dl.trip_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1
  FROM driver_wallet_ledger dwl
  WHERE dwl.driver_id = dl.driver_id
    AND dwl.related_trip_id = dl.trip_id
    AND dwl.type = CASE WHEN dl.entry_type = 'COMPANY_COMMISSION' THEN 'PLATFORM_COMMISSION' ELSE dl.entry_type END
);

-- Also backfill non-trip entries (adjustments, payouts, etc.)
INSERT INTO driver_wallet_ledger (driver_id, type, amount_pence, currency, related_trip_id, description, created_at)
SELECT
  dl.driver_id,
  dl.entry_type,
  dl.amount_pence,
  dl.currency_code,
  NULL,
  dl.description,
  dl.created_at
FROM driver_ledger dl
WHERE dl.trip_id IS NULL
AND NOT EXISTS (
  SELECT 1
  FROM driver_wallet_ledger dwl2
  WHERE dwl2.driver_id = dl.driver_id
    AND dwl2.type = dl.entry_type
    AND dwl2.amount_pence = dl.amount_pence
    AND dwl2.related_trip_id IS NULL
    AND ABS(EXTRACT(EPOCH FROM (dwl2.created_at - dl.created_at))) < 60
);

-- 3. Force-recalculate all driver wallets
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT driver_id FROM driver_wallet_ledger LOOP
    PERFORM public.recalculate_driver_wallet(r.driver_id);
  END LOOP;
END;
$$;

-- 4. Mark driver_ledger as deprecated
COMMENT ON TABLE driver_ledger IS 'DEPRECATED — Do NOT read or write. Use driver_wallet_ledger exclusively. Kept for historical reference only.';
