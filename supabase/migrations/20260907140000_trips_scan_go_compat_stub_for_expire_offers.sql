-- P0: expire-offers edge still SELECTs trips.scan_go after column drop.
--
-- Live evidence (2026-07-30 trip MK-260730-001):
--   trip inserted (searching), SQL dispatch wave-1 inserted 0 ride_offers
--   payment_sessions stayed status=trip_created (auto-dispatch post-commit never marked dispatching)
--   expire-offers cron ran every ~15s with trips_rebroadcast=0 the entire search window
--   REST proof: GET trips?select=...,scan_go,... → 42703 column trips.scan_go does not exist
--   Deployed expire-offers selects scan_go and skips stale-trip rebroadcast on tripsError
--
-- Root cause class: same as 20260907130000 — leftover scan_go references after
-- 20260903121500 dropped public.trips.scan_go.
--
-- This migration restores a NOT NULL DEFAULT false compat stub so undeployed
-- expire-offers can scan searching trips with no pending offers and invoke
-- auto-dispatch. Always false; drop after expire-offers edge redeploy removes
-- the column from its SELECT / trip.scan_go branch.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS scan_go boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.trips.scan_go IS
  'Compat stub for undeployed expire-offers edge still selecting scan_go after 20260903121500. Always false. Drop after expire-offers redeploy.';
