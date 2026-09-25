-- Rollback for 20261201130000_certification_non_payable_repair_execute_lock.sql
--
-- NEVER restore anon / authenticated / PUBLIC EXECUTE on this SECURITY DEFINER RPC.
-- Safe outcome: leave service_role-only permissions unchanged.
-- This rollback is intentionally a no-op privilege change.

BEGIN;

-- Documented no-op: leave the hardened ACL in place.
-- Must never re-open EXECUTE for anon, authenticated, or PUBLIC on this RPC.
-- service_role EXECUTE (if present) remains the production posture.

DO $$
BEGIN
  RAISE NOTICE
    'rollback_20261201130000: leaving admin_apply_certification_non_payable_repair ACL hardened (service_role only); refusing insecure grant restoration';
END $$;

COMMIT;
