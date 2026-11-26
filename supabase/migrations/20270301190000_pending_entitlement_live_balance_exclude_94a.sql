-- #93C / #94A — Exclude TRIP_EARNING_PENDING / RELEASE from SQL live wallet balance.
-- Parity with TS BALANCE_EXCLUDED / WALLET_BALANCE_EXCLUDED (#98).
-- PENDING is Today-visible entitlement, never withdrawable liability.
-- No historical backfill. Stage D / clearing / payout policy unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.driver_wallet_live_balance_pence(p_driver_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount_pence), 0)::bigint
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND type NOT IN (
      'PLATFORM_COMMISSION',
      'CASH_TRIP_EARNING',
      'PAYOUT_RESERVATION_HOLD',
      'PAYOUT_RESERVATION_RELEASE',
      -- #98 / #94A: pending entitlement must never inflate live / reserve / Available cap.
      'TRIP_EARNING_PENDING',
      'TRIP_EARNING_PENDING_RELEASE'
    );
$$;

COMMENT ON FUNCTION public.driver_wallet_live_balance_pence(uuid) IS
  'Driver live wallet liability from DWL. Excludes platform commission, cash accounting, '
  'payout reservation audit rows, and #98 TRIP_EARNING_PENDING / PENDING_RELEASE.';

COMMIT;
