-- Capture composition persistence + invariants (payment_sessions).
-- MK-260925-002 / PR #80 blockers 1–4.
-- Rollback: supabase/migrations/rollback/rollback_20260925120000_capture_composition_components.sql
--
-- Historical rows remain nullable (no invented components).
-- A populated plan must satisfy component sum + non-negative integer pence.
-- Frozen plans are immutable after capture_composition_frozen_at is set
-- (or financial_operation_state is CAPTURING/CAPTURED with a key present).

ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS trip_fare_component_pence integer,
  ADD COLUMN IF NOT EXISTS tip_component_pence integer,
  ADD COLUMN IF NOT EXISTS receivable_component_pence integer,
  ADD COLUMN IF NOT EXISTS provider_capture_target_pence integer,
  ADD COLUMN IF NOT EXISTS capture_composition_version text,
  ADD COLUMN IF NOT EXISTS capture_idempotency_key text,
  ADD COLUMN IF NOT EXISTS capture_composition_frozen_at timestamptz;

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
COMMENT ON COLUMN public.payment_sessions.capture_composition_frozen_at IS
  'When set, composition columns are immutable (freeze/resume)';

-- Populated plan: all required fields together, non-negative, exact sum.
ALTER TABLE public.payment_sessions
  DROP CONSTRAINT IF EXISTS payment_sessions_capture_composition_populated_chk;

ALTER TABLE public.payment_sessions
  ADD CONSTRAINT payment_sessions_capture_composition_populated_chk
  CHECK (
    (
      provider_capture_target_pence IS NULL
      AND trip_fare_component_pence IS NULL
      AND tip_component_pence IS NULL
      AND receivable_component_pence IS NULL
      AND capture_idempotency_key IS NULL
      AND capture_composition_version IS NULL
      AND capture_composition_frozen_at IS NULL
    )
    OR (
      provider_capture_target_pence IS NOT NULL
      AND trip_fare_component_pence IS NOT NULL
      AND tip_component_pence IS NOT NULL
      AND receivable_component_pence IS NOT NULL
      AND capture_idempotency_key IS NOT NULL
      AND capture_composition_version IS NOT NULL
      AND trip_fare_component_pence >= 0
      AND tip_component_pence >= 0
      AND receivable_component_pence >= 0
      AND provider_capture_target_pence >= 0
      AND provider_capture_target_pence =
        trip_fare_component_pence + tip_component_pence + receivable_component_pence
      AND (
        COALESCE(total_authorised_amount_pence, authorised_amount_pence) IS NULL
        OR provider_capture_target_pence
          <= COALESCE(total_authorised_amount_pence, authorised_amount_pence)
      )
    )
  );

-- One frozen plan identity per session (columns live on the session row).
-- Unique idempotency key across sessions when present.
CREATE UNIQUE INDEX IF NOT EXISTS payment_sessions_capture_idempotency_key_uidx
  ON public.payment_sessions (capture_idempotency_key)
  WHERE capture_idempotency_key IS NOT NULL;

-- Immutable frozen composition (service_role Edge only writes before freeze).
CREATE OR REPLACE FUNCTION public.payment_sessions_capture_composition_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Allow initial population (NULL → values).
  IF OLD.capture_composition_frozen_at IS NULL
     AND OLD.capture_idempotency_key IS NULL THEN
    RETURN NEW;
  END IF;

  -- Once frozen or key present under CAPTURING/CAPTURED, reject component/key changes.
  IF OLD.capture_composition_frozen_at IS NOT NULL
     OR (
       OLD.capture_idempotency_key IS NOT NULL
       AND UPPER(COALESCE(OLD.financial_operation_state, '')) IN ('CAPTURING', 'CAPTURED', 'RECONCILING')
     ) THEN
    IF NEW.trip_fare_component_pence IS DISTINCT FROM OLD.trip_fare_component_pence
       OR NEW.tip_component_pence IS DISTINCT FROM OLD.tip_component_pence
       OR NEW.receivable_component_pence IS DISTINCT FROM OLD.receivable_component_pence
       OR NEW.provider_capture_target_pence IS DISTINCT FROM OLD.provider_capture_target_pence
       OR NEW.capture_idempotency_key IS DISTINCT FROM OLD.capture_idempotency_key
       OR NEW.capture_composition_version IS DISTINCT FROM OLD.capture_composition_version
       OR (
         OLD.capture_composition_frozen_at IS NOT NULL
         AND NEW.capture_composition_frozen_at IS DISTINCT FROM OLD.capture_composition_frozen_at
       ) THEN
      RAISE EXCEPTION 'CAPTURE_COMPOSITION_FROZEN_IMMUTABLE'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_sessions_capture_composition_immutable
  ON public.payment_sessions;

CREATE TRIGGER trg_payment_sessions_capture_composition_immutable
  BEFORE UPDATE ON public.payment_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.payment_sessions_capture_composition_immutable();

REVOKE ALL ON FUNCTION public.payment_sessions_capture_composition_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_sessions_capture_composition_immutable() FROM anon, authenticated;
-- Trigger functions execute as table owner; no EXECUTE grant to clients required.

-- Existing table policy (service role manages payment_sessions) protects new columns.
-- Prove: anon/authenticated cannot UPDATE payment_sessions financial columns via RLS.
-- No redundant policies added here.
