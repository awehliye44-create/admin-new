-- Rollback for 20261216240000_finished_trip_money_column_guard.sql
-- The guard adds a trigger and two functions only; no data or policies change.

BEGIN;

DROP TRIGGER IF EXISTS aa_guard_finished_trip_money_columns ON public.trips;
DROP FUNCTION IF EXISTS public.guard_finished_trip_money_columns();
DROP FUNCTION IF EXISTS public.finished_trip_locked_money_columns();

COMMIT;
