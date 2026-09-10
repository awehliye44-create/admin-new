-- EMERGENCY ROLLBACK for 20261109220000_phase_a8b10_finance_assert_and_internal_execute_lock.sql
-- Restores the proven pre-change grants: authenticated + service_role EXECUTE.
-- Does not grant PUBLIC or anon. Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.assert_finance_payout_ledger_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_finance_payout_ledger_access() TO service_role;

GRANT EXECUTE ON FUNCTION public.assert_driver_wallet_read_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_driver_wallet_read_access(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_dispatch_settings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dispatch_settings(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.towards_destination_clear_filter(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_clear_filter(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.towards_destination_resolve_config(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_resolve_config(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) TO service_role;

GRANT EXECUTE ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) TO service_role;

GRANT EXECUTE ON FUNCTION public.allow_driver_availability_write() TO authenticated;
GRANT EXECUTE ON FUNCTION public.allow_driver_availability_write() TO service_role;

COMMIT;
