-- ============================================================
-- Phase 2A: revoke client EXECUTE on two SECURITY DEFINER RPCs
--
-- 1) public.campaign_heads_up_due_sweep()
--    Cron-only (pg_cron job "campaign-heads-up-due-sweep" runs
--    as username=postgres). PUBLIC/anon/authenticated/service_role
--    EXECUTE is unnecessary and lets API roles enqueue Edge work.
--
-- 2) public.check_identity_exists(text, text)
--    Sole verified caller: Edge create-onboarding-auth-user via
--    service_role client (not caller JWT). Direct anon/authenticated
--    EXECUTE enables phone/email existence enumeration.
--
-- Does NOT modify function bodies, cron schedules, Edge Functions,
-- RLS, or grants on any other objects.
-- ============================================================

BEGIN;

-- ---- campaign_heads_up_due_sweep() ----
-- Strip PUBLIC first so anon cannot regain EXECUTE via PUBLIC.
REVOKE ALL ON FUNCTION public.campaign_heads_up_due_sweep() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.campaign_heads_up_due_sweep() FROM anon;
REVOKE ALL ON FUNCTION public.campaign_heads_up_due_sweep() FROM authenticated;
REVOKE ALL ON FUNCTION public.campaign_heads_up_due_sweep() FROM service_role;
-- Owner postgres retains EXECUTE for pg_cron (job username=postgres).

-- ---- check_identity_exists(text, text) ----
REVOKE ALL ON FUNCTION public.check_identity_exists(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_identity_exists(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.check_identity_exists(text, text) FROM authenticated;
-- Keep / re-assert service_role only (Edge create-onboarding-auth-user).
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text, text) TO service_role;

COMMIT;
