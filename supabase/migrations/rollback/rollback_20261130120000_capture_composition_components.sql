-- Rollback capture composition columns / trigger on payment_sessions.
-- SAFE before any plan has been used in production (nullable empty columns).
-- AFTER live financial evidence exists: do NOT apply this rollback — it would
-- erase capture composition evidence. Prefer forward-fix only; retain columns.
-- Operational boundary: if any payment_sessions.capture_idempotency_key IS NOT NULL
-- OR capture_composition_frozen_at IS NOT NULL, abort rollback and keep columns.

DO $guard$
DECLARE
  v_used bigint;
BEGIN
  SELECT count(*) INTO v_used
  FROM public.payment_sessions
  WHERE capture_idempotency_key IS NOT NULL
     OR capture_composition_frozen_at IS NOT NULL
     OR provider_capture_target_pence IS NOT NULL;
  IF coalesce(v_used, 0) > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_REFUSED_LIVE_CAPTURE_COMPOSITION_EVIDENCE: % session(s) have frozen/used plan columns — refuse erase',
      v_used
      USING ERRCODE = 'check_violation';
  END IF;
END;
$guard$;

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
