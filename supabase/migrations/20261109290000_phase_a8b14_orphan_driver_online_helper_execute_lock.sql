-- ============================================================
-- Phase A8B14: ACL-lock ten authenticated SECURITY DEFINER
-- driver online / dispatch helpers (orphan + postgres-internal).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, or search_path change.
--
-- ORPHANED (revoke PUBLIC/anon/authenticated/service_role; postgres retains):
--   driver_availability_ssot(...)
--   driver_effective_online_snapshot(...)
--   driver_effective_online_reason(...)
--   driver_freshness_reason(...)
--   driver_presence_last_signal_at(uuid)
--   can_modify_trip(uuid)
--   ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer)
--   towards_destination_business_date(uuid)
--
-- POSTGRES_INTERNAL_ONLY (revoke PUBLIC/anon/authenticated/service_role):
--   get_driver_identity_verification_gate(uuid)
--     ← assert_driver_presence_online_eligible ← driver_request_go_online /
--       upsert_driver_presence / sync_driver_online_from_presence /
--       expire_stale_drivers
--   driver_has_accepted_active_or_stacked_work(uuid)
--     ← get_driver_identity_verification_gate
--
-- Explicitly excluded / HARD_STOP this phase:
--   submit_driver_location_sample + A8B13D logout/session path
--   driver_request_go_online / go_offline / driver_heartbeat_ping
--   get_trip_passenger_details (Edge user JWT + anon key)
--   find_nearby_drivers / passenger_map_nearby_drivers (mounted JWT)
--   RLS helpers (can_corporate_user_view_driver, driver_can_view_trip_via_offer)
--   financial / payout / wallet / Revolut / commission helpers
--   A8B5B2 notification/Vault bridge
--   resolve_negotiation_rebroadcast_fare (fare-path; defer)
--   is_driver (broad parent graph; defer separate batch)
--   A8B1–A8B13 already-handled signatures
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 139 → 129 (−10)
--   anon remains 0; mutable search_path remains 0
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   driver_availability_ssot: 7bfe41126b0943932203b98a8ca33aef
--   driver_effective_online_snapshot: e0f1e77a452032084f1b5b046caa691e
--   driver_effective_online_reason: 8a1f85a7c4833370c347c29652401eca
--   driver_freshness_reason: 8bdcebf9809811c590876348e5cd9385
--   driver_presence_last_signal_at: 243b942b35903ee3f34310cdac5a694d
--   can_modify_trip: 577acc1711d11bde0b283d00f0e8139e
--   ride_offer_is_on_voluntary_decline_cooldown: 7c7f3bb7c19607c82e5fc3e02f7c09a1
--   towards_destination_business_date: eab15f0bc302a8afb9bea42b1042b3b8
--   get_driver_identity_verification_gate: 29403d5d03dda8acb8b38c6324ee0cb5
--   driver_has_accepted_active_or_stacked_work: 736feddece8d9987ce177d8102e04297

-- ORPHANED
REVOKE ALL ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_presence_last_signal_at(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_presence_last_signal_at(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_presence_last_signal_at(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_presence_last_signal_at(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.can_modify_trip(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_modify_trip(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.can_modify_trip(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.can_modify_trip(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_business_date(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_business_date(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_business_date(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_business_date(uuid) FROM service_role;

-- POSTGRES_INTERNAL_ONLY
REVOKE ALL ON FUNCTION public.get_driver_identity_verification_gate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_identity_verification_gate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_identity_verification_gate(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_identity_verification_gate(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) FROM service_role;

COMMIT;
