-- ============================================================
-- Phase A8B9: ACL-lock ten high-impact authenticated SECURITY
-- DEFINER helpers (orphan / edge / postgres-internal).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, or search_path change.
--
-- EDGE_SERVICE_ONLY (revoke PUBLIC/anon/authenticated; retain service_role):
--   get_active_stop_waiting(uuid)
--     Edge stop-waiting restore via SUPABASE_SERVICE_ROLE_KEY only
--
-- ORPHANED (revoke PUBLIC/anon/authenticated/service_role; postgres retains):
--   is_user_suspended(uuid, text)
--   driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb)
--     Live path is Edge driver-cancel-before-pickup (inline), not this RPC
--   is_driver_dispatchable(uuid, integer, boolean, integer)
--     No live SQL parent/trigger/cron/Edge/app caller after A8B8
--
-- POSTGRES_INTERNAL_ONLY (revoke PUBLIC/anon/authenticated/service_role):
--   get_customer_trip_stats(uuid)                 ← get_driver_active_trip_snapshot
--   get_corporate_allowed_payment_methods(uuid)   ← enforce_corporate_payment_methods_trg
--   staff_role_of(uuid)                           ← admin_set_role_page_permission / log_roles_audit
--   towards_destination_complete_session(uuid, text)
--     ← clear/get/set_driver_own_towards_destination + maybe_complete
--   towards_destination_maybe_complete_on_location(uuid, double precision, double precision)
--     ← update_driver_location + trg_td_arrival_on_presence
--   compute_ride_offer_preset_options(trips)
--     ← commit_dispatch_wave / enrich_ride_offer_presets / tr_stamp_offer_presets
--
-- Explicitly excluded / HARD_STOP this phase:
--   Admin JWT payout/wallet RPCs and eligibility balances
--   resolve_*_commission_percent / trip_row_is_commission_wallet_driver_collected
--   suspend_corporate_request (NEEDS_BODY_AUTHORIZATION)
--   accept/decline_scheduled_ride, ack_offer_delivery (AUTHENTICATED_REQUIRED)
--   submit_driver_location_sample, ride_offer_enqueue_reminders
--   has_role / is_super_admin / is_owner / has_corporate_access / can_write_corporate
--   admin_user_directory, A8B5B2 Vault/notification/SDN path
--   A8B1–A8B8 already-handled signatures
--   six RLS-no-policy INFO findings
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 168 → 158 (−10)
--   anon remains 0; mutable search_path remains 0; categories remain 2
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   get_active_stop_waiting: 87aa0b8077e50dff3cd06bf45ce91064
--   get_customer_trip_stats: 0976e9196ab839f91486ffc496c98e8c
--   get_corporate_allowed_payment_methods: 17b072d26ef25e2f4f5c5fa1796d1d0b
--   staff_role_of: 1ce27f25a629a33d3861aae4d01e4069
--   is_user_suspended: b745a603b49b1e01a7ff6c023dacd9f3
--   driver_cancel_before_start_rematch: 803c5f52b03778f66091fc7a5c0b2dc7
--   towards_destination_complete_session: 5156dfbd5d13b99376b72682033399d5
--   towards_destination_maybe_complete_on_location: 1ebacf4776a4d4164b43f2f09e0a171f
--   is_driver_dispatchable: f876b9596bf0e0fcefbe9845f92cb2e6
--   compute_ride_offer_preset_options: 95339b4696f8bb67d3a9f9b6eb44f239

-- EDGE_SERVICE_ONLY
REVOKE ALL ON FUNCTION public.get_active_stop_waiting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_active_stop_waiting(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_active_stop_waiting(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_stop_waiting(uuid) TO service_role;

-- ORPHANED
REVOKE ALL ON FUNCTION public.is_user_suspended(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_user_suspended(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.is_user_suspended(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_user_suspended(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) FROM service_role;

-- POSTGRES_INTERNAL_ONLY
REVOKE ALL ON FUNCTION public.get_customer_trip_stats(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_trip_stats(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_trip_stats(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_customer_trip_stats(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.staff_role_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_role_of(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.staff_role_of(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.staff_role_of(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_complete_session(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_complete_session(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_complete_session(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_complete_session(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) FROM service_role;

REVOKE ALL ON FUNCTION public.compute_ride_offer_preset_options(trips) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_ride_offer_preset_options(trips) FROM anon;
REVOKE ALL ON FUNCTION public.compute_ride_offer_preset_options(trips) FROM authenticated;
REVOKE ALL ON FUNCTION public.compute_ride_offer_preset_options(trips) FROM service_role;

COMMIT;
