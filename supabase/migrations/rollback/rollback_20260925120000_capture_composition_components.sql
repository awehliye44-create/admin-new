-- Rollback capture composition columns on payment_sessions.
DROP INDEX IF EXISTS public.payment_sessions_capture_idempotency_key_uidx;
ALTER TABLE public.payment_sessions
  DROP COLUMN IF EXISTS trip_fare_component_pence,
  DROP COLUMN IF EXISTS tip_component_pence,
  DROP COLUMN IF EXISTS receivable_component_pence,
  DROP COLUMN IF EXISTS provider_capture_target_pence,
  DROP COLUMN IF EXISTS capture_composition_version,
  DROP COLUMN IF EXISTS capture_idempotency_key;
