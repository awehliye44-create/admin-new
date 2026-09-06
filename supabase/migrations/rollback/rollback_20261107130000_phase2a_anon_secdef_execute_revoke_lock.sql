-- ============================================================
-- EMERGENCY ROLLBACK for 20261107130000_phase2a_anon_secdef_execute_revoke_lock.sql
--
-- Restores the pre-Phase-2A EXECUTE grants captured 2026-09-06:
--
-- campaign_heads_up_due_sweep():
--   ACL {=X/postgres, postgres=X/postgres, anon=X/postgres,
--        authenticated=X/postgres, service_role=X/postgres}
--
-- check_identity_exists(text, text):
--   ACL {postgres=X/postgres, authenticated=X/postgres,
--        service_role=X/postgres, anon=X/postgres}
--   (PUBLIC already had no EXECUTE)
--
-- WARNING: Reintroduces anon/authenticated EXECUTE on both
-- SECURITY DEFINER functions (campaign HTTP enqueue + identity
-- enumeration). Prefer a new forward fix over lasting rollback.
--
-- Does NOT remove the forward migration from schema_migrations.
-- Does NOT modify function bodies or cron schedules.
-- ============================================================

BEGIN;

-- Restore campaign sweep client grants (including PUBLIC).
GRANT EXECUTE ON FUNCTION public.campaign_heads_up_due_sweep() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.campaign_heads_up_due_sweep() TO anon;
GRANT EXECUTE ON FUNCTION public.campaign_heads_up_due_sweep() TO authenticated;
GRANT EXECUTE ON FUNCTION public.campaign_heads_up_due_sweep() TO service_role;

-- Restore identity-check client grants (no PUBLIC grant historically).
REVOKE ALL ON FUNCTION public.check_identity_exists(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text, text) TO service_role;

COMMIT;
