-- Rollback capture composition columns / trigger on payment_sessions.
-- SAFE before any plan has been used in production (nullable empty columns).
-- AFTER live financial evidence exists: do NOT apply this rollback — it would
-- erase capture composition evidence. Prefer forward-fix only; retain columns.
-- Operational boundary: if any payment_sessions.capture_idempotency_key IS NOT NULL
-- in production, abort rollback and keep columns.

DROP TRIGGER IF EXISTS trg_payment_sessions_capture_composition_immutable
  ON public.payment_sessions;
DROP FUNCTION IF EXISTS public.payment_sessions_capture_composition_immutable();

ALTER TABLE public.payment_sessions
  DROP CONSTRAINT IF EXISTS payment_sessions_capture_composition_populated_chk;

DROP INDEX IF EXISTS public.payment_sessions_capture_idempotency_key_uidx;

ALTER TABLE public.payment_sessions
  DROP COLUMN IF EXISTS trip_fare_component_pence,
  DROP COLUMN IF EXISTS tip_component_pence,
  DROP COLUMN IF EXISTS receivable_component_pence,
  DROP COLUMN IF EXISTS provider_capture_target_pence,
  DROP COLUMN IF EXISTS capture_composition_version,
  DROP COLUMN IF EXISTS capture_idempotency_key,
  DROP COLUMN IF EXISTS capture_composition_frozen_at;
