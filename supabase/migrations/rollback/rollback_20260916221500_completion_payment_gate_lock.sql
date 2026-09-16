-- Rollback 20260916221500_completion_payment_gate_lock
BEGIN;
DROP FUNCTION IF EXISTS public.assert_trip_completion_customer_payment_gate(uuid);
COMMIT;
