-- P0: Same-order Revolut incremental authorisation + financial operation lock
-- Additive only. DO NOT apply without explicit approval (never blanket db push).
--
-- Closes:
-- 1) unique (payment_provider, provider_order_id) blocking multiple increment rows
-- 2) missing increment audit columns / target-total uniqueness
-- 3) missing Payment Session financial operation lock columns

BEGIN;

-- ---------------------------------------------------------------------------
-- payment_sessions: financial operation lock (compare-and-set)
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS financial_operation_state text,
  ADD COLUMN IF NOT EXISTS financial_operation_owner text,
  ADD COLUMN IF NOT EXISTS financial_operation_started_at timestamptz;

COMMENT ON COLUMN public.payment_sessions.financial_operation_state IS
  'IDLE | INCREMENTING | CAPTURING | RECONCILING | RECOVERY_PENDING | CAPTURED';

ALTER TABLE public.payment_sessions
  DROP CONSTRAINT IF EXISTS payment_sessions_financial_operation_state_chk;

ALTER TABLE public.payment_sessions
  ADD CONSTRAINT payment_sessions_financial_operation_state_chk
  CHECK (
    financial_operation_state IS NULL
    OR financial_operation_state = ANY (ARRAY[
      'IDLE'::text,
      'INCREMENTING'::text,
      'CAPTURING'::text,
      'RECONCILING'::text,
      'RECOVERY_PENDING'::text,
      'CAPTURED'::text
    ])
  );

-- ---------------------------------------------------------------------------
-- payment_session_authorisations: allow same-order increment history
-- ---------------------------------------------------------------------------
-- Old uniqueness assumed one row per provider order — blocks same-order increments.
-- Remote may own this as a UNIQUE CONSTRAINT (not a free-standing index).
ALTER TABLE public.payment_session_authorisations
  DROP CONSTRAINT IF EXISTS payment_session_authorisations_provider_order_unique;
DROP INDEX IF EXISTS public.payment_session_authorisations_provider_order_unique;

ALTER TABLE public.payment_session_authorisations
  ADD COLUMN IF NOT EXISTS sequence_number integer,
  ADD COLUMN IF NOT EXISTS previous_authorised_total_pence integer,
  ADD COLUMN IF NOT EXISTS requested_increment_pence integer,
  ADD COLUMN IF NOT EXISTS requested_target_total_pence integer,
  ADD COLUMN IF NOT EXISTS provider_confirmed_total_pence integer,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_classification text,
  ADD COLUMN IF NOT EXISTS provider_operation_reference text;

-- One confirmed/pending logical increment per session+order+target total
CREATE UNIQUE INDEX IF NOT EXISTS payment_session_authorisations_increment_target_uidx
  ON public.payment_session_authorisations (
    payment_session_id,
    provider_order_id,
    requested_target_total_pence
  )
  WHERE requested_target_total_pence IS NOT NULL
    AND status IS DISTINCT FROM 'superseded';

CREATE INDEX IF NOT EXISTS payment_session_authorisations_order_seq_idx
  ON public.payment_session_authorisations (
    payment_session_id,
    provider_order_id,
    sequence_number
  );

-- Invariants (soft — only when amounts present)
ALTER TABLE public.payment_sessions
  DROP CONSTRAINT IF EXISTS payment_sessions_authorised_totals_chk;

ALTER TABLE public.payment_sessions
  ADD CONSTRAINT payment_sessions_authorised_totals_chk
  CHECK (
    total_authorised_amount_pence IS NULL
    OR authorised_amount_pence IS NULL
    OR total_authorised_amount_pence >= authorised_amount_pence
  );

ALTER TABLE public.payment_sessions
  DROP CONSTRAINT IF EXISTS payment_sessions_captured_lte_authorised_chk;

ALTER TABLE public.payment_sessions
  ADD CONSTRAINT payment_sessions_captured_lte_authorised_chk
  CHECK (
    captured_amount_pence IS NULL
    OR total_authorised_amount_pence IS NULL
    OR captured_amount_pence <= total_authorised_amount_pence
  );

-- ---------------------------------------------------------------------------
-- Webhook event dedup (provider event id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_name text,
  provider_order_id text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_webhook_events_provider_event_uidx
  ON public.payment_webhook_events (provider, provider_event_id);

COMMIT;
