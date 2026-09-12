-- ============================================================
-- Revoke PUBLIC/anon EXECUTE on the two remaining
-- anon-executable SECURITY DEFINER corporate-trip RPCs.
--
--   public.activate_paid_corporate_trip(uuid)
--   public.discard_unpaid_corporate_trip(uuid)
--
-- Grants/revokes only. Does not change function bodies, owners,
-- SECURITY DEFINER, volatility, or search_path.
-- Keeps authenticated and service_role EXECUTE.
-- Does not invoke either RPC.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.activate_paid_corporate_trip(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_paid_corporate_trip(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.activate_paid_corporate_trip(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_paid_corporate_trip(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.discard_unpaid_corporate_trip(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.discard_unpaid_corporate_trip(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.discard_unpaid_corporate_trip(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.discard_unpaid_corporate_trip(uuid) TO service_role;

COMMIT;
