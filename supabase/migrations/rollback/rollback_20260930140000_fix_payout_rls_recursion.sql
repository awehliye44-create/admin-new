-- ============================================================
-- ROLLBACK for 20260930140000_fix_payout_rls_recursion.sql
-- Restores the exact pre-migration policies (recursive but
-- matching the original production schema audited 2026-08-19).
-- Run this to undo the migration without touching financial data.
-- Note: does NOT delete from schema_migrations (Supabase tracks
-- applied migrations; manual removal could corrupt migration state).
-- ============================================================

-- 1. Drop the two new SECURITY DEFINER RPCs
DROP FUNCTION IF EXISTS public.get_driver_own_withdrawals(text);
DROP FUNCTION IF EXISTS public.get_driver_own_withdrawal(uuid);

-- 2. Drop any non-recursive replacement table policies (if they were
--    created by an earlier version of this migration)
DROP POLICY IF EXISTS "Drivers read own payout items"
  ON public.payout_items;

-- 3. Restore original recursive policies (exact text from pg_policies audit)

CREATE POLICY "Drivers read own early cashout payout items"
  ON public.payout_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM (public.drivers d
            JOIN public.payout_batches b ON b.id = payout_items.batch_id)
      WHERE d.id        = payout_items.driver_id
        AND d.user_id   = auth.uid()
        AND b.kind      = 'EARLY_CASHOUT'
    )
  );

CREATE POLICY "Drivers read own early cashout payout batches"
  ON public.payout_batches
  FOR SELECT
  TO authenticated
  USING (
    kind = 'EARLY_CASHOUT'
    AND EXISTS (
      SELECT 1
      FROM (public.payout_items i
            JOIN public.drivers  d ON d.id = i.driver_id)
      WHERE i.batch_id    = payout_batches.id
        AND d.user_id     = auth.uid()
    )
  );
