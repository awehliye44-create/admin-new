-- ============================================================
-- Phase A8B15: ACL-lock ten authenticated SECURITY DEFINER
-- driver trip / identity helpers (orphan + postgres-internal).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, or search_path change.
--
-- ORPHANED (revoke PUBLIC/anon/authenticated/service_role; postgres retains):
--   is_customer(uuid)
--   get_marketplace_delivery_config(uuid)
--   resolve_driver_tier_category_priority(uuid, uuid)
--     No live SQL/app/Edge/RLS/cron caller in production catalog
--
-- POSTGRES_INTERNAL_ONLY (revoke PUBLIC/anon/authenticated/service_role;
--                         validate_* had no service_role at baseline):
--   driver_lost_property_public_trip_ref(uuid)
--     ← get/list_driver_own_lost_property_*
--   driver_is_assigned_to_live_trip(uuid, uuid)
--     ← submit_driver_location_sample (nested owner EXECUTE)
--   driver_is_excluded_from_trip(uuid, uuid)
--     ← accept_ride_offer / accept_stacked_ride / accept_scheduled_ride
--   driver_location_state_for_driver(uuid)
--     ← driver_location_is_frozen
--   driver_location_is_frozen(uuid)
--     ← find_nearby_drivers (nested owner EXECUTE)
--   resolve_driver_tier_name(uuid)
--     ← auto_promote_driver_tier (SECDEF trigger) /
--       resolve_driver_tier_category_priority
--   validate_driver_signup_region_service_areas(uuid, uuid[])
--     ← finalize_driver_onboarding_registration /
--       enforce_driver_signup_region_on_insert (SECDEF trigger)
--     Baseline ACL: authenticated only (no service_role)
--
-- Explicitly excluded / HARD_STOP this phase:
--   is_driver — rematch trigger enforce_driver_cancel_rematch_invariants
--     is NOT SECURITY DEFINER (session-user EXECUTE required)
--   RLS: can_corporate_user_view_driver, driver_can_view_trip_via_offer
--   Mounted JWT: go online/offline, heartbeat, document eligibility,
--     passenger/nearby map RPCs, corporate suspend/reactivate
--   get_trip_passenger_details (Edge user JWT)
--   search_places (Edge may fall back to anon key)
--   resolve_zone_surge / search_onecab_location_landmarks (defer Edge batch)
--   finance / payout / wallet / CW / Revolut / fare rebroadcast
--   notification/Vault bridge; submit_driver_location_sample itself;
--   force_driver_offline / A8B13D path; A8B1–A8B14 handled signatures
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 129 → 119 (−10)
--   anon remains 0; mutable search_path remains 0
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   is_customer: bb3ce42cef400bf24a5902a852835ad7
--   get_marketplace_delivery_config: dffe70e9cae0e5d209f6c7998d2d8c17
--   resolve_driver_tier_category_priority: 88945cc13b8a131bf0b7d2e391391451
--   driver_lost_property_public_trip_ref: ee2f5aba2ee667bbe6b6015c51d01944
--   driver_is_assigned_to_live_trip: 056d2586ffe57a4bff7f640e6808b0d4
--   driver_is_excluded_from_trip: e63b62a3e89a896acdba8c9d29a35401
--   driver_location_state_for_driver: 2069d2642c7fdee1523d5ca8f502ee5f
--   driver_location_is_frozen: b5a397b63aace864e12b3dafdee8a235
--   resolve_driver_tier_name: 56843aff56039152dd0bc0a935308e65
--   validate_driver_signup_region_service_areas: f936067e153997b545795321741aee24

-- ORPHANED
REVOKE ALL ON FUNCTION public.is_customer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_customer(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_customer(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_customer(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_marketplace_delivery_config(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_marketplace_delivery_config(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_marketplace_delivery_config(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_marketplace_delivery_config(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) FROM service_role;

-- POSTGRES_INTERNAL_ONLY
REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_location_state_for_driver(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_location_state_for_driver(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_location_state_for_driver(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_location_state_for_driver(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_location_is_frozen(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_location_is_frozen(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_location_is_frozen(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_location_is_frozen(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_driver_tier_name(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_name(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_name(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_name(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM service_role;

COMMIT;
