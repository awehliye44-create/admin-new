-- P6 M3: weekly payout auto-reconcile.
--
-- claim_reconcile_payout_items previously claimed SUBMITTED EARLY_CASHOUT intents
-- only, so a weekly payout whose Revolut transfer completed (but whose local finalize
-- was missed) waited for manual repair. Weekly kinds now join the claim.
--
-- Safety (unchanged by this migration; enforced in TS, see payoutReconcileKindsSSOT.ts):
--   * Reconcile is GET-only -> idempotent finalize_driver_payout_completion. It never
--     calls /pay and never resends an ambiguous payout.
--   * Provider TERMINAL failure is auto-failed/released ONLY for EARLY_CASHOUT
--     (fail_submitted_early_cashout fails the whole batch and rejects other kinds with
--     NOT_EARLY_CASHOUT). Weekly terminal failure is report-and-leave.
--   * Same claim columns / SKIP LOCKED / double-check UPDATE / service_role-only grant.
--
-- Signature and RETURNS TABLE are unchanged -> CREATE OR REPLACE is in place and
-- keeps existing grants.

CREATE OR REPLACE FUNCTION public.claim_reconcile_payout_items(
  p_claim_token        uuid,
  p_claim_ttl_seconds  integer DEFAULT 90,
  p_min_age_interval   interval DEFAULT '2 minutes',
  p_limit              integer DEFAULT 20
)
RETURNS TABLE (
  intent_id            uuid,
  payout_item_id       uuid,
  driver_id            uuid,
  provider_payment_id  text,
  provider_state       text,
  reconcile_attempt_count integer,
  provider_created_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT
      dppi.id           AS intent_id,
      dppi.payout_item_id,
      dppi.driver_id,
      dppi.provider_payment_id,
      dppi.provider_state,
      dppi.reconcile_attempt_count,
      dppi.provider_created_at
    FROM driver_payout_payment_intents dppi
    -- Cross-check payout_item status
    JOIN payout_items pi ON pi.id = dppi.payout_item_id
      AND pi.status = 'SUBMITTED'
    -- Cross-check batch kind (P6 M3: weekly kinds join EARLY_CASHOUT)
    JOIN payout_batches pb ON pb.id = pi.batch_id
      AND pb.kind IN ('EARLY_CASHOUT', 'WEEKLY_SCHEDULED', 'WEEKLY_MONDAY')
    WHERE dppi.execution_status = 'SUBMITTED'
      AND dppi.financially_applied_at IS NULL
      AND dppi.provider_payment_id IS NOT NULL
      AND dppi.provider_created_at < v_now - p_min_age_interval
      AND (dppi.next_reconcile_at IS NULL OR dppi.next_reconcile_at <= v_now)
      -- Reclaim only allowed after previous claim has expired
      AND (dppi.reconcile_claim_expires_at IS NULL OR dppi.reconcile_claim_expires_at <= v_now)
    ORDER BY dppi.provider_created_at ASC
    LIMIT p_limit
    -- Acquire row-level locks; skip rows locked by concurrent transactions
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE driver_payout_payment_intents dppi
    SET
      reconcile_claim_token      = p_claim_token,
      reconcile_claimed_at       = v_now,
      reconcile_claim_expires_at = v_now + (p_claim_ttl_seconds || ' seconds')::interval,
      updated_at                 = v_now
    FROM candidates c
    WHERE dppi.id = c.intent_id
      -- Double-check in UPDATE: still unclaimed (eliminates any race between
      -- the SELECT and UPDATE within the same statement).
      AND (dppi.reconcile_claim_expires_at IS NULL OR dppi.reconcile_claim_expires_at <= v_now)
      AND dppi.financially_applied_at IS NULL
    RETURNING dppi.id AS intent_id
  )
  SELECT
    c.intent_id,
    c.payout_item_id,
    c.driver_id,
    c.provider_payment_id,
    c.provider_state,
    c.reconcile_attempt_count,
    c.provider_created_at
  FROM candidates c
  -- Only return rows that were actually claimed in this call
  JOIN claimed cl ON cl.intent_id = c.intent_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_reconcile_payout_items(uuid, integer, interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_reconcile_payout_items(uuid, integer, interval, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reconcile_payout_items(uuid, integer, interval, integer) TO service_role;

COMMENT ON FUNCTION public.claim_reconcile_payout_items IS
  'Atomically claim SUBMITTED payout intents (EARLY_CASHOUT, WEEKLY_SCHEDULED, WEEKLY_MONDAY) '
  'for GET-only reconciliation. FOR UPDATE SKIP LOCKED + double-check UPDATE prevents concurrent '
  'pollers from processing the same item. SECURITY DEFINER, service_role only.';
