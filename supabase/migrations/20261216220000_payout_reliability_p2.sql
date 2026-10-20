-- HISTORY PARITY ONLY. Already applied on linked production.
-- Restored so local migration list matches remote. Do not re-apply via db push.
-- Payout reliability (P2).
--
-- 1. driver_payout_funding_attempt_snapshots: one append-only row per /pay
--    attempt recording the provider balance read, the running allowance before
--    and after this item, and the amount. Written after the submission claim and
--    before the relay call; the executor never calls /pay without it. Rows can
--    never be updated, deleted or truncated.
-- 2. payout_provider_reversal_checks: read-only provider re-checks of completed
--    payouts. A detected reversal / failure is flagged (and audited in
--    payout_audit_log) for manual review only; no ledger, reservation or item is
--    touched. A flag, once set, can never be cleared or changed.
--
-- Service role only: RLS on, no policies, no anon/authenticated grants.
--
-- Rollback: supabase/migrations/rollback/rollback_20261216220000_payout_reliability_p2.sql

BEGIN;

CREATE TABLE public.driver_payout_funding_attempt_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES public.driver_payout_payment_intents(id),
  payout_item_id uuid NOT NULL REFERENCES public.payout_items(id),
  driver_id uuid NOT NULL,
  claim_token uuid NOT NULL,
  run_id uuid,
  schedule_occurrence_key text,
  source_account_id text NOT NULL,
  balance_read_at timestamptz NOT NULL,
  provider_available_pence integer NOT NULL CHECK (provider_available_pence >= 0),
  remaining_before_pence integer NOT NULL CHECK (remaining_before_pence >= 0),
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  remaining_after_pence integer NOT NULL CHECK (remaining_after_pence >= 0),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_payout_funding_attempt_snapshots_attempt_key UNIQUE (intent_id, claim_token),
  CONSTRAINT driver_payout_funding_attempt_snapshots_drawdown_chk
    CHECK (remaining_after_pence = remaining_before_pence - amount_pence),
  CONSTRAINT driver_payout_funding_attempt_snapshots_within_balance_chk
    CHECK (remaining_before_pence <= provider_available_pence)
);

CREATE INDEX driver_payout_funding_attempt_snapshots_item_idx
  ON public.driver_payout_funding_attempt_snapshots (payout_item_id, created_at DESC);
CREATE INDEX driver_payout_funding_attempt_snapshots_run_idx
  ON public.driver_payout_funding_attempt_snapshots (run_id);

CREATE OR REPLACE FUNCTION public.reject_funding_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'FUNDING_SNAPSHOT_IMMUTABLE: driver_payout_funding_attempt_snapshots is append-only (%)', TG_OP
    USING ERRCODE = 'P0001';
END;
$function$;

CREATE TRIGGER driver_payout_funding_attempt_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.driver_payout_funding_attempt_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.reject_funding_snapshot_mutation();

CREATE TRIGGER driver_payout_funding_attempt_snapshots_no_truncate
  BEFORE TRUNCATE ON public.driver_payout_funding_attempt_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_funding_snapshot_mutation();

ALTER TABLE public.driver_payout_funding_attempt_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_payout_funding_attempt_snapshots FROM anon, authenticated;

CREATE TABLE public.payout_provider_reversal_checks (
  payout_item_id uuid PRIMARY KEY REFERENCES public.payout_items(id),
  driver_id uuid,
  provider_payment_id text NOT NULL,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_provider_state text,
  check_count integer NOT NULL DEFAULT 1 CHECK (check_count >= 1),
  reversal_state text CHECK (reversal_state IN ('REVERSED', 'FAILED')),
  reversal_detected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_provider_reversal_checks_detected_chk
    CHECK ((reversal_state IS NULL) = (reversal_detected_at IS NULL))
);

CREATE INDEX payout_provider_reversal_checks_flagged_idx
  ON public.payout_provider_reversal_checks (reversal_detected_at)
  WHERE reversal_state IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_payout_reversal_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.reversal_state IS NOT NULL THEN
      RAISE EXCEPTION 'REVERSAL_FLAG_IMMUTABLE: flagged reversal check cannot be deleted'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.reversal_state IS NOT NULL
     AND (NEW.reversal_state IS DISTINCT FROM OLD.reversal_state
          OR NEW.reversal_detected_at IS DISTINCT FROM OLD.reversal_detected_at) THEN
    RAISE EXCEPTION 'REVERSAL_FLAG_IMMUTABLE: reversal flag cannot be cleared or changed'
      USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER payout_provider_reversal_checks_guard
  BEFORE UPDATE OR DELETE ON public.payout_provider_reversal_checks
  FOR EACH ROW EXECUTE FUNCTION public.guard_payout_reversal_flag();

ALTER TABLE public.payout_provider_reversal_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payout_provider_reversal_checks FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.reject_funding_snapshot_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_payout_reversal_flag() FROM PUBLIC, anon, authenticated;

COMMIT;
