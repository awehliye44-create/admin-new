-- OPTIONAL rollback: drop payment-first INSERT trigger from 20270201120200.
-- DANGER: re-enables unpaid platform-collected card trip inserts if any legacy
-- pending_payment client is still live. Only run after hub/Admin card paths are
-- known CTAP/payment-first only, or during a controlled emergency with card
-- booking paused.
-- Instant booking payment gate (enforce_digital_payment_gate) is NOT touched.

BEGIN;

DROP TRIGGER IF EXISTS trg_trips_enforce_payment_first_platform_card ON public.trips;
DROP FUNCTION IF EXISTS public.trips_enforce_payment_first_platform_card();

COMMIT;
