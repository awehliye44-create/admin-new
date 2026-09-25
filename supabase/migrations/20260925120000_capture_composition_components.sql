-- Capture composition persistence (payment_sessions).
-- MK-260925-002: fare+receivable capture must stamp components before provider POST.
-- Rollback: supabase/migrations/rollback/rollback_20260925120000_capture_composition_components.sql

ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS trip_fare_component_pence integer,
  ADD COLUMN IF NOT EXISTS tip_component_pence integer,
  ADD COLUMN IF NOT EXISTS receivable_component_pence integer,
  ADD COLUMN IF NOT EXISTS provider_capture_target_pence integer,
  ADD COLUMN IF NOT EXISTS capture_composition_version text,
  ADD COLUMN IF NOT EXISTS capture_idempotency_key text;

COMMENT ON COLUMN public.payment_sessions.trip_fare_component_pence IS
  'Capture composition: trip fare component stamped before provider capture POST';
COMMENT ON COLUMN public.payment_sessions.tip_component_pence IS
  'Capture composition: successful tip component stamped before provider capture POST';
COMMENT ON COLUMN public.payment_sessions.receivable_component_pence IS
  'Capture composition: RESERVED receivable component; settlement requires this > 0';
COMMENT ON COLUMN public.payment_sessions.provider_capture_target_pence IS
  'Capture composition: fare + tip + receivable target posted to provider';
COMMENT ON COLUMN public.payment_sessions.capture_idempotency_key IS
  'Idempotency key for the exact capture composition total';

CREATE UNIQUE INDEX IF NOT EXISTS payment_sessions_capture_idempotency_key_uidx
  ON public.payment_sessions (capture_idempotency_key)
  WHERE capture_idempotency_key IS NOT NULL;
