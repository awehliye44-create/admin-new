-- Migration: add durable claim columns to driver_payout_payment_intents
-- Required before deploying reconcile-submitted-driver-withdrawals Edge function.
-- Claim columns allow the poller to atomically mark rows in-flight so concurrent
-- poller invocations cannot both process the same payout item.

ALTER TABLE driver_payout_payment_intents
  ADD COLUMN IF NOT EXISTS reconcile_claim_token       uuid,
  ADD COLUMN IF NOT EXISTS reconcile_claimed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS reconcile_claim_expires_at  timestamptz,
  ADD COLUMN IF NOT EXISTS reconcile_attempt_count     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_reconcile_at           timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconcile_at           timestamptz,
  ADD COLUMN IF NOT EXISTS last_reconcile_provider_state text,
  ADD COLUMN IF NOT EXISTS last_reconcile_error        text;

-- Index for efficient candidate selection by the poller.
CREATE INDEX IF NOT EXISTS idx_dppi_poller_candidates
  ON driver_payout_payment_intents (next_reconcile_at, reconcile_claim_expires_at)
  WHERE financially_applied_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: claim_reconcile_payout_items
--
-- Atomically marks up to p_limit SUBMITTED EARLY_CASHOUT payment intents as
-- in-flight for the calling poller run, returning only the rows it claimed.
-- Uses UPDATE … WHERE … RETURNING to guarantee exactly-once claim.
--
-- Eligibility criteria:
--   1. execution_status = 'SUBMITTED'
--   2. financially_applied_at IS NULL
--   3. provider_payment_id IS NOT NULL
--   4. provider_created_at < now() - p_min_age_interval  (e.g. '2 minutes')
--   5. (next_reconcile_at IS NULL OR next_reconcile_at <= now())
--   6. (reconcile_claim_expires_at IS NULL OR reconcile_claim_expires_at <= now())
--      → allows reclaim only after the previous claim's TTL has elapsed
--
-- The function also cross-checks that the payout_item is SUBMITTED EARLY_CASHOUT.
-- Returns the claimed intents; the Edge function processes only those rows.
-- ─────────────────────────────────────────────────────────────────────────────
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
    -- Cross-check batch kind
    JOIN payout_batches pb ON pb.id = pi.batch_id
      AND pb.kind = 'EARLY_CASHOUT'
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

-- Revoke public access; only service_role (Edge function) may call this.
-- Supabase auto-grants to anon/authenticated on CREATE, so revoke explicitly.
REVOKE ALL ON FUNCTION public.claim_reconcile_payout_items(uuid, integer, interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_reconcile_payout_items(uuid, integer, interval, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reconcile_payout_items(uuid, integer, interval, integer) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: update_reconcile_attempt_meta
--
-- Non-financial update after each reconcile attempt.
-- Only updates meta columns; cannot touch financial columns.
-- Guard: only updates the row if reconcile_claim_token matches (the calling
-- poller owns this claim) and financially_applied_at IS NULL.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_reconcile_attempt_meta(
  p_intent_id                    uuid,
  p_claim_token                  uuid,
  p_attempt_count                integer,
  p_provider_state               text,
  p_error                        text,
  p_next_reconcile_at            timestamptz,
  p_financially_applied          boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated bigint;
BEGIN
  UPDATE driver_payout_payment_intents
  SET
    reconcile_attempt_count      = p_attempt_count,
    last_reconcile_at            = now(),
    last_reconcile_provider_state = p_provider_state,
    last_reconcile_error         = p_error,
    -- Clear the claim when done (completed, failed, or giving up); keep for pending retry
    reconcile_claim_token        = CASE WHEN p_financially_applied THEN NULL ELSE reconcile_claim_token END,
    reconcile_claimed_at         = CASE WHEN p_financially_applied THEN NULL ELSE reconcile_claimed_at END,
    reconcile_claim_expires_at   = CASE WHEN p_financially_applied THEN NULL ELSE reconcile_claim_expires_at END,
    next_reconcile_at            = CASE WHEN p_financially_applied THEN NULL ELSE p_next_reconcile_at END,
    updated_at                   = now()
  WHERE id = p_intent_id
    AND reconcile_claim_token = p_claim_token
    AND financially_applied_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.update_reconcile_attempt_meta(uuid, uuid, integer, text, text, timestamptz, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_reconcile_attempt_meta(uuid, uuid, integer, text, text, timestamptz, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_reconcile_attempt_meta(uuid, uuid, integer, text, text, timestamptz, boolean) TO service_role;

COMMENT ON FUNCTION public.claim_reconcile_payout_items IS
  'Atomically claim SUBMITTED EARLY_CASHOUT payment intents for reconciliation. '
  'FOR UPDATE SKIP LOCKED + double-check in UPDATE prevents concurrent pollers from '
  'processing the same item. Only claimed rows are returned. SECURITY DEFINER, '
  'accessible to service_role only.';

COMMENT ON FUNCTION public.update_reconcile_attempt_meta IS
  'Update non-financial reconcile tracking columns. Token match guard ensures '
  'only the poller that holds the claim can update. SECURITY DEFINER, service_role only.';
