-- Restores the pre-lock grants observed 2026-09-12:
-- PUBLIC, anon, authenticated, and service_role EXECUTE.
-- Does not change function bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.activate_paid_corporate_trip(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.activate_paid_corporate_trip(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.activate_paid_corporate_trip(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_paid_corporate_trip(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.discard_unpaid_corporate_trip(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.discard_unpaid_corporate_trip(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.discard_unpaid_corporate_trip(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.discard_unpaid_corporate_trip(uuid) TO service_role;

COMMIT;
