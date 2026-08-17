-- One TRIP_EARNING_NET row per trip. No amount backfill. No new financial columns.
-- Preflight: duplicate related_trip_id for TRIP_EARNING_NET must be 0.

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_trip_earning_net_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'TRIP_EARNING_NET' AND related_trip_id IS NOT NULL;
