-- ============================================================
-- Phase A8B10: ACL-lock ten high-impact authenticated SECURITY
-- DEFINER helpers (finance assert / edge / postgres-internal).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, or search_path change.
--
-- EDGE_SERVICE_ONLY (revoke PUBLIC/anon/authenticated; retain service_role):
--   passenger_has_live_immediate_trip(uuid, uuid)
--     Edge create-trip-after-payment service_role + finalize_paid_booking_session
--
-- POSTGRES_INTERNAL_ONLY (revoke PUBLIC/anon/authenticated/service_role):
--   assert_finance_payout_ledger_access()
--     ← ops_retry_failed_payout(_item) / return_failed_payout_to_wallet
--   assert_driver_wallet_read_access(uuid)
--     ← driver_wallet_eligibility_balances / get_driver_wallet_balance
--   get_dispatch_settings(uuid)
--     ← dispatch_trip_offers / rematch / maybe_advance_dispatch
--   towards_destination_clear_filter(uuid)
--   towards_destination_resolve_config(uuid)
--   towards_destination_usage_snapshot(uuid, integer)
--     ← driver own TD SECDEF + complete/maybe_complete (A8B9)
--   is_stale_unverified_email_identity(uuid, text, text, timestamptz)
--   is_stale_unverified_phone_identity(uuid, text, text, timestamptz)
--     ← cleanup_stale_auth_identities (service_role / postgres)
--   allow_driver_availability_write()
--     ← go_online/offline / presence / driver privileged triggers
--
-- Explicitly deferred / HARD_STOP this phase (not ACL-revoked):
--   ops_retry_failed_payout_item / return_failed_payout_to_wallet
--     AUTHENTICATED_REQUIRED — Admin Payout Ledger staff JWT + body gate
--   admin/driver wallet eligibility balances — Admin JWT mounted
--   suspend_corporate_request — NEEDS_BODY_AUTHORIZATION
--   resolve_*_commission_percent / trip_row_is_commission_wallet_*
--     / is_commission_wallet_reserve_enabled — financial-model helpers
--   submit_driver_location_sample, ride_offer_enqueue_reminders
--   has_role / is_super_admin / is_owner / has_corporate_access / can_write_corporate
--   admin_user_directory, A8B5B2 Vault/notification/SDN path
--   A8B1–A8B9 already-handled signatures
--   six RLS-no-policy INFO findings
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 158 → 148 (−10)
--   anon remains 0; mutable search_path remains 0; categories remain 2
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   assert_finance_payout_ledger_access: 26cf156f56679cf1696d8e27d2b8388c
--   assert_driver_wallet_read_access: e4a182e8066992d28944fe0c2b77fdd2
--   get_dispatch_settings: 45cee720edbaa6fd2334ef5d07156f53
--   passenger_has_live_immediate_trip: ba91369a8113dc3823068fa6c2cae19c
--   towards_destination_clear_filter: 4ca656d9d56dc489056b54cc7cefc076
--   towards_destination_resolve_config: 462b6121fc4620edff5c080b8e153157
--   towards_destination_usage_snapshot: c34c02a83f628d8d739e069ab53e38de
--   is_stale_unverified_email_identity: e918d61901008464d3c6745f4f4b5da2
--   is_stale_unverified_phone_identity: fde8c6025008fdfb610915305e8e24a1
--   allow_driver_availability_write: 88b3c50ace6ae03ec5deacf09c9dbc88

-- EDGE_SERVICE_ONLY
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) TO service_role;

-- POSTGRES_INTERNAL_ONLY
REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM anon;
REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM service_role;

REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_dispatch_settings(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dispatch_settings(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_dispatch_settings(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_dispatch_settings(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_clear_filter(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_clear_filter(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_clear_filter(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_clear_filter(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_resolve_config(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_resolve_config(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_resolve_config(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_resolve_config(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) FROM service_role;

REVOKE ALL ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) FROM service_role;

REVOKE ALL ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) FROM service_role;

REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM anon;
REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM authenticated;
REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM service_role;

COMMIT;
