-- ============================================================
-- Migration: 20260930140000_fix_payout_rls_recursion.sql
-- Purpose  : Break mutual RLS recursion between payout_items
--            and payout_batches that prevents authenticated
--            drivers from reading their own withdrawal history.
--
-- Root cause (audited 2026-08-19):
--   payout_items driver SELECT policy
--     → JOINs payout_batches (b.kind='EARLY_CASHOUT')
--   payout_batches driver SELECT policy
--     → EXISTS(payout_items i JOIN drivers d)
--   PostgreSQL RLS evaluates both at query time → infinite recursion.
--
-- Fix strategy:
--   1. DROP the two recursive driver SELECT policies entirely.
--   2. Do NOT replace them with any broad driver table policy.
--      Direct authenticated access to payout_items / payout_batches
--      is removed for the driver role. Admin and service_role keep
--      their existing policies unchanged.
--   3. Create two narrow SECURITY DEFINER RPCs as the exclusive
--      driver withdrawal read interface:
--        public.get_driver_own_withdrawals(p_filter)
--        public.get_driver_own_withdrawal(p_withdrawal_id)
--      Both:
--        - return EARLY_CASHOUT items only (never WEEKLY_*)
--        - derive driver identity from auth.uid() internally
--        - use search_path = pg_catalog (no implicit schema lookup)
--        - schema-qualify every object accessed
--        - expose only safe UI fields (no provider keys/secrets)
--        - reject invalid p_filter values with RAISE EXCEPTION
--        - contain no dynamic SQL and no DML
--        - are granted EXECUTE to authenticated only
--        - explicitly REVOKE from PUBLIC and anon
--
-- Admin policies (has_role / public INSERT/UPDATE): unchanged.
-- service_role ALL bypass: unchanged.
-- payout_item_ledger_allocations: unchanged (Admin-only).
-- driver_payout_payment_intents: unchanged (service_role ALL).
-- driver_payout_reservations: unchanged.
-- INSERT/UPDATE/DELETE on payout_items/payout_batches: unchanged.
-- ============================================================

-- ── 1. Drop both recursive driver SELECT policies ─────────────────────────

DROP POLICY IF EXISTS "Drivers read own early cashout payout items"
  ON public.payout_items;

DROP POLICY IF EXISTS "Drivers read own early cashout payout batches"
  ON public.payout_batches;

-- No replacement table policy is created for authenticated drivers.
-- Direct driver reads of payout_items / payout_batches are now blocked.
-- Access is exclusively through the SECURITY DEFINER RPCs below.

-- ── 2. RPC: list driver's own EARLY_CASHOUT withdrawal items ─────────────
-- search_path = pg_catalog prevents implicit object resolution.
-- All objects accessed are schema-qualified explicitly.
-- p_filter validates against a fixed allow-list; unknown values raise.
-- No dynamic SQL. No DML.

CREATE OR REPLACE FUNCTION public.get_driver_own_withdrawals(
  p_filter text DEFAULT NULL
)
RETURNS TABLE (
  id                      uuid,
  status                  text,
  amount_pence            integer,
  net_driver_payout_pence bigint,
  onecab_fee_pence        bigint,
  created_at              timestamptz,
  completed_at            timestamptz,
  failed_at               timestamptz,
  failure_reason          text,
  failure_code            text,
  error_message           text,
  batch_kind              text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  -- Validate p_filter against fixed allow-list — no dynamic SQL possible.
  IF p_filter IS NOT NULL AND p_filter NOT IN ('pending', 'completed', 'failed') THEN
    RAISE EXCEPTION 'get_driver_own_withdrawals: invalid filter value %', p_filter
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Derive driver identity from JWT — caller cannot supply it.
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RETURN;  -- unauthenticated or unrecognised — return empty, not an error
  END IF;

  RETURN QUERY
  SELECT
    pi.id,
    pi.status::text,
    pi.amount_pence,
    pi.net_driver_payout_pence,
    pi.onecab_fee_pence,
    pi.created_at,
    pi.completed_at,
    pi.failed_at,
    pi.failure_reason::text,
    pi.failure_code::text,
    pi.error_message::text,
    pb.kind::text AS batch_kind
  FROM public.payout_items  pi
  JOIN public.payout_batches pb ON pb.id = pi.batch_id
  WHERE pi.driver_id = v_driver_id
    -- Hardcoded: only EARLY_CASHOUT is exposed to the driver UI.
    AND pb.kind = 'EARLY_CASHOUT'
    AND (
      p_filter IS NULL
      OR (p_filter = 'pending'
          AND pi.status IN ('VALIDATED','RESERVING','RESERVED',
                            'SUBMITTING','SUBMITTED','UNKNOWN'))
      OR (p_filter = 'completed'
          AND pi.status IN ('COMPLETED','PAID'))
      OR (p_filter = 'failed'
          AND pi.status IN ('FAILED','DECLINED','RELEASED','CANCELLED'))
    )
  ORDER BY pi.created_at DESC
  LIMIT 50;
END;
$$;

-- Strict grant: authenticated may call; anon and PUBLIC cannot.
REVOKE ALL ON FUNCTION public.get_driver_own_withdrawals(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_own_withdrawals(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_driver_own_withdrawals(text) TO authenticated;

-- ── 3. RPC: single withdrawal detail ─────────────────────────────────────
-- Ownership enforced inside by v_driver_id comparison.
-- EARLY_CASHOUT check is hardcoded — no other batch kind is returned.
-- Exposes only safe UI + financial-evidence fields.
-- No provider secrets (provider_payment_id is an opaque reference, safe for
-- internal reconciliation display — not exposed to app UI today but present
-- for future status pages; can be removed if unwanted).

CREATE OR REPLACE FUNCTION public.get_driver_own_withdrawal(
  p_withdrawal_id uuid
)
RETURNS TABLE (
  id                      uuid,
  status                  text,
  amount_pence            integer,
  net_driver_payout_pence bigint,
  onecab_fee_pence        bigint,
  created_at              timestamptz,
  completed_at            timestamptz,
  failed_at               timestamptz,
  failure_reason          text,
  failure_code            text,
  error_message           text,
  batch_kind              text,
  financially_applied_at  timestamptz,
  provider_state          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  -- Derive driver identity from JWT.
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    pi.id,
    pi.status::text,
    pi.amount_pence,
    pi.net_driver_payout_pence,
    pi.onecab_fee_pence,
    pi.created_at,
    pi.completed_at,
    pi.failed_at,
    pi.failure_reason::text,
    pi.failure_code::text,
    pi.error_message::text,
    pb.kind::text                   AS batch_kind,
    dppi.financially_applied_at,
    dppi.provider_state::text
  FROM public.payout_items           pi
  JOIN public.payout_batches         pb   ON pb.id   = pi.batch_id
  LEFT JOIN public.driver_payout_payment_intents dppi
                                          ON dppi.payout_item_id = pi.id
  WHERE pi.id        = p_withdrawal_id
    AND pi.driver_id = v_driver_id
    -- Hardcoded: non-EARLY_CASHOUT items are invisible to the driver UI.
    AND pb.kind      = 'EARLY_CASHOUT'
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_driver_own_withdrawal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_own_withdrawal(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_driver_own_withdrawal(uuid) TO authenticated;

-- ── 4. Verify ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_items_old_policy   int;
  v_batches_old_policy int;
  v_fn_list            int;
  v_fn_detail          int;
BEGIN
  -- Old recursive policies must be gone
  SELECT COUNT(*) INTO v_items_old_policy
  FROM pg_policies
  WHERE tablename  = 'payout_items'
    AND policyname = 'Drivers read own early cashout payout items';

  SELECT COUNT(*) INTO v_batches_old_policy
  FROM pg_policies
  WHERE tablename  = 'payout_batches'
    AND policyname = 'Drivers read own early cashout payout batches';

  -- New RPCs must exist
  SELECT COUNT(*) INTO v_fn_list
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'get_driver_own_withdrawals';

  SELECT COUNT(*) INTO v_fn_detail
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'get_driver_own_withdrawal';

  IF v_items_old_policy  > 0 THEN RAISE EXCEPTION 'recursive payout_items policy still present'; END IF;
  IF v_batches_old_policy > 0 THEN RAISE EXCEPTION 'recursive payout_batches policy still present'; END IF;
  IF v_fn_list   = 0 THEN RAISE EXCEPTION 'get_driver_own_withdrawals RPC missing'; END IF;
  IF v_fn_detail = 0 THEN RAISE EXCEPTION 'get_driver_own_withdrawal RPC missing'; END IF;

  RAISE NOTICE 'Migration 20260930140000: RLS recursion fix verified OK';
END;
$$;
