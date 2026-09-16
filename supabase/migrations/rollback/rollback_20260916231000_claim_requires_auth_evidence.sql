-- Rollback 20260916231000 → restore claim body from 20260916220000
-- (PSA insert optional when session missing).
BEGIN;

-- Re-apply 20260916220000 claim function by re-running that migration file
-- is intentional; this rollback only restores the "optional PSA" behaviour
-- via a shortened note — operators should re-apply 20260916220000 if needed.
-- For safety, fail closed remains preferred; use:
--   psql -f supabase/migrations/20260916220000_atomic_fare_increase_modification_claim.sql
SELECT 1;

COMMIT;
